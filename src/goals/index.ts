/**
 * Goal-mode session manager + autonomous-continuation driver.
 *
 * Holds the live per-session `GoalRuntime` + `GoalModeState` (keyed by session
 * id), wires the runtime host to ncode primitives (cumulative token counters,
 * sidecar JSON persistence), injects the per-turn `<goal_context>`, and drives
 * the auto-continuation loop via the message queue when the agent goes idle.
 *
 * Persistence approach (faithful-port note): oh-my-pi persists goal lifecycle
 * as session-transcript entries. ncode here uses a self-contained sidecar JSON
 * snapshot at `~/.ncode/goals/<sessionId>.json` (last-wins), restored lazily
 * when a session's runtime is first created. This survives restart/resume
 * without threading goal state through the deep LogOption/Project metadata
 * cache. See report for the rationale.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  getSessionId,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalInputTokens,
  getTotalOutputTokens,
} from '../bootstrap/state.js'
import { getNcodeConfigHomeDir } from '../utils/envUtils.js'
import { enqueue } from '../utils/messageQueueManager.js'
import {
  completionBudgetReport,
  remainingTokens,
  renderGoalPrompt,
} from './prompts.js'
import { GoalRuntime, type GoalRuntimeHost } from './runtime.js'
import type { Goal, GoalModeState, GoalTokenUsage } from './state.js'

export type {
  Goal,
  GoalModeState,
  GoalStatus,
  GoalToolDetails,
  GoalTokenUsage,
} from './state.js'
export { GoalRuntime } from './runtime.js'
export { completionBudgetReport, remainingTokens } from './prompts.js'

// === Live per-session state =================================================

const goalStates = new Map<string, GoalModeState | undefined>()
const goalRuntimes = new Map<string, GoalRuntime>()

function getCurrentUsage(): GoalTokenUsage {
  return {
    input: getTotalInputTokens(),
    output: getTotalOutputTokens(),
    cacheRead: getTotalCacheReadInputTokens(),
    cacheWrite: getTotalCacheCreationInputTokens(),
  }
}

function makeHost(sessionId: string): GoalRuntimeHost {
  return {
    getState: () => goalStates.get(sessionId),
    setState: state => {
      if (state) goalStates.set(sessionId, state)
      else goalStates.delete(sessionId)
    },
    getCurrentUsage,
    persist: state => persistGoalState(sessionId, state),
  }
}

/**
 * Returns the session's GoalRuntime, creating it (and restoring any persisted
 * goal) on first access.
 */
export function getGoalRuntime(
  sessionId: string = getSessionId(),
): GoalRuntime {
  let runtime = goalRuntimes.get(sessionId)
  if (!runtime) {
    restoreGoalState(sessionId)
    runtime = new GoalRuntime(makeHost(sessionId))
    goalRuntimes.set(sessionId, runtime)
  }
  return runtime
}

export function getGoalModeState(
  sessionId: string = getSessionId(),
): GoalModeState | undefined {
  // Ensure restore-on-first-access has run.
  getGoalRuntime(sessionId)
  return goalStates.get(sessionId)
}

/** True while the goal loop is running (enabled + active). */
export function isGoalModeActive(sessionId: string = getSessionId()): boolean {
  const state = getGoalModeState(sessionId)
  return Boolean(state?.enabled && state.goal.status === 'active')
}

/**
 * True whenever a non-terminal goal exists, so the `goal` tool stays available
 * for get/resume/complete/drop even while paused or budget-limited.
 */
export function isGoalToolAvailable(
  sessionId: string = getSessionId(),
): boolean {
  const state = getGoalModeState(sessionId)
  return Boolean(
    state?.goal &&
      state.goal.status !== 'dropped' &&
      state.goal.status !== 'complete',
  )
}

/** Per-turn `<goal_context>` content (only while the goal is active). */
export function buildActiveGoalPrompt(
  sessionId: string = getSessionId(),
): string | undefined {
  return getGoalRuntime(sessionId).buildActivePrompt()
}

