/**
 * Autoresearch mode session manager + autonomous-continuation driver.
 *
 * Mirrors `src/goals/index.ts`: a per-session runtime (keyed by `getSessionId()`),
 * a sidecar-JSON control snapshot under `~/.ncode/autoresearch/control/<sessionId>.json`,
 * the per-turn `<autoresearch_context>` injector (Phase 1 setup prompt before a
 * session exists, Phase 2 iteration prompt after), and the `onAutoresearchTurnEnd`
 * auto-resume driver that re-enters the loop via the message queue when the agent
 * goes idle.
 *
 * Faithful-port notes vs oh-my-pi `autoresearch/index.ts`:
 * - oh-my-pi reconstructs mode from session-transcript `autoresearch-control`
 *   entries and (de)registers the experiment tools imperatively. ncode persists
 *   mode in a per-session sidecar and gates the tools via their `isEnabled()`
 *   reading `runtime.autoresearchMode`, so no explicit tool (de)registration.
 * - The dashboard (TUI widget + overlay + ctrl+x shortcuts) is NOT ported — it is
 *   pure presentation with no behavioral value (see report).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getSessionId } from '../bootstrap/state.js'
import { getCwd } from '../utils/cwd.js'
import { getNcodeConfigHomeDir } from '../utils/envUtils.js'
import { hasCommandsInQueue, enqueue } from '../utils/messageQueueManager.js'
import {
  clean,
  currentBranch,
  ensureAutoresearchBranch,
  resetHard,
} from './git.js'
import { formatNum } from './helpers.js'
import {
  renderCommandResume,
  renderIterationPrompt,
  renderResumeMessage,
  renderSetupPrompt,
} from './prompts.js'
import {
  buildExperimentState,
  currentResults,
  findBaselineMetric,
  findBaselineRunNumber,
  findBestKeptMetric,
} from './state.js'
import {
  openAutoresearchStore,
  openAutoresearchStoreIfExists,
  type RunRow,
  type SessionRow,
} from './storage.js'
import type {
  AutoresearchControlState,
  AutoresearchRuntime,
  ExperimentResult,
  ExperimentState,
  PendingRunSummary,
} from './types.js'

export { openAutoresearchStore, openAutoresearchStoreIfExists } from './storage.js'
export type { AutoresearchRuntime } from './types.js'

// === Live per-session runtime ===============================================

const runtimes = new Map<string, AutoresearchRuntime>()

function createRuntime(): AutoresearchRuntime {
  return {
    desiredMode: false,
    autoresearchMode: false,
    autoResumeArmed: false,
    lastAutoResumePendingRunNumber: null,
    goal: null,
    branch: null,
  }
}

export function getAutoresearchRuntime(
  sessionId: string = getSessionId(),
): AutoresearchRuntime {
  let runtime = runtimes.get(sessionId)
  if (!runtime) {
    runtime = createRuntime()
    runtimes.set(sessionId, runtime)
    restoreControlState(sessionId, runtime)
  }
  return runtime
}

/** True while autoresearch mode is effective (desired AND on the active branch). */
export function isAutoresearchModeActive(
  sessionId: string = getSessionId(),
): boolean {
  return getAutoresearchRuntime(sessionId).autoresearchMode
}

/** Gate for the experiment tools' `isEnabled()`. */
export function isAutoresearchToolAvailable(
  sessionId: string = getSessionId(),
): boolean {
  return getAutoresearchRuntime(sessionId).autoresearchMode
}

/** Re-arm the auto-resume loop (called by the experiment tools). */
export function markAutoResumeArmed(sessionId: string = getSessionId()): void {
  getAutoresearchRuntime(sessionId).autoResumeArmed = true
  getAutoresearchRuntime(sessionId).lastAutoResumePendingRunNumber = null
}

/**
 * Called by init_experiment once a session exists: mode is on, the loop is armed,
 * and the goal/branch are persisted so a restart can resume on the same branch.
 */
export function onExperimentInitialized(
  goal: string | null,
  branch: string | null,
  sessionId: string = getSessionId(),
): void {
  const runtime = getAutoresearchRuntime(sessionId)
  runtime.desiredMode = true
  runtime.autoresearchMode = true
  runtime.autoResumeArmed = true
  runtime.lastAutoResumePendingRunNumber = null
  runtime.goal = goal
  runtime.branch = branch
  persistControlState(sessionId, runtime)
}

