/**
 * update_notes — persist the durable autoresearch playbook on the active session.
 *
 * Ported from oh-my-pi `autoresearch/tools/update-notes.ts` (arktype → zod).
 * `body` replaces the entire notes blob; `append_idea` appends a single bullet
 * under an `## Ideas` section. The notes are re-injected into the iteration
 * prompt every turn.
 */

import * as React from 'react'
import { z } from 'zod/v4'
import { isAutoresearchToolAvailable } from '../../autoresearch/index.js'
import { Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { NO_SESSION_ERROR, resolveActiveSession } from './shared.js'

const inputSchema = () =>
  z.strictObject({
    body: z.string().describe('replacement notes body'),
    append_idea: z
      .string()
      .optional()
      .describe('append as bullet under Ideas instead of replacing body'),
  })
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = () => z.object({ text: z.string() }).passthrough()
type OutputSchema = ReturnType<typeof outputSchema>
type Output = { text: string }

export const UpdateNotesTool: Tool<InputSchema, Output> = buildTool({
  name: 'update_notes',
  searchHint: 'persist the durable autoresearch playbook / ideas backlog',
  maxResultSizeChars: 2_000,
  async description() {
    return 'Persist the durable autoresearch playbook (goal, scope notes, hypotheses, ideas backlog) on the active session. Pass `body` to replace the entire notes blob, or `append_idea` to append a single bullet under an `## Ideas` section.'
  },
  async prompt() {
    return 'Persist the durable autoresearch playbook on the active session. `body` replaces the entire notes blob; `append_idea` appends one bullet under `## Ideas`. The notes are injected into your iteration prompt every turn.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Update Notes'
  },
  isEnabled() {
    return isAutoresearchToolAvailable()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  renderToolUseMessage(input: Input) {
    const preview = input?.append_idea ?? input?.body ?? ''
    return `update_notes ${preview.slice(0, 80)}`.trim()
  },
  renderToolResultMessage(output: Output) {
    return React.createElement(Text, {}, output.text)
  },
  async call(input: Input, context) {
    if (context.agentId) {
      throw new Error('update_notes cannot be used in agent contexts')
    }
    const { store, session } = await resolveActiveSession()
    if (!store || !session) {
      return { data: { text: NO_SESSION_ERROR } }
    }

    const nextNotes =
      input.append_idea !== undefined && input.append_idea.trim().length > 0
        ? appendIdea(session.notes, input.append_idea.trim())
        : input.body

    await store.updateSession(session.id, { notes: nextNotes })

    return {
      data: {
        text:
          input.append_idea !== undefined
            ? `Appended idea (${nextNotes.length} chars total).`
            : `Notes updated (${nextNotes.length} chars).`,
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

const IDEAS_HEADING = '## Ideas'

function appendIdea(currentNotes: string, idea: string): string {
  const trimmed = currentNotes.trimEnd()
  if (trimmed.length === 0) {
    return `${IDEAS_HEADING}\n- ${idea}\n`
  }
  if (trimmed.includes(IDEAS_HEADING)) {
    const lines = trimmed.split('\n')
    const ideasIndex = lines.findIndex(line => line.trim() === IDEAS_HEADING)
    let insertAt = lines.length
    for (let i = ideasIndex + 1; i < lines.length; i += 1) {
      if (/^#{1,6}\s/.test(lines[i] ?? '')) {
        insertAt = i
        break
      }
    }
    lines.splice(insertAt, 0, `- ${idea}`)
    return `${lines.join('\n')}\n`
  }
  return `${trimmed}\n\n${IDEAS_HEADING}\n- ${idea}\n`
}
