import * as React from 'react'
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import {
  completionBudgetReport,
  getGoalModeState,
  getGoalRuntime,
  isGoalToolAvailable,
  remainingTokens,
  type Goal,
} from '../../goals/index.js'
import { Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { GOAL_TOOL_NAME, GOAL_TOOL_PROMPT } from './prompt.js'

const inputSchema = () =>
  z.strictObject({
    op: z
      .enum(['create', 'get', 'complete', 'resume', 'drop'])
      .describe('goal operation'),
    objective: z.string().optional().describe('goal objective'),
    token_budget: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('token budget'),
  })
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = () => z.object({ text: z.string() }).passthrough()
type OutputSchema = ReturnType<typeof outputSchema>

type Output = {
  text: string
  op: Input['op']
  goal: Goal | null
  remainingTokens: number | null
  completionBudgetReport: string | null
}

function formatText(
  goal: Goal | null,
  remaining: number | null,
  report: string | null,
): string {
  if (!goal) return 'No active goal.'
  let text = `Goal: ${goal.objective}\nStatus: ${goal.status}\nTokens: ${goal.tokensUsed} used`
  if (goal.tokenBudget !== undefined) text += ` / ${goal.tokenBudget} budget`
  if (remaining !== null) text += `\nRemaining tokens: ${remaining}`
  if (report) text += `\n\n${report}`
  return text
}

export const GoalTool: Tool<InputSchema, Output> = buildTool({
  name: GOAL_TOOL_NAME,
  searchHint: 'inspect, complete, resume, or drop the active goal-mode objective',
  maxResultSizeChars: 8_000,
  async description() {
    return 'Manage the active goal-mode objective (create/get/complete/resume/drop)'
  },
  async prompt() {
    return GOAL_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Goal'
  },
  isEnabled() {
    return isGoalToolAvailable()
  },
  isConcurrencySafe() {
    // Mutates session goal state; never run concurrently with other tools.
    return false
  },
  isReadOnly() {
    return false
  },
  renderToolUseMessage(input: Input) {
    const op = input?.op ?? '?'
    if (op === 'create' && input?.objective) {
      return `goal set: "${input.objective}"`
    }
    return `goal ${op}`
  },
  renderToolResultMessage(output: Output) {
    return React.createElement(Text, {}, output.text)
  },
  async call(input: Input, context) {
    if (context.agentId) {
      throw new Error('goal tool cannot be used in agent contexts')
    }
    const sessionId = getSessionId()
    const runtime = getGoalRuntime(sessionId)

    let goal: Goal | null = null
    let includeReport = false
    if (input.op === 'create') {
      const created = runtime.createGoal({
        objective: input.objective ?? '',
        tokenBudget: input.token_budget,
      })
      goal = created.goal
    } else if (input.op === 'get') {
      goal = getGoalModeState(sessionId)?.goal ?? null
    } else if (input.op === 'resume') {
      goal = runtime.resumeGoal().goal
    } else if (input.op === 'drop') {
      goal = runtime.dropGoal() ?? null
    } else {
      goal = runtime.completeGoalFromTool()
      includeReport = true
    }

    const remaining = remainingTokens(goal)
    const report =
      includeReport && goal?.status === 'complete'
        ? completionBudgetReport(goal)
        : null

    return {
      data: {
        text: formatText(goal, remaining, report),
        op: input.op,
        goal,
        remainingTokens: remaining,
        completionBudgetReport: report,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.text,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