/** Turn mode off (used by log_experiment when the per-segment cap is reached). */
export function disableAutoresearchMode(
  sessionId: string = getSessionId(),
): void {
  const runtime = getAutoresearchRuntime(sessionId)
  runtime.desiredMode = false
  runtime.autoresearchMode = false
  runtime.autoResumeArmed = false
  persistControlState(sessionId, runtime)
}

// === Per-turn `<autoresearch_context>` ======================================

/**
 * Build the per-turn autoresearch context (Phase 1 setup prompt before a session
 * exists, Phase 2 iteration prompt after). Also re-checks the git branch and
 * refreshes `runtime.autoresearchMode` (off-branch ⇒ detach), mirroring oh-my-pi's
 * `before_agent_start`. Returns undefined when mode is not effective.
 */
export async function buildAutoresearchContext(
  sessionId: string = getSessionId(),
): Promise<string | undefined> {
  const runtime = getAutoresearchRuntime(sessionId)
  if (!runtime.desiredMode) {
    runtime.autoresearchMode = false
    return undefined
  }

  const branch = await currentBranch()
  const store = await openAutoresearchStoreIfExists()
  const session = store?.getActiveSessionForBranch(branch) ?? null
  const onActiveBranch =
    session === null || session.branch === null || session.branch === branch
  runtime.autoresearchMode = runtime.desiredMode && onActiveBranch
  if (!runtime.autoresearchMode) return undefined

  const workingDir = getCwd()
  const goal = runtime.goal ?? session?.goal ?? session?.name ?? ''
  const hasGoal = goal.trim().length > 0

  if (!session || !store) {
    const onAutoresearchBranch = branch?.startsWith('autoresearch/') ?? false
    const baselineWarning = onAutoresearchBranch
      ? null
      : 'Heads up: you are not on a dedicated `autoresearch/*` branch. `log_experiment discard` will only revert run-modified files, not reset to baseline — so harness files written before `init_experiment` may not survive a discard. Clean the worktree and re-run `/autoresearch` if you want full revert safety.'
    return renderSetupPrompt({
      has_goal: hasGoal,
      goal,
      working_dir: workingDir,
      has_branch: Boolean(branch),
      branch: branch ?? '',
      has_baseline_warning: baselineWarning !== null,
      baseline_warning: baselineWarning ?? '',
    })
  }

  const state = buildExperimentState(session, store.listLoggedRuns(session.id))
  const pendingRun = pendingRunSummaryFromRow(store.getPendingRun(session.id))
  return renderIterationPrompt(buildIterationVars(state, workingDir, goal, hasGoal, pendingRun))
}