// === Autonomous continuation driver =========================================

/**
 * Called when the main agent finishes a turn and goes idle (from the REPL idle
 * effect). Reconciles token/time usage into the active goal, then enqueues the
 * next autonomous step:
 * - a budget-limit steer (once) if the goal just hit its budget, or
 * - a continuation prompt while the goal remains active.
 *
 * The enqueued message is hidden (isMeta) and low-priority, so it never starves
 * real user input. The queue processor drains it on the idle tick, starting the
 * next turn — that turn ends, this runs again: the autonomous loop.
 */
export function onGoalTurnEnd(sessionId: string = getSessionId()): void {
  const runtime = goalRuntimes.get(sessionId)
  if (!runtime) return
  const before = goalStates.get(sessionId)
  if (
    !before?.enabled ||
    (before.goal.status !== 'active' && before.goal.status !== 'budget-limited')
  ) {
    return
  }

  runtime.flushUsage()

  const state = goalStates.get(sessionId)
  if (!state?.enabled) return

  if (state.goal.status === 'budget-limited') {
    if (runtime.shouldSteerBudget(state.goal)) {
      const prompt = runtime.buildBudgetLimitPrompt()
      if (prompt) {
        runtime.markBudgetSteered(state.goal)
        enqueueGoalPrompt(prompt)
      }
    }
    return
  }

  if (state.goal.status === 'active') {
    const prompt = runtime.buildContinuationPrompt()
    if (prompt) enqueueGoalPrompt(prompt)
  }
}

function enqueueGoalPrompt(value: string): void {
  enqueue({ value, mode: 'prompt', priority: 'later', isMeta: true })
}

// === Display helpers (for /goal show etc.) ==================================

export function formatGoalStatus(goal: Goal): string {
  const lines = [`Goal: ${goal.objective}`, `Status: ${goal.status}`]
  if (goal.tokenBudget !== undefined) {
    const remaining = remainingTokens(goal)
    lines.push(
      `Tokens: ${goal.tokensUsed} / ${goal.tokenBudget} used (${remaining ?? 0} remaining)`,
    )
  } else {
    lines.push(`Tokens: ${goal.tokensUsed} used`)
  }
  if (goal.timeUsedSeconds > 0) {
    lines.push(`Time: ${goal.timeUsedSeconds}s`)
  }
  const report =
    goal.status === 'complete' ? completionBudgetReport(goal) : null
  if (report) lines.push('', report)
  return lines.join('\n')
}

export { renderGoalPrompt }

// === Persistence (sidecar JSON) =============================================

function goalsDir(): string {
  return join(getNcodeConfigHomeDir(), 'goals')
}

function goalStatePath(sessionId: string): string {
  return join(goalsDir(), `${sessionId}.json`)
}

function persistGoalState(
  sessionId: string,
  state: GoalModeState | undefined,
): void {
  try {
    const path = goalStatePath(sessionId)
    if (!state || state.goal.status === 'dropped') {
      if (existsSync(path)) rmSync(path, { force: true })
      return
    }
    mkdirSync(goalsDir(), { recursive: true })
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 })
  } catch {
    // Persistence is best-effort; never break a turn over a sidecar write.
  }
}

function restoreGoalState(sessionId: string): void {
  if (goalStates.has(sessionId)) return
  try {
    const path = goalStatePath(sessionId)
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as GoalModeState
    if (parsed?.goal && typeof parsed.goal.objective === 'string') {
      // A goal that was active when the process exited is treated as paused on
      // restore (mirrors oh-my-pi's onThreadResumed: no silent autonomous
      // resumption — the user re-activates via /goal resume).
      if (parsed.enabled && parsed.goal.status === 'active') {
        parsed.enabled = false
        parsed.goal.status = 'paused'
      }
      goalStates.set(sessionId, parsed)
    }
  } catch {
    // Ignore corrupt sidecar state.
  }
}
