import * as React from 'react'
import { Box, Text } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'

export function OrchestrationStatusBar(): React.ReactNode {
  const orchestrationActive = useAppState(s => s.orchestrationActive)
  const tasks = useAppState(s => s.tasks)

  if (!orchestrationActive) return null

  const agentTasks = Object.values(tasks).filter(isLocalAgentTask)
  const running = agentTasks.filter(t => t.status === 'running').length
  const completed = agentTasks.filter(t => t.status === 'completed').length
  const failed = agentTasks.filter(t => t.status === 'failed' || t.status === 'killed').length
  const total = agentTasks.length

  // Don't render if no agent tasks have been spawned yet
  if (total === 0) return null

  const allDone = running === 0

  return (
    <Box paddingLeft={1} flexDirection="row">
      <Text dimColor>
        {allDone ? 'orchestration complete' : 'orchestrating'}{' '}
        <Text bold>{completed + failed}</Text>/<Text bold>{total}</Text> agents
        {running > 0 && <> · <Text bold>{running}</Text> running</>}
        {failed > 0 && <> · <Text color="error">{failed} failed</Text></>}
      </Text>
    </Box>
  )
}