function buildIterationVars(
  state: ExperimentState,
  workingDir: string,
  goal: string,
  hasGoal: boolean,
  pendingRun: PendingRunSummary | null,
): Record<string, unknown> {
  const segmentResults = currentResults(state.results, state.currentSegment)
  const baselineMetric = findBaselineMetric(state.results, state.currentSegment)
  const baselineRunNumber = findBaselineRunNumber(state.results, state.currentSegment)
  const bestMetric = findBestKeptMetric(state.results, state.currentSegment, state.bestDirection)
  const bestResult = bestKeptResult(state.results, state.currentSegment, state.bestDirection)

  const recentResults = segmentResults.slice(-3).map(result => {
    const asiSummary = summarizeExperimentAsi(result)
    return {
      asi_summary: asiSummary ?? '',
      description: result.description,
      has_asi_summary: Boolean(asiSummary),
      metric_display: formatNum(result.metric, state.metricUnit),
      run_number: result.runNumber ?? state.results.indexOf(result) + 1,
      status: result.status,
      has_deviations: result.scopeDeviations.length > 0,
      deviations: result.scopeDeviations.join(', '),
      justified: Boolean(result.justification),
      flagged: result.flagged,
      flagged_reason: result.flaggedReason ?? '',
    }
  })

  const unjustifiedRuns = segmentResults
    .filter(
      r =>
        r.status === 'keep' &&
        !r.flagged &&
        r.scopeDeviations.length > 0 &&
        !r.justification,
    )
    .slice(-3)
    .map(r => ({
      run_number: r.runNumber,
      paths: r.scopeDeviations.join(', '),
    }))

  const pendingMetric =
    pendingRun?.parsedPrimary !== null && pendingRun?.parsedPrimary !== undefined

  return {
    has_goal: hasGoal,
    goal,
    working_dir: workingDir,
    metric_name: state.metricName,
    has_branch: Boolean(state.branch),
    branch: state.branch ?? '',
    has_baseline_commit: Boolean(state.baselineCommit),
    baseline_commit: state.baselineCommit ? state.baselineCommit.slice(0, 12) : '',
    has_notes: state.notes.trim().length > 0,
    notes: state.notes,
    current_segment: state.currentSegment + 1,
    current_segment_run_count: segmentResults.length,
    has_baseline_metric: baselineMetric !== null,
    baseline_metric_display: formatNum(baselineMetric, state.metricUnit),
    baseline_run_number: baselineRunNumber,
    has_best_result: bestResult !== null && bestMetric !== null,
    best_metric_display: bestMetric !== null ? formatNum(bestMetric, state.metricUnit) : '-',
    best_run_number: bestResult
      ? bestResult.runNumber ?? state.results.indexOf(bestResult) + 1
      : null,
    has_recent_results: recentResults.length > 0,
    recent_results: recentResults,
    has_unjustified_runs: unjustifiedRuns.length > 0,
    unjustified_runs: unjustifiedRuns,
    has_pending_run: Boolean(pendingRun),
    pending_run_number: pendingRun?.runNumber,
    pending_run_command: pendingRun?.command,
    pending_run_passed: pendingRun?.passed ?? false,
    has_pending_run_metric: pendingMetric,
    pending_run_metric_display: pendingMetric
      ? formatNum(pendingRun!.parsedPrimary!, state.metricUnit)
      : '',
  }
}

// === Autonomous continuation driver =========================================

/**
 * Called from the REPL idle effect (alongside `onGoalTurnEnd`). When autoresearch
 * mode is on, there is no pending user input, and either a run is unlogged or the
 * loop was armed by an experiment tool, enqueue a hidden, low-priority resume
 * prompt — the queue processor drains it on the idle tick, starting the next
 * iteration. That iteration ends, this runs again: the autonomous loop.
 */
export function onAutoresearchTurnEnd(
  sessionId: string = getSessionId(),
): void {
  const runtime = runtimes.get(sessionId)
  if (!runtime || !runtime.autoresearchMode) return
  // Never starve real user input: if the user queued anything, disarm and defer.
  if (hasCommandsInQueue()) {
    runtime.autoResumeArmed = false
    return
  }
  void (async () => {
    try {
      const store = await openAutoresearchStoreIfExists()
      const branch = await currentBranch()
      const session = store?.getActiveSessionForBranch(branch) ?? null
      const pendingRun =
        session && store ? pendingRunSummaryFromRow(store.getPendingRun(session.id)) : null
      const shouldResumePending =
        pendingRun !== null &&
        runtime.lastAutoResumePendingRunNumber !== pendingRun.runNumber
      if (!shouldResumePending && !runtime.autoResumeArmed) return
      runtime.autoResumeArmed = false
      runtime.lastAutoResumePendingRunNumber = pendingRun?.runNumber ?? null
      enqueue({
        value: renderResumeMessage({ has_pending_run: Boolean(pendingRun) }),
        mode: 'prompt',
        priority: 'later',
        isMeta: true,
      })
    } catch {
      // Best-effort; never crash the idle tick over an auto-resume.
    }
  })()
}

// === Command orchestration ==================================================

export interface ActivateResult {
  ok: boolean
  error?: string
  warning?: string
  notice?: string
  /** A message to submit as the next user turn (Phase 1 goal or resume prompt). */
  sendMessage?: string
}

/**
 * `/autoresearch <goal>` — ensure an `autoresearch/*` branch, turn mode on, and
 * either resume an existing session for the branch or start Phase 1 with the goal
 * as the first user message.
 */
