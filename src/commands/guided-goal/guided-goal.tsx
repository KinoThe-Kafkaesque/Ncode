import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import { getGoalRuntime } from '../../goals/index.js'
import {
  type GuidedGoalMessage,
  runGuidedGoalTurn,
} from '../../goals/guidedSetup.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import TextInput from '../../components/TextInput.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { createAbortController } from '../../utils/abortController.js'
import { errorMessage } from '../../utils/errors.js'

// oh-my-pi caps the interview at 6 interviewer turns.
const MAX_TURNS = 6

type Phase = 'loading' | 'asking' | 'finalizing' | 'error'

type Props = {
  initialIdea: string
  onDone: LocalJSXCommandOnDone
}

function GuidedGoalInterview({ initialIdea, onDone }: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const sessionId = useRef(getSessionId()).current
  const [phase, setPhase] = useState<Phase>('loading')
  const [question, setQuestion] = useState<string>('')
  const [draftObjective, setDraftObjective] = useState<string | undefined>(
    undefined,
  )
  const [error, setError] = useState<string>('')
  const [input, setInput] = useState<string>('')
  const [cursorOffset, setCursorOffset] = useState<number>(0)
  const messagesRef = useRef<GuidedGoalMessage[]>([])
  const turnCountRef = useRef<number>(0)
  const abortRef = useRef<AbortController | null>(null)

  function finalize(objective: string): void {
    setPhase('finalizing')
    try {
      const runtime = getGoalRuntime(sessionId)
      const created = runtime.createGoal({ objective })
      onDone(`Goal set: "${created.goal.objective}"`, {
        display: 'system',
        nextInput: created.goal.objective,
        submitNextInput: true,
      })
    } catch (e) {
      setError(`Could not set goal: ${errorMessage(e)}`)
      setPhase('error')
    }
  }

  function runTurn(): void {
    setPhase('loading')
    const abort = createAbortController()
    abortRef.current = abort
    void (async () => {
      try {
        const result = await runGuidedGoalTurn({
          messages: messagesRef.current,
          signal: abort.signal,
        })
        if (abort.signal.aborted) return
        if (result.kind === 'question' && result.objective) {
          setDraftObjective(result.objective)
        }
        if (result.kind === 'ready') {
          finalize(result.objective)
          return
        }
        // kind === 'question'
        if (turnCountRef.current >= MAX_TURNS) {
          // Out of interview budget — use the best-effort draft if available.
          if (result.objective) finalize(result.objective)
          else if (draftObjective) finalize(draftObjective)
          else {
            setError(
              'Could not converge on an objective. Try /goal <objective> directly.',
            )
            setPhase('error')
          }
          return
        }
        messagesRef.current = [
          ...messagesRef.current,
          { role: 'assistant', content: result.question },
        ]
        setQuestion(result.question)
        setInput('')
        setCursorOffset(0)
        setPhase('asking')
      } catch (e) {
        if (abort.signal.aborted) return
        setError(errorMessage(e) || 'Guided goal failed')
        setPhase('error')
      }
    })()
  }

  // Seed the transcript with the rough idea (if any) and run the first turn.
  useEffect(() => {
    if (initialIdea.trim()) {
      messagesRef.current = [{ role: 'user', content: initialIdea.trim() }]
    }
    runTurn()
    return () => abortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleSubmit(value: string): void {
    const answer = value.trim()
    if (!answer) {
      // Empty answer: finish with the current best-effort draft, else cancel.
      if (draftObjective) finalize(draftObjective)
      else onDone('Guided goal cancelled.', { display: 'system' })
      return
    }
    messagesRef.current = [
      ...messagesRef.current,
      { role: 'user', content: answer },
    ]
    turnCountRef.current += 1
    runTurn()
  }

  const width = Math.max(20, Math.min(columns - 4, 100))

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      <Box>
        <Text color="suggestion" bold>
          /guided-goal{' '}
        </Text>
        <Text dimColor>defining a persistent objective</Text>
      </Box>
      {phase === 'loading' || phase === 'finalizing' ? (
        <Box marginTop={1}>
          <Text color="suggestion">
            {phase === 'finalizing' ? 'Setting goal…' : 'Thinking…'}
          </Text>
        </Box>
      ) : null}
      {phase === 'error' ? (
        <Box marginTop={1}>
          <Text color="error">{error}</Text>
        </Box>
      ) : null}
      {phase === 'asking' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>{question}</Text>
          {draftObjective ? (
            <Box marginTop={1}>
              <Text dimColor>draft: {draftObjective}</Text>
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Text color="suggestion">{'> '}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              focus={true}
              showCursor={true}
              columns={width}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Enter to answer · empty Enter to finish with the current draft ·
              Ctrl+C to abort
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args: string,
): Promise<React.ReactNode> {
  return <GuidedGoalInterview initialIdea={args ?? ''} onDone={onDone} />
}
