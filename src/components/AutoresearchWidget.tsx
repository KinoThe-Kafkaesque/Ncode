/**
 * AutoresearchWidget — compact 1-row Ink status bar shown while autoresearch
 * mode is active. Displays experiment name, run count, best metric, confidence,
 * and a running spinner. ctrl+shift+a opens the fullscreen dashboard.
 */

import * as React from 'react'
import { Box, Text, useInput, useTheme } from '../ink.js'
import { getAutoresearchRuntime, isAutoresearchModeActive } from '../autoresearch/index.js'
import {
  buildExperimentState,
  currentResults,
  findBestKeptMetric,
} from '../autoresearch/state.js'
import type { AutoresearchRuntime, ExperimentState } from '../autoresearch/types.js'
import { getCwd } from '../utils/cwd.js'
import { getTheme } from '../utils/theme.js'

const SPINNER_FRAMES = ['|', '/', '-', '\\']

type Props = { onOpenDashboard: () => void }

export function AutoresearchWidget({ onOpenDashboard }: Props): React.ReactNode | null {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const [tick, setTick] = React.useState(0)
  const [runtime, setRuntime] = React.useState<AutoresearchRuntime | null>(null)
  const [state, setState] = React.useState<ExperimentState | null>(null)

  React.useEffect(() => {
    const refresh = (): void => {
      if (!isAutoresearchModeActive()) {
        setRuntime(null)
        setState(null)
        return
      }
      setRuntime(getAutoresearchRuntime())
      try {
        setState(buildExperimentState(getCwd()))
      } catch {
        setState(null)
      }
    }
    refresh()
    const id = setInterval(() => {
      setTick((prev: number) => prev + 1)
      refresh()
    }, 1000)
    return () => clearInterval(id)
  }, [])

  useInput((input, key) => {
    if (input === 'a' && key.ctrl && key.shift) {
      onOpenDashboard()
    }
  })

  if (!runtime || !state) {
    return null
  }

  const running = runtime.runningExperiment != null
  const icon = running ? SPINNER_FRAMES[tick % SPINNER_FRAMES.length] : '⚙'
  const segmentResults = currentResults(state.results, state.currentSegment)
  const runCount = segmentResults.length
  const maxExperiments = state.maxExperiments ?? '∞'
  const bestMetric = findBestKeptMetric(
    state.results,
    state.currentSegment,
    state.bestDirection,
  )
  const directionArrow = state.bestDirection === 'lower' ? '↓' : '↑'
  const confidence =
    state.confidence != null ? `${Math.round(state.confidence * 100)}%` : null
  const hasPendingRun = runtime.lastRunResult != null

  return (
    <Box flexDirection="row" height={1} flexShrink={0} gap={1}>
      <Text color={theme.claude}>{icon}</Text>
      <Text>
        <Text color={theme.subtle}>{state.name ?? 'unnamed'}</Text>
        <Text color={theme.subtle}>#{state.currentSegment}</Text>
      </Text>
      <Text>
        <Text color={theme.subtle}>runs </Text>
        <Text color={theme.text}>
          {runCount}/{maxExperiments}
        </Text>
      </Text>
      {bestMetric != null && (
        <Text>
          <Text color={theme.subtle}>best </Text>
          <Text color={theme.text}>
            {bestMetric}
            {state.metricUnit}
            {directionArrow}
          </Text>
        </Text>
      )}
      {confidence != null && (
        <Text>
          <Text color={theme.subtle}>conf </Text>
          <Text color={theme.text}>{confidence}</Text>
        </Text>
      )}
      {hasPendingRun && <Text color={theme.warning}>⚠ unlogged run</Text>}
    </Box>
  )
}
