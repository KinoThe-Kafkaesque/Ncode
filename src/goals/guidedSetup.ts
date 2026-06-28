/**
 * Guided goal setup (ported from oh-my-pi `goals/guided-setup.ts`).
 *
 * Runs one LLM interview turn that either asks a follow-up question or returns
 * a finalized objective. Uses ncode's `sideQuery` one-shot helper with a forced
 * `respond` tool call, on the small/fast model. The caller (`/guided-goal`)
 * loops this up to 6 turns.
 */

import { getSmallFastModel } from '../utils/model/model.js'
import { sideQuery } from '../utils/sideQuery.js'
import { GUIDED_GOAL_SYSTEM, renderGuidedGoalInterview } from './prompts.js'

const RESPOND_TOOL_NAME = 'respond'

// Anthropic.Tool shape (input_schema). Kept loose; sideQuery accepts Tool[].
const RESPOND_TOOL = {
  name: RESPOND_TOOL_NAME,
  description: 'Return the next guided-goal interview step.',
  input_schema: {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', enum: ['question', 'ready'] },
      question: { type: 'string' },
      objective: { type: 'string' },
    },
    required: ['kind'],
    additionalProperties: false,
  },
}

export interface GuidedGoalMessage {
  role: 'user' | 'assistant'
  content: string
}

export type GuidedGoalTurnResult =
  | { kind: 'question'; question: string; objective?: string }
  | { kind: 'ready'; objective: string }

export interface GuidedGoalTurnOptions {
  messages: readonly GuidedGoalMessage[]
  signal?: AbortSignal
}

function parseGuidedGoalPayload(value: unknown): GuidedGoalTurnResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('guided goal returned an invalid response')
  }
  const payload = value as Record<string, unknown>
  if (
    payload.kind === 'question' &&
    typeof payload.question === 'string' &&
    payload.question.trim()
  ) {
    const question = payload.question.trim()
    if (typeof payload.objective === 'string' && payload.objective.trim()) {
      return { kind: 'question', question, objective: payload.objective.trim() }
    }
    return { kind: 'question', question }
  }
  if (
    payload.kind === 'ready' &&
    typeof payload.objective === 'string' &&
    payload.objective.trim()
  ) {
    return { kind: 'ready', objective: payload.objective.trim() }
  }
  throw new Error('guided goal returned an invalid response')
}

export async function runGuidedGoalTurn(
  options: GuidedGoalTurnOptions,
): Promise<GuidedGoalTurnResult> {
  const model = getSmallFastModel()
  const userPrompt = renderGuidedGoalInterview(
    options.messages.map(message => ({
      label: message.role.toUpperCase(),
      content: message.content,
    })),
  )

  const response = await sideQuery({
    model,
    system: GUIDED_GOAL_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [RESPOND_TOOL],
    tool_choice: { type: 'tool', name: RESPOND_TOOL_NAME },
    signal: options.signal,
    querySource: 'guided_goal',
  })

  const toolUseBlock = response.content.find(c => c.type === 'tool_use')
  if (toolUseBlock && toolUseBlock.type === 'tool_use') {
    return parseGuidedGoalPayload(toolUseBlock.input)
  }

  const textBlock = response.content.find(c => c.type === 'text')
  if (textBlock && textBlock.type === 'text') {
    try {
      return parseGuidedGoalPayload(JSON.parse(textBlock.text))
    } catch {
      throw new Error('guided goal returned an invalid response')
    }
  }
  throw new Error('guided goal returned an invalid response')
}
