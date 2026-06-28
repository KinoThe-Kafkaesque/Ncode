import type * as React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import {
  formatGoalStatus,
  getGoalModeState,
  getGoalRuntime,
} from '../../goals/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'

const SUBCOMMANDS = new Set([
  'set',
  'show',
  'status',
  'pause',
  'resume',
  'drop',
  'budget',
])

function done(onDone: LocalJSXCommandOnDone, text: string): void {
  onDone(text, { display: 'system' })
}

/**
 * `/goal` — set or manage the session's persistent autonomous objective.
 *
 *   /goal <objective>          start a goal (alias: /goal set <objective>)
 *   /goal show | status        show current goal + budget
 *   /goal pause | resume | drop
 *   /goal budget <n|none>      set or clear the token budget
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args: string,
): Promise<React.ReactNode> {
  const sessionId = getSessionId()
  const runtime = getGoalRuntime(sessionId)
  const trimmed = (args ?? '').trim()
  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase() ?? ''
  const rest = trimmed.slice(trimmed.split(/\s+/)[0]?.length ?? 0).trim()

  const isSub = SUBCOMMANDS.has(firstToken)
  const subcommand = isSub ? firstToken : ''
  // Treat the whole arg string as the objective unless it begins with an
  // explicit subcommand. `/goal set <obj>` and `/goal <obj>` both start a goal.
  const objective = subcommand === 'set' ? rest : isSub ? '' : trimmed

  try {
    if (!trimmed) {
      const state = getGoalModeState(sessionId)
      done(
        onDone,
        state?.goal
          ? formatGoalStatus(state.goal)
          : 'No goal set. Use /goal <objective> to start one.',
      )
      return null
    }

    if (subcommand === 'show' || subcommand === 'status') {
      const state = getGoalModeState(sessionId)
      done(
        onDone,
        state?.goal ? formatGoalStatus(state.goal) : 'No goal set.',
      )
      return null
    }

    if (subcommand === 'pause') {
      const state = runtime.pauseGoal()
      done(
        onDone,
        state?.goal
          ? `Goal paused.\n${formatGoalStatus(state.goal)}`
          : 'No goal to pause.',
      )
      return null
    }

    if (subcommand === 'resume') {
      const state = getGoalModeState(sessionId)
      if (!state?.goal) {
        done(onDone, 'No goal to resume.')
        return null
      }
      const resumed = runtime.resumeGoal()
      // Re-activated: kick a turn so the autonomous loop continues.
      onDone(`Goal resumed.\n${formatGoalStatus(resumed.goal)}`, {
        display: 'system',
        nextInput: 'Continue working on the active goal.',
        submitNextInput: true,
      })
      return null
    }

    if (subcommand === 'drop') {
      const dropped = runtime.dropGoal()
      done(
        onDone,
        dropped
          ? `Goal dropped: "${dropped.objective}"`
          : 'No goal to drop.',
      )
      return null
    }

    if (subcommand === 'budget') {
      if (!getGoalModeState(sessionId)?.goal) {
        done(onDone, 'No goal set. Start one with /goal <objective>.')
        return null
      }
      const value = rest.toLowerCase()
      let newBudget: number | undefined
      if (value === '' ) {
        done(onDone, 'Usage: /goal budget <positive integer | none>')
        return null
      }
      if (value !== 'none') {
        newBudget = Number(rest)
        if (!Number.isInteger(newBudget) || newBudget <= 0) {
          done(onDone, 'Token budget must be a positive integer (or "none").')
          return null
        }
      }
      const state = runtime.onBudgetMutated(newBudget)
      done(
        onDone,
        state?.goal
          ? `Budget updated.\n${formatGoalStatus(state.goal)}`
          : 'No goal to update.',
      )
      return null
    }

    // Default: start a goal with the full arg string as the objective.
    const created = runtime.createGoal({ objective })
    onDone(`Goal set: "${created.goal.objective}"`, {
      display: 'system',
      nextInput: created.goal.objective,
      submitNextInput: true,
    })
    return null
  } catch (error) {
    done(onDone, `Goal command failed: ${errorMessage(error)}`)
    return null
  }
}