export async function activateAutoresearch(
  goalArg: string | null,
  sessionId: string = getSessionId(),
): Promise<ActivateResult> {
  const runtime = getAutoresearchRuntime(sessionId)
  const branchResult = await ensureAutoresearchBranch(goalArg ?? runtime.goal)
  if (!branchResult.ok) {
    return { ok: false, error: branchResult.error }
  }

  const store = await openAutoresearchStoreIfExists()
  const existingSession = store?.getActiveSessionForBranch(branchResult.branchName) ?? null
  const branchStatusLine = branchResult.branchName
    ? branchResult.created
      ? `Created and checked out dedicated git branch \`${branchResult.branchName}\` before resuming.`
      : `Using dedicated git branch \`${branchResult.branchName}\`.`
    : 'Continuing on the current branch — no autoresearch branch was created.'

  runtime.desiredMode = true
  runtime.autoresearchMode = true
  runtime.autoResumeArmed = false
  runtime.lastAutoResumePendingRunNumber = null
  runtime.branch = branchResult.branchName

  if (existingSession && store) {
    if (goalArg) await store.updateSession(existingSession.id, { goal: goalArg })
    if (branchResult.branchName) {
      await store.updateSession(existingSession.id, { branch: branchResult.branchName })
    }
    const refreshed = store.getSessionById(existingSession.id) ?? existingSession
    runtime.goal = refreshed.goal ?? goalArg
    persistControlState(sessionId, runtime)
    const resumeContext = goalArg ?? ''
    return {
      ok: true,
      warning: branchResult.warning,
      sendMessage: renderCommandResume({
        branch_status_line: branchStatusLine,
        has_resume_context: resumeContext.length > 0,
        resume_context: resumeContext,
      }),
    }
  }

  runtime.goal = goalArg
  persistControlState(sessionId, runtime)
  if (goalArg !== null) {
    return { ok: true, warning: branchResult.warning, sendMessage: goalArg }
  }
  return {
    ok: true,
    warning: branchResult.warning,
    notice: 'Autoresearch enabled — describe what to optimize in your next message.',
  }
}

/** `/autoresearch` (when on) or `/autoresearch off` — leave mode without clearing. */
export function toggleOffAutoresearch(
  sessionId: string = getSessionId(),
): { notice: string } {
  const runtime = getAutoresearchRuntime(sessionId)
  runtime.desiredMode = false
  runtime.autoresearchMode = false
  runtime.autoResumeArmed = false
  persistControlState(sessionId, runtime)
  return { notice: 'Autoresearch mode disabled.' }
}

const LEGACY_ARTIFACTS = [
  'autoresearch.md',
  'autoresearch.sh',
  'autoresearch.checks.sh',
  'autoresearch.program.md',
  'autoresearch.ideas.md',
  'autoresearch.jsonl',
  'autoresearch.config.json',
  '.autoresearch',
]

/**
 * `/autoresearch clear [--keep-tree|--reset-tree]` — reset the worktree to the
 * recorded baseline (when on an autoresearch branch or `--reset-tree`), remove
 * legacy harness artifacts, close the active session, and turn mode off.
 */
export async function clearAutoresearchSession(
  opts: { keepTree: boolean; resetTreeForce: boolean },
  sessionId: string = getSessionId(),
): Promise<{ notice?: string; warning?: string; error?: string }> {
  const runtime = getAutoresearchRuntime(sessionId)
  const store = await openAutoresearchStore()
  const session = store.getActiveSession()
  const branch = await currentBranch()
  const onAutoresearchBranch = branch?.startsWith('autoresearch/') ?? false
  const shouldResetTree = !opts.keepTree && (onAutoresearchBranch || opts.resetTreeForce)

  let warning: string | undefined
  let error: string | undefined
  if (shouldResetTree && session?.baselineCommit) {
    try {
      await resetHard(session.baselineCommit)
      await clean()
    } catch (err) {
      error = `Failed to reset worktree to baseline: ${err instanceof Error ? err.message : String(err)}`
    }
  } else if (shouldResetTree) {
    warning = 'No baseline commit recorded — skipped worktree reset.'
  }

  removeLegacyArtifacts(getCwd())

  if (session) await store.closeSession(session.id)
  runtime.desiredMode = false
  runtime.autoresearchMode = false
  runtime.autoResumeArmed = false
  runtime.goal = null
  runtime.branch = null
  persistControlState(sessionId, runtime)

  return { notice: 'Autoresearch session cleared.', warning, error }
}

