/**
 * Autoresearch state model (ported from oh-my-pi `autoresearch/state.ts`).
 *
 * Builds the in-memory `ExperimentState` from stored session+run rows, and
 * implements the segment/baseline model and the MAD-noise-floor confidence:
 *   - the baseline is the first non-flagged `keep` run in the current segment;
 *   - confidence (≥3 non-flagged runs) = |bestKept − baseline| / MAD, reported
 *     as a multiple of the observed noise floor.
 * `reconstructControlState`/`createRuntimeStore` are NOT ported — ncode persists
 * control state in a per-session sidecar and keeps the runtime map in `index.ts`.
 */

import { inferMetricUnitFromName, isBetter } from './helpers.js'
import { readJsonlContent } from './storage.js'
import { reconstructJsonlState, type ReconstructedJsonlState } from './jsonl.js'
import type {
  ExperimentResult,
  ExperimentState,
  MetricDef,
  MetricDirection,
  NumericMetricMap,
} from './types.js'

export function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: 'lower',
    metricName: 'metric',
    metricUnit: '',
    secondaryMetrics: [],
    name: null,
    goal: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
    scopePaths: [],
    offLimits: [],
    constraints: [],
    notes: '',
    branch: null,
    baselineCommit: null,
  }
}

export function cloneExperimentState(state: ExperimentState): ExperimentState {
  return {
    ...state,
    results: state.results.map(cloneResult),
    secondaryMetrics: state.secondaryMetrics.map(metric => ({ ...metric })),
    scopePaths: [...state.scopePaths],
    offLimits: [...state.offLimits],
    constraints: [...state.constraints],
  }
}

function cloneResult(result: ExperimentResult): ExperimentResult {
  return {
    ...result,
    metrics: { ...result.metrics },
    asi: result.asi ? structuredClone(result.asi) : undefined,
    modifiedPaths: [...result.modifiedPaths],
    scopeDeviations: [...result.scopeDeviations],
  }
}

export function currentResults(
  results: ExperimentResult[],
  segment: number,
): ExperimentResult[] {
  return results.filter(result => result.segment === segment)
}

export function findBaselineResult(
  results: ExperimentResult[],
  segment: number,
): ExperimentResult | null {
  return (
    currentResults(results, segment).find(
      result => result.status === 'keep' && !result.flagged,
    ) ?? null
  )
}

export function findBaselineMetric(
  results: ExperimentResult[],
  segment: number,
): number | null {
  const baseline = findBaselineResult(results, segment)
  return baseline ? baseline.metric : null
}

export function findBestKeptMetric(
  results: ExperimentResult[],
  segment: number,
  direction: MetricDirection,
): number | null {
  let best: number | null = null
  for (const result of currentResults(results, segment)) {
    if (result.status !== 'keep' || result.flagged) continue
    if (best === null || isBetter(result.metric, best, direction)) {
      best = result.metric
    }
  }
  return best
}

export function findBaselineRunNumber(
  results: ExperimentResult[],
  segment: number,
): number | null {
  const baseline = findBaselineResult(results, segment)
  if (!baseline) return null
  if (baseline.runNumber !== null) return baseline.runNumber
  const index = results.indexOf(baseline)
  return index >= 0 ? index + 1 : null
}

export function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics: MetricDef[],
): NumericMetricMap {
  const baseline = findBaselineResult(results, segment)
  const values: NumericMetricMap = baseline ? { ...baseline.metrics } : {}
  for (const metric of knownMetrics) {
    if (values[metric.name] !== undefined) continue
    for (const result of currentResults(results, segment)) {
      if (result.flagged) continue
      const value = result.metrics[metric.name]
      if (value !== undefined) {
        values[metric.name] = value
        break
      }
    }
  }
  return values
}

export function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const midpoint = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
  }
  return sorted[midpoint]!
}

export function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: MetricDirection,
): number | null {
  const current = currentResults(results, segment).filter(
    result => !result.flagged && result.metric > 0,
  )
  if (current.length < 3) return null

  const values = current.map(result => result.metric)
  const median = sortedMedian(values)
  const mad = sortedMedian(values.map(value => Math.abs(value - median)))
  if (mad === 0) return null

  const baseline = findBaselineMetric(results, segment)
  if (baseline === null) return null

  let bestKept: number | null = null
  for (const result of current) {
    if (result.status !== 'keep' || result.metric <= 0) continue
    if (bestKept === null || isBetter(result.metric, bestKept, direction)) {
      bestKept = result.metric
    }
  }
  if (bestKept === null || bestKept === baseline) return null

  return Math.abs(bestKept - baseline) / mad
}

export function buildExperimentState(workDir: string): ExperimentState {
  const state = createExperimentState()

  let reconstructed: ReconstructedJsonlState | null = null
  try {
    const content = readJsonlContent(workDir)
    if (content.length > 0) reconstructed = reconstructJsonlState(content)
  } catch {
    reconstructed = null
  }
  if (!reconstructed) return state

  state.name = reconstructed.name
  state.goal = reconstructed.goal
  state.metricName = reconstructed.metricName
  state.metricUnit = reconstructed.metricUnit
  state.bestDirection = reconstructed.bestDirection
  state.scopePaths = [...reconstructed.scopePaths]
  state.offLimits = [...reconstructed.offLimits]
  state.constraints = [...reconstructed.constraints]
  state.maxExperiments = reconstructed.maxIterations
  state.baselineCommit = reconstructed.baselineCommit
  state.currentSegment = reconstructed.currentSegment
  state.secondaryMetrics = reconstructed.secondaryMetrics.map(metric => ({
    name: metric.name,
    unit: metric.unit || inferMetricUnitFromName(metric.name),
  }))

  for (const run of reconstructed.results) {
    const result: ExperimentResult = {
      runNumber: run.run,
      commit: run.commit,
      metric: run.metric,
      metrics: run.metrics,
      status: run.status,
      description: run.description,
      timestamp: run.timestamp,
      segment: run.segment,
      confidence: run.confidence,
      asi: run.asi,
      modifiedPaths: run.modifiedPaths,
      scopeDeviations: run.scopeDeviations,
      justification: run.justification,
      flagged: run.flagged,
      flaggedReason: run.flaggedReason,
    }
    state.results.push(result)
    if (run.segment === state.currentSegment) {
      registerSecondaryMetrics(state.secondaryMetrics, result.metrics)
    }
  }

  state.bestMetric = findBaselineMetric(state.results, state.currentSegment)
  state.confidence = computeConfidence(
    state.results,
    state.currentSegment,
    state.bestDirection,
  )
  return state
}

function registerSecondaryMetrics(
  metrics: MetricDef[],
  values: NumericMetricMap,
): void {
  for (const name of Object.keys(values)) {
    if (metrics.some(metric => metric.name === name)) continue
    metrics.push({ name, unit: inferMetricUnitFromName(name) })
  }
}
