import type * as React from 'react'
import {
  activateAutoresearch,
  clearAutoresearchSession,
  formatAutoresearchStatus,
  getAutoresearchRuntime,
  toggleOffAutoresearch,
} from '../../autoresearch/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'

function done(onDone: LocalJSXCommandOnDone, text: string): void {
  onDone(text, { display: 'system' })
}

/**
 * `/autoresearch` — drive the autonomous experiment loop.
 *
 *   /autoresearch <goal>                     enable + ensure an autoresearch/* branch,
 *                                            then send the goal as Phase 1's first message
 *   /autoresearch                            (when on) toggle off; (when off) show status
 *   /autoresearch off                        leave autoresearch mode (keeps the session)
 *   /autoresearch clear [--keep-tree|--reset-tree]
 *                                            reset the worktree to baseline + close session
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args: string,
): Promise<React.ReactNode> {
  const trimmed = (args ?? '').trim()

  try {
    // Bare `/autoresearch`: toggle off when on, else show status.
    if (trimmed === '') {
      const runtime = getAutoresearchRuntime()
      if (runtime.autoresearchMode) {
        done(onDone, toggleOffAutoresearch().notice)
      } else {
        done(onDone, formatAutoresearchStatus())
      }
      return null
    }

    if (trimmed === 'off') {
      done(onDone, toggleOffAutoresearch().notice)
      return null
    }

    if (trimmed === 'clear' || trimmed.startsWith('clear ')) {
      const flagPart = trimmed === 'clear' ? '' : trimmed.slice('clear '.length).trim()
      const keepTree = flagPart.includes('--keep-tree')
      const resetTreeForce = flagPart.includes('--reset-tree')
      const result = await clearAutoresearchSession({ keepTree, resetTreeForce })
      const lines = [result.notice, result.warning, result.error].filter(
        (line): line is string => Boolean(line),
      )
      done(onDone, lines.join('\n') || 'Autoresearch session cleared.')
      return null
    }

    // Otherwise the whole arg string is the goal: enable + Phase 1.
    const result = await activateAutoresearch(trimmed)
    if (!result.ok) {
      done(onDone, `Autoresearch failed: ${result.error ?? 'unknown error'}`)
      return null
    }

    const header = [
      'Autoresearch enabled.',
      result.warning,
      result.notice,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n')

    if (result.sendMessage) {
      onDone(header, {
        display: 'system',
        nextInput: result.sendMessage,
        submitNextInput: true,
      })
      return null
    }

    done(onDone, header)
    return null
  } catch (error) {
    done(onDone, `Autoresearch command failed: ${errorMessage(error)}`)
    return null
  }
}
