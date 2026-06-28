/**
 * Goal-mode state types (ported from oh-my-pi `goals/state.ts`).
 *
 * Goal mode is a persistent-objective autonomous loop: the user pins one
 * objective, the agent keeps working on it across turns (auto-continuation),
 * token/time usage is accounted against an optional budget, and the loop ends
 * only when the agent verifiably completes the goal, the budget is exhausted,
 * or the user pauses/drops it.
 */

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'budget-limited'
  | 'complete'
  | 'dropped'

export interface Goal {
  id: string
  objective: string
  status: GoalStatus
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export interface GoalModeState {
  enabled: boolean
  mode: 'active' | 'exiting'
  reason?: 'completed'
  goal: Goal
}

export interface GoalToolDetails {
  op: 'create' | 'get' | 'complete' | 'resume' | 'drop'
  goal?: Goal | null
  remainingTokens?: number | null
  completionBudgetReport?: string | null
}

/**
 * Cumulative token usage snapshot used for budget accounting.
 *
 * Mirrors oh-my-pi's `GoalTokenUsage` (input/output/cacheRead/cacheWrite). In
 * ncode these come from the live session counters in `bootstrap/state.ts`
 * (`getTotalInputTokens`, etc.). `cacheRead` is tracked but intentionally
 * EXCLUDED from the budget delta — it is reused prefix, not new work.
 */
export interface GoalTokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type GoalBudgetSteering = 'allowed' | 'suppressed'
