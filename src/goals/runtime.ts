/**
 * GoalRuntime — the goal-mode state machine + token/time budget accounting
 * (ported from oh-my-pi `goals/runtime.ts`, adapted to ncode primitives).
 *
 * Differences from oh-my-pi (documented for fidelity review):
 * - oh-my-pi flushes usage after every tool call and at agent-end against a
 *   per-turn snapshot. ncode collapses accounting to a single end-of-turn
 *   reconciliation (`flushUsage`) driven from the REPL idle hook, against a
 *   persistent baseline that advances on each flush. The NET tokensUsed total
 *   is identical; only mid-turn budget-limit steering granularity differs.
 * - The token-delta formula (`goalTokenDelta`) is preserved verbatim: include
 *   input + cacheWrite + output deltas, EXCLUDE cacheRead.
 * - Host hooks for hidden-message steering / event emission are handled by the
 *   session driver (`goals/index.ts`) via ncode's message queue, so the host
 *   here is minimal: state get/set, cumulative usage, persistence, clock.
 */

import {
  goalTokenDelta,
  renderGoalPrompt,
} from './prompts.js'
import type { Goal, GoalModeState, GoalTokenUsage } from './state.js'

export interface GoalRuntimeHost {
  getState(): GoalModeState | undefined
  setState(state: GoalModeState | undefined): void
  /** Cumulative session token usage for budget accounting. */
  getCurrentUsage(): GoalTokenUsage
  /** Durably persist the latest state (or clear it when undefined). */
  persist(state: GoalModeState | undefined): void
  now?(): number
}

export interface FlushResult {
  flippedToBudgetLimited: boolean
}

let idCounter = 0
function nextGoalId(): string {
  idCounter += 1
  return `${Date.now()}-${idCounter}`
}

function cloneGoal(goal: Goal): Goal {
  return { ...goal }
}

function cloneState(state: GoalModeState): GoalModeState {
  return { ...state, goal: cloneGoal(state.goal) }
}

function validateTokenBudget(tokenBudget: number | undefined): void {
  if (
    tokenBudget !== undefined &&
    (!Number.isInteger(tokenBudget) || tokenBudget <= 0)
  ) {
    throw new Error('goal token_budget must be a positive integer when provided')
  }
}

function isAccountingStatus(goal: Goal): boolean {
  return goal.status === 'active' || goal.status === 'budget-limited'
}

export class GoalRuntime {
  readonly #host: GoalRuntimeHost
  /** Cumulative-usage snapshot captured when accounting last advanced. */
  #baselineUsage: GoalTokenUsage | undefined
  #lastAccountedAt: number
  #activeGoalId: string | undefined
  #budgetReportedFor: string | undefined

  constructor(host: GoalRuntimeHost) {
    this.#host = host
    this.#lastAccountedAt = this.#now()
  }

