import { useEffect, useState, type ReactNode } from 'react'
import { Box, Text, useTheme } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { isAutoresearchModeActive } from '../autoresearch/index.js'
import {
  buildExperimentState,
  computeConfidence,
  currentResults,
  findBaselineMetric,
  findBestKeptMetric,
} from '../autoresearch/state.js'
import { formatNum } from '../autoresearch/helpers.js'
import type {
  ExperimentState,
  ExperimentStatus,
} from '../autoresearch/types.js'
import { getCwd } from '../utils/cwd.js'

const REFRESH_INTERVAL_MS = 2000
const DESCRIPTION_MAX_WIDTH = 40

type StatusColor =
  | 'success'
  | 'warning'
  | 'error'
  | 'ansi:magenta'

const STATUS_COLORS: Record<ExperimentStatus, StatusColor> = {
  keep: 'success',
  discard: 'warning',
  crash: 'error',
  checks_failed: 'ansi:magenta',
}

function statusLabel(status: ExperimentStatus): string {
  switch (status) {
    case 'checks_failed':
      return 'checks_failed'
    default:
      return status
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function padEnd(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width)
  return text + ' '.repeat(width - text.length)
}

function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

function formatConfidence(value: number | null): string {
  if (value === null) return '—'
  return value.toFixed(2)
}

/**
 * Delta of a run's metric vs the baseline, as a percentage of the baseline.
 * Positive means the metric went up; negative means it went down.
 */
function deltaPercent(metric: number, baseline: number): number {
  if (baseline === 0) return 0
  return ((metric - baseline) / baseline) * 100
}

type DeltaKind = 'improvement' | 'regression' | 'neutral'

function classifyDelta(
  metric: number,
  baseline: number,
  direction: ExperimentState['bestDirection'],
): DeltaKind {
  if (metric === baseline) return 'neutral'
  const lowerIsBetter = direction === 'lower'
  const wentDown = metric < baseline
  if (lowerIsBetter) return wentDown ? 'improvement' : 'regression'
  return wentDown ? 'regression' : 'improvement'
}

function SectionLabel({ label }: { label: string }): ReactNode {
  return (
    <Text bold color="subtle">
      {label}
    </Text>
  )
}

export function AutoresearchDashboard(props: {
  onClose: () => void
}): ReactNode {
  const { onClose } = props
  const [themeName] = useTheme()
  void themeName
  const [state, setState] = useState<ExperimentState | null>(null)
  const [modeActive, setModeActive] = useState<boolean>(false)

  useKeybinding('confirm:no', onClose)

  useEffect(() => {
    const refresh = (): void => {
      setState(buildExperimentState(getCwd()))
      setModeActive(isAutoresearchModeActive())
    }
    refresh()
    const handle = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => clearInterval(handle)
  }, [])

  if (state === null) {
    return (
      <Box flexDirection="column" paddingX={2}>
        <Text bold>Autoresearch Dashboard</Text>
        <Text dimColor>Loading experiment state…</Text>
      </Box>
    )
  }

  const segment = state.currentSegment
  const segmentResults = currentResults(state.results, segment)
  const baseline = findBaselineMetric(state.results, segment)
  const bestKept = findBestKeptMetric(state.results, segment, state.bestDirection)
  const confidence = computeConfidence(
    state.results,
    segment,
    state.bestDirection,
  )
  const runCount = segmentResults.length
  const maxExperiments = state.maxExperiments

  const improvementPct =
    baseline !== null && bestKept !== null && baseline !== 0
      ? ((bestKept - baseline) / baseline) * 100
      : null

  // Most recent first, capped at 10.
  const recentRuns = segmentResults.slice(-10).reverse()

  const hasScopeInfo =
    state.scopePaths.length > 0 ||
    state.offLimits.length > 0 ||
    state.constraints.length > 0

  return (
    <Box flexDirection="column" paddingX={2}>
      {/* Header */}
      <Box flexDirection="column">
        <Text bold>Autoresearch Dashboard</Text>
        {state.name ? (
          <Text>
            <Text dimColor>experiment: </Text>
            <Text bold>{state.name}</Text>
          </Text>
        ) : null}
        {state.goal ? (
          <Text>
            <Text dimColor>goal: </Text>
            {state.goal}
          </Text>
        ) : null}
      </Box>

      <Text> </Text>

      {/* Status line */}
      <Box flexDirection="column">
        <SectionLabel label="Status" />
        <Text>
          <Text dimColor>mode: </Text>
          <Text color={modeActive ? 'success' : 'inactive'} bold>
            {modeActive ? 'on' : 'off'}
          </Text>
          <Text dimColor> · branch: </Text>
          {state.branch ?? '—'}
          <Text dimColor> · segment: </Text>
          {String(segment)}
          <Text dimColor> · runs: </Text>
          {String(runCount)}
          {maxExperiments !== null ? ` / ${maxExperiments}` : ''}
          <Text dimColor> · confidence: </Text>
          {formatConfidence(confidence ?? state.confidence)}
        </Text>
      </Box>

      <Text> </Text>

      {/* Metrics summary */}
      <Box flexDirection="column">
        <SectionLabel label="Metrics" />
        <Text>
          <Text dimColor>primary: </Text>
          <Text bold>{state.metricName}</Text>
          {state.metricUnit ? (
            <Text dimColor> [{state.metricUnit}]</Text>
          ) : null}
          <Text dimColor> · direction: </Text>
          {state.bestDirection === 'lower' ? 'lower is better' : 'higher is better'}
        </Text>
        <Text>
          <Text dimColor>baseline: </Text>
          {formatNum(baseline, state.metricUnit)}
          <Text dimColor> · best kept: </Text>
          <Text color="success">{formatNum(bestKept, state.metricUnit)}</Text>
          <Text dimColor> · improvement: </Text>
          {improvementPct === null ? (
            '—'
          ) : (
            <Text
              color={
                improvementPct === 0
                  ? undefined
                  : state.bestDirection === 'lower'
                    ? improvementPct < 0
                      ? 'success'
                      : 'error'
                    : improvementPct > 0
                      ? 'success'
                      : 'error'
              }
            >
              {formatPercent(improvementPct)}
            </Text>
          )}
        </Text>
      </Box>

      <Text> </Text>

      {/* Run history */}
      <Box flexDirection="column">
        <SectionLabel label="Run history (last 10 in current segment)" />
        {recentRuns.length === 0 ? (
          <Text dimColor>
            No runs yet — Phase 1 harness setup may still be in progress.
          </Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>
              {padEnd('Run', 5)}{padEnd('Status', 14)}{padEnd('Metric', 13)}
              {padEnd('Delta', 9)}Description
            </Text>
            <Text dimColor>
              {'----+---------+-----------+--------+--------------------'}
              {'------------------------------------'}
            </Text>
            {recentRuns.map(result => {
              const runLabel =
                result.runNumber !== null ? String(result.runNumber) : '?'
              const delta =
                baseline !== null
                  ? deltaPercent(result.metric, baseline)
                  : 0
              const deltaKind =
                baseline !== null
                  ? classifyDelta(result.metric, baseline, state.bestDirection)
                  : 'neutral'
              const deltaColor =
                deltaKind === 'improvement'
                  ? 'success'
                  : deltaKind === 'regression'
                    ? 'error'
                    : undefined
              return (
                <Box key={`${result.runNumber ?? 'x'}-${result.timestamp}`} flexDirection="row">
                  <Text>{padEnd(runLabel, 5)}</Text>
                  <Text color={STATUS_COLORS[result.status]}>
                    {padEnd(statusLabel(result.status), 14)}
                  </Text>
                  <Text>{padEnd(formatNum(result.metric, state.metricUnit), 13)}</Text>
                  <Text color={deltaColor} dimColor={deltaKind === 'neutral'}>
                    {padEnd(
                      baseline !== null ? formatPercent(delta) : '—',
                      9,
                    )}
                  </Text>
                  <Text>{truncate(result.description, DESCRIPTION_MAX_WIDTH)}</Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>

      {hasScopeInfo ? <Text> </Text> : null}

      {/* Scope & constraints */}
      {hasScopeInfo ? (
        <Box flexDirection="column">
          <SectionLabel label="Scope & constraints" />
          {state.scopePaths.length > 0 ? (
            <Text>
              <Text dimColor>scope: </Text>
              {state.scopePaths.join(', ')}
            </Text>
          ) : null}
          {state.offLimits.length > 0 ? (
            <Text>
              <Text dimColor>off-limits: </Text>
              <Text color="warning">{state.offLimits.join(', ')}</Text>
            </Text>
          ) : null}
          {state.constraints.length > 0 ? (
            <Box flexDirection="column">
              <Text dimColor>constraints:</Text>
              {state.constraints.map((constraint: string, index: number) => (
                <Text key={index}>
                  {'  • '}
                  {constraint}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null}

      <Text> </Text>

      {/* Footer */}
      <Text dimColor>Press Esc to close · ctrl+shift+a to toggle</Text>
    </Box>
  )
}
