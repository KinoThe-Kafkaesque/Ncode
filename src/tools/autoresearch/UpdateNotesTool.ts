/**
 * update_notes — persist the durable autoresearch playbook to `.auto/prompt.md`
 * and `.auto/ideas.md`.
 *
 * Ported from oh-my-pi `autoresearch/tools/update-notes.ts` (arktype → zod).
 * `body` replaces the entire `.auto/prompt.md`; `append_idea` appends a single
 * bullet to `.auto/ideas.md`. The prompt is re-injected into the iteration
 * prompt every turn.
 */

import * as React from 'react'
import * as fs from 'node:fs'
import { z } from 'zod/v4'
import { isAutoresearchToolAvailable } from '../../autoresearch/index.js'
import { ensureParentDir, sessionFilePath } from '../../autoresearch/paths.js'
import { Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { NO_SESSION_ERROR, hasActiveSession } from './shared.js'

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
    return 'Persist the durable autoresearch playbook to `.auto/prompt.md` and `.auto/ideas.md`. Pass `body` to replace the entire prompt file, or `append_idea` to append a single bullet to the ideas file.'
  },
  async prompt() {
    return 'Persist the durable autoresearch playbook to `.auto/prompt.md` and `.auto/ideas.md`. `body` replaces the entire prompt file; `append_idea` appends one bullet to `.auto/ideas.md`. The prompt is injected into your iteration prompt every turn.'
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
    if (!hasActiveSession()) {
      return { data: { text: NO_SESSION_ERROR } }
    }
    const workDir = getCwd()

    if (input.append_idea !== undefined && input.append_idea.trim().length > 0) {
      const idea = input.append_idea.trim()
      const ideasPath = sessionFilePath(workDir, 'ideas')
      ensureParentDir(ideasPath)
      if (!fs.existsSync(ideasPath)) {
        fs.writeFileSync(ideasPath, `${IDEAS_HEADING}\n`)
      }
      fs.appendFileSync(ideasPath, `- ${idea}\n`)
      return { data: { text: `Appended idea to ${ideasPath}.` } }
    }

    const promptPath = sessionFilePath(workDir, 'prompt')
    ensureParentDir(promptPath)
    fs.writeFileSync(promptPath, input.body)
    return { data: { text: `Notes updated (${input.body.length} chars) in ${promptPath}.` } }
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