export function formatAutoresearchStatus(
  sessionId: string = getSessionId(),
): string {
  const runtime = getAutoresearchRuntime(sessionId)
  const lines = [`Autoresearch mode: ${runtime.autoresearchMode ? 'on' : 'off'}`]
  if (runtime.goal) lines.push(`Goal: ${runtime.goal}`)
  if (runtime.branch) lines.push(`Branch: ${runtime.branch}`)
  return lines.join('\n')
}

function removeLegacyArtifacts(workDir: string): void {
  for (const name of LEGACY_ARTIFACTS) {
    try {
      rmSync(join(workDir, name), { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
}

// === Shared row→summary helpers (ported from oh-my-pi index.ts) =============

export function pendingRunSummaryFromRow(
  row: RunRow | null,
): PendingRunSummary | null {
  if (!row) return null
  if (row.status !== null) return null
  if (row.completedAt === null) return null
  const passed = row.exitCode === 0 && !row.timedOut
  return {
    command: row.command,
    durationSeconds: row.durationMs !== null ? row.durationMs / 1000 : null,
    parsedAsi: row.parsedAsi,
    parsedMetrics: row.parsedMetrics,
    parsedPrimary: row.parsedPrimary,
    passed,
    preRunDirtyPaths: row.preRunDirtyPaths,
    runDirectory: dirname(row.logPath),
    runNumber: row.id,
    exitCode: row.exitCode,
    timedOut: row.timedOut,
  }
}

function summarizeExperimentAsi(result: ExperimentResult): string | null {
  const hypothesis =
    typeof result.asi?.hypothesis === 'string' ? result.asi.hypothesis.trim() : ''
  const rollback =
    typeof result.asi?.rollback_reason === 'string'
      ? result.asi.rollback_reason.trim()
      : ''
  const next =
    typeof result.asi?.next_action_hint === 'string'
      ? result.asi.next_action_hint.trim()
      : ''
  const summary = [hypothesis, rollback, next].filter(part => part.length > 0).join(' | ')
  return summary.length > 0 ? summary.slice(0, 220) : null
}

function bestKeptResult(
  results: ExperimentResult[],
  segment: number,
  direction: 'lower' | 'higher',
): ExperimentResult | null {
  let best: ExperimentResult | null = null
  for (const result of results) {
    if (result.segment !== segment || result.status !== 'keep' || result.flagged) continue
    if (!best) {
      best = result
      continue
    }
    const better =
      direction === 'lower' ? result.metric < best.metric : result.metric > best.metric
    if (better) best = result
  }
  return best
}

// === Control-state sidecar persistence ======================================

function controlDir(): string {
  return join(getNcodeConfigHomeDir(), 'autoresearch', 'control')
}

function controlPath(sessionId: string): string {
  return join(controlDir(), `${sessionId}.json`)
}

function persistControlState(
  sessionId: string,
  runtime: AutoresearchRuntime,
): void {
  try {
    const path = controlPath(sessionId)
    if (!runtime.desiredMode && !runtime.goal) {
      if (existsSync(path)) rmSync(path, { force: true })
      return
    }
    mkdirSync(controlDir(), { recursive: true })
    const data: AutoresearchControlState = {
      mode: runtime.desiredMode,
      goal: runtime.goal,
      branch: runtime.branch,
    }
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 })
  } catch {
    // Persistence is best-effort; never break a turn over a sidecar write.
  }
}

function restoreControlState(
  sessionId: string,
  runtime: AutoresearchRuntime,
): void {
  try {
    const path = controlPath(sessionId)
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AutoresearchControlState
    if (parsed && typeof parsed.mode === 'boolean') {
      runtime.desiredMode = parsed.mode
      // Effective mode is verified against the git branch by the per-turn
      // context getter; arm it optimistically so resumed tools stay available.
      runtime.autoresearchMode = parsed.mode
      runtime.goal = parsed.goal ?? null
      runtime.branch = parsed.branch ?? null
    }
  } catch {
    // Ignore corrupt sidecar state.
  }
}