  #now(): number {
    return this.#host.now?.() ?? Date.now()
  }

  #getStateClone(): GoalModeState | undefined {
    const state = this.#host.getState()
    return state ? cloneState(state) : undefined
  }

  #commitState(state: GoalModeState | undefined, persist: boolean): void {
    this.#host.setState(state ? cloneState(state) : undefined)
    if (persist) this.#host.persist(state)
  }

  #markActiveAccounting(goal: Goal): void {
    this.#baselineUsage = { ...this.#host.getCurrentUsage() }
    this.#lastAccountedAt = this.#now()
    this.#activeGoalId = goal.id
  }

  #clearActiveAccounting(): void {
    this.#baselineUsage = undefined
    this.#lastAccountedAt = this.#now()
    this.#activeGoalId = undefined
    this.#budgetReportedFor = undefined
  }

  clearAccounting(): void {
    this.#clearActiveAccounting()
  }

  /**
   * Reconcile cumulative usage into the active goal. Computes the token delta
   * (input + cacheWrite + output, excluding cacheRead) and wall-clock seconds
   * since the last flush, accumulates them, advances the baseline, and flips
   * the goal to `budget-limited` if it crossed its budget. Returns whether the
   * goal newly flipped to budget-limited this flush.
   */
  flushUsage(
    currentUsage: GoalTokenUsage = this.#host.getCurrentUsage(),
  ): FlushResult {
    const state = this.#getStateClone()
    if (!state?.enabled || !isAccountingStatus(state.goal)) {
      return { flippedToBudgetLimited: false }
    }
    if (this.#activeGoalId !== state.goal.id || !this.#baselineUsage) {
      // First time we see this active goal — establish a baseline, no delta.
      this.#markActiveAccounting(state.goal)
      return { flippedToBudgetLimited: false }
    }

    const tokenDelta = goalTokenDelta(currentUsage, this.#baselineUsage)
    const now = this.#now()
    const wallSeconds = Math.max(
      0,
      Math.floor((now - this.#lastAccountedAt) / 1000),
    )
    if (tokenDelta <= 0 && wallSeconds <= 0) {
      return { flippedToBudgetLimited: false }
    }

    state.goal.tokensUsed += tokenDelta
    state.goal.timeUsedSeconds += wallSeconds
    state.goal.updatedAt = now

    const flippedToBudgetLimited =
      state.goal.tokenBudget !== undefined &&
      state.goal.tokensUsed >= state.goal.tokenBudget &&
      state.goal.status === 'active'
    if (flippedToBudgetLimited) {
      state.goal.status = 'budget-limited'
    }

    this.#baselineUsage = { ...currentUsage }
    if (wallSeconds > 0) this.#lastAccountedAt += wallSeconds * 1000

    if (state.goal.status !== 'budget-limited') {
      this.#budgetReportedFor = undefined
    }

    this.#commitState(state, true)
    return { flippedToBudgetLimited }
  }

  /** True once when a budget-limit steer should be sent for this goal. */
  shouldSteerBudget(goal: Goal): boolean {
    return this.#budgetReportedFor !== goal.id
  }

  markBudgetSteered(goal: Goal): void {
    this.#budgetReportedFor = goal.id
  }

  #createGoalState(
    objective: string,
    tokenBudget: number | undefined,
  ): GoalModeState {
    const now = this.#now()
    const goal: Goal = {
      id: nextGoalId(),
      objective,
      status: 'active',
      tokenBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    }
    return { enabled: true, mode: 'active', goal }
  }

  createGoal(input: { objective: string; tokenBudget?: number }): GoalModeState {
    const objective = input.objective.trim()
    if (!objective) throw new Error('objective is required when op=create')
    validateTokenBudget(input.tokenBudget)
    const existing = this.#host.getState()
    if (
      existing?.goal &&
      existing.goal.status !== 'dropped' &&
      existing.goal.status !== 'complete'
    ) {
      throw new Error(
        'cannot create a new goal because this session already has a goal',
      )
    }
    const state = this.#createGoalState(objective, input.tokenBudget)
    this.#budgetReportedFor = undefined
    this.#markActiveAccounting(state.goal)
    this.#commitState(state, true)
    return state
  }

  resumeGoal(): GoalModeState {
    const state = this.#getStateClone()
    if (!state?.goal) throw new Error('No paused goal.')
    if (state.goal.status === 'complete') {
      throw new Error('Goal is already complete.')
    }
    state.enabled = true
    state.mode = 'active'
    state.reason = undefined
    state.goal.status = 'active'
    state.goal.updatedAt = this.#now()
    this.#budgetReportedFor = undefined
    this.#markActiveAccounting(state.goal)
    this.#commitState(state, true)
    return state
  }

  pauseGoal(): GoalModeState | undefined {
    this.flushUsage()
    const state = this.#getStateClone()
    if (!state?.goal) return undefined
    state.enabled = false
    state.mode = 'active'
    state.reason = undefined
    if (state.goal.status === 'active' || state.goal.status === 'budget-limited') {
      state.goal.status = 'paused'
    }
    state.goal.updatedAt = this.#now()
    this.#clearActiveAccounting()
    this.#commitState(state, true)
    return state
  }

  dropGoal(): Goal | undefined {
    this.flushUsage()
    const state = this.#getStateClone()
    if (!state?.goal) return undefined
    const dropped: Goal = {
      ...state.goal,
      status: 'dropped',
      updatedAt: this.#now(),
    }
    this.#clearActiveAccounting()
    this.#commitState(undefined, true)
    return dropped
  }

  completeGoalFromTool(): Goal {
    this.flushUsage()
    const state = this.#getStateClone()
    if (!state?.goal) {
      throw new Error('cannot complete goal because no goal is active')
    }
    if (state.goal.status === 'complete') {
      throw new Error('goal is already complete')
    }
    if (state.goal.status === 'dropped') {
      throw new Error('cannot complete a dropped goal')
    }
    state.enabled = false
    state.goal.status = 'complete'
    state.goal.updatedAt = this.#now()
    state.mode = 'exiting'
    state.reason = 'completed'
    this.#clearActiveAccounting()
    this.#commitState(state, true)
    return state.goal
  }

  onBudgetMutated(newBudget: number | undefined): GoalModeState | undefined {
    validateTokenBudget(newBudget)
    this.#budgetReportedFor = undefined
    this.flushUsage()
    const state = this.#getStateClone()
    if (!state?.goal) return undefined
    state.goal.tokenBudget = newBudget
    state.goal.updatedAt = this.#now()
    if (newBudget !== undefined && state.goal.tokensUsed >= newBudget) {
      if (state.goal.status === 'active') {
        state.goal.status = 'budget-limited'
      }
    } else if (state.goal.status === 'budget-limited') {
      state.goal.status = 'active'
      state.enabled = true
      this.#markActiveAccounting(state.goal)
    }
    this.#commitState(state, true)
    return state
  }

  buildActivePrompt(): string | undefined {
    const state = this.#host.getState()
    return state?.enabled && state.goal && state.goal.status === 'active'
      ? renderGoalPrompt('active', state.goal)
      : undefined
  }

  buildContinuationPrompt(): string | undefined {
    const state = this.#host.getState()
    return state?.enabled && state.goal.status === 'active'
      ? renderGoalPrompt('continuation', state.goal)
      : undefined
  }

  buildBudgetLimitPrompt(): string | undefined {
    const state = this.#host.getState()
    return state?.enabled && state.goal.status === 'budget-limited'
      ? renderGoalPrompt('budget-limit', state.goal)
      : undefined
  }
}
