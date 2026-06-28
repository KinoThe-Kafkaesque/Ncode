/**
 * Autoresearch data types (ported from oh-my-pi `autoresearch/types.ts`).
 *
 * Autoresearch mode is an autonomous experiment loop: the agent builds a
 * benchmark harness (`./autoresearch.sh`), then iterates — change code, run the
 * benchmark, log the result honestly — keeping improvements (`keep` → commit)
 * and reverting regressions (`discard`/`crash`/`checks_failed` → revert) until
 * the user interrupts or a per-segment iteration cap is reached.
 *
 * Faithful-port notes vs oh-my-pi:
 * - ncode has no sqlite. The session+run schema below is persisted as a single
 *   JSON store per project (see `storage.ts`), not a SQLite DB.
 * - The extension/dashboard/SessionEntry plumbing types are dropped; ncode wires
 *   the loop through its own attachment/tool/command/REPL primitives.
 */

export type MetricDirection = 'lower' | 'higher'
export type ExperimentStatus = 'keep' | 'discard' | 'crash' | 'checks_failed'

export type ASIValue =
  | string
  | number
  | boolean
  | null
  | ASIValue[]
  | { [key: string]: ASIValue }

export interface ASIData {
  [key: string]: ASIValue
}

export interface NumericMetricMap {
  [key: string]: number
}

export interface MetricDef {
  name: string
  unit: string
}

export interface ExperimentResult {
  runNumber: number | null
  commit: string
  metric: number
  metrics: NumericMetricMap
  status: ExperimentStatus
  description: string
  timestamp: number
  segment: number
  confidence: number | null
  asi?: ASIData
  modifiedPaths: string[]
  scopeDeviations: string[]
  justification: string | null
  flagged: boolean
  flaggedReason: string | null
}

export interface ExperimentState {
  results: ExperimentResult[]
  bestMetric: number | null
  bestDirection: MetricDirection
  metricName: string
  metricUnit: string
  secondaryMetrics: MetricDef[]
  name: string | null
  goal: string | null
  currentSegment: number
  maxExperiments: number | null
  confidence: number | null
  scopePaths: string[]
  offLimits: string[]
  constraints: string[]
  notes: string
  branch: string | null
  baselineCommit: string | null
}

export interface PendingRunSummary {
  command: string
  durationSeconds: number | null
  parsedAsi: ASIData | null
  parsedMetrics: NumericMetricMap | null
  parsedPrimary: number | null
  passed: boolean
  preRunDirtyPaths: string[]
  runDirectory: string
  runNumber: number
  exitCode: number | null
  timedOut: boolean
}

export interface RunningExperiment {
  startedAt: number
  command: string
  runDirectory: string
  runNumber: number
}

/**
 * Holds the run result between `run_experiment` and `log_experiment`.
 * Populated when a run finishes and consumed when the result is logged.
 */
export interface PendingRunResult {
  runNumber: number
  command: string
  durationMs: number | null
  exitCode: number | null
  timedOut: boolean
  parsedPrimary: number | null
  parsedMetrics: NumericMetricMap | null
  parsedAsi: ASIData | null
  passed: boolean
  preRunDirtyPaths: string[]
  checksPass: boolean | null
  checksOutput: string
  checksDuration: number
}

/**
 * Per-session live runtime state (mirrors oh-my-pi `AutoresearchRuntime`).
 *
 * `autoresearchMode` is the EFFECTIVE flag (desired mode AND on the recorded
 * autoresearch branch); it is refreshed by the per-turn context getter and read
 * synchronously by tool `isEnabled()`. `desiredMode` is what the user toggled.
 */
export interface AutoresearchRuntime {
  desiredMode: boolean
  autoresearchMode: boolean
  autoResumeArmed: boolean
  lastAutoResumePendingRunNumber: number | null
  goal: string | null
  branch: string | null
  lastRunResult: PendingRunResult | null
  runningExperiment: { startedAt: number; command: string } | null
}

/** Control sidecar persisted per session (survives restart). */
export interface AutoresearchControlState {
  mode: boolean
  goal: string | null
  branch: string | null
}
