/**
 * log_experiment — record the result of the latest run_experiment.
 *
 * Ported from oh-my-pi `autoresearch/tools/log-experiment.ts` (arktype → zod).
 * Records metric/secondary-metrics/ASI/modified-paths/scope-deviations, computes
 * MAD confidence, and applies the git outcome: `keep` → stage+commit the modified
 * files; `discard`/`crash`/`checks_failed` → revert (reset --hard HEAD on an
 * autoresearch branch, else restore/clean only the run-modified paths). `flag_runs`
 * excludes earlier runs from baseline/best math. The per-segment iteration cap
 * turns mode off via `disableAutoresearchMode`.
 */

import * as React from 'react'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import {
  disableAutoresearchMode,
  markAutoResumeArmed,
} from '../../autoresearch/index.js'
import { isAutoresearchToolAvailable } from '../../autoresearch/index.js'
import {
  clean,
  commit,
  computeRunModifiedPaths,
  diffHasCached,
  getCurrentAutoresearchBranch,
  headSha,
  parseWorkDirDirtyPaths,
  resetHard,
  restore,
  stageFiles,
  tryGitPrefix,
  tryGitStatus,
} from '../../autoresearch/git.js'
import {
  ensureNumericMetricMap,
  formatNum,
  mergeAsi,
  pathMatchesSpec,
  sanitizeAsi,
} from '../../autoresearch/helpers.js'
import {
  buildExperimentState,
  computeConfidence,
  currentResults,
  findBaselineSecondary,
  findBestKeptMetric,
} from '../../autoresearch/state.js'
import type { SessionRow } from '../../autoresearch/storage.js'
import type {
  ASIData,
  ExperimentResult,
  ExperimentState,
  NumericMetricMap,
} from '../../autoresearch/types.js'
import { getCwd } from '../../utils/cwd.js'
import { Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { NO_SESSION_ERROR, resolveActiveSession } from './shared.js'

const inputSchema = () =>
  z.strictObject({
    metric: z.number().describe('primary metric value'),
    status: z.enum(['keep', 'discard', 'crash', 'checks_failed']).describe('run outcome'),
    description: z.string().describe('short run description'),
    metrics: z.record(z.string(), z.number()).optional().describe('secondary metrics'),
    asi: z.record(z.string(), z.unknown()).optional().describe('free-form structured metadata'),
    commit: z.string().optional().describe('override recorded commit hash'),
    justification: z
      .string()
      .optional()
      .describe('required when keeping a scope-deviating run'),
    flag_runs: z
      .array(
        z.object({
          run_id: z.number().int().describe('run id to flag'),
          reason: z.string().describe('why this run is suspect'),
        }),
      )
      .optional()
      .describe('flag earlier runs as suspect'),
  })
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = () => z.object({ text: z.string() }).passthrough()
type OutputSchema = ReturnType<typeof outputSchema>
type Output = { text: string }

export const LogExperimentTool: Tool<InputSchema, Output> = buildTool({
  name: 'log_experiment',
  searchHint: 'log the latest run_experiment result (keep commits, discard reverts)',
  maxResultSizeChars: 8_000,
  async description() {
    return 'Log the result of the latest run_experiment. Records the metric, optional ASI metadata, modified paths, and scope deviations. On `keep`, modified files are committed; on `discard`/`crash`/`checks_failed`, the worktree is reverted. Pass `flag_runs` to mark earlier runs as suspect.'
  },
  async prompt() {
    return 'Log the latest run. `keep` commits the modified files; `discard`/`crash`/`checks_failed` revert them. Files outside `scope_paths` or inside `off_limits` are recorded as scope deviations; pass `justification` to keep a deviating run. Pass `flag_runs: [{run_id, reason}]` to exclude earlier runs from baseline/best math.'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Log Experiment'
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
    return `log_experiment ${input?.status ?? ''} ${input?.description ?? ''}`.trim()
  },
  renderToolResultMessage(output: Output) {
    return React.createElement(Text, {}, output.text)
  },
  async call(input: Input, context) {
    if (context.agentId) {
      throw new Error('log_experiment cannot be used in agent contexts')
    }
    const cwd = getCwd()
    const { store, session } = await resolveActiveSession()
    if (!store || !session) {
      return { data: { text: NO_SESSION_ERROR } }
    }
    const pendingRun = store.getPendingRun(session.id)
    if (!pendingRun) {
      return { data: { text: 'Error: no pending run available. Run run_experiment first.' } }
    }

    const flaggedRuns: Array<{ runId: number; reason: string }> = []
    for (const flag of input.flag_runs ?? []) {
      const target = store.getRunById(flag.run_id)
      if (!target || target.sessionId !== session.id) continue
      await store.flagRun(flag.run_id, flag.reason)
      flaggedRuns.push({ runId: flag.run_id, reason: flag.reason })
    }

    const branchName = await getCurrentAutoresearchBranch()
    const onAutoresearchBranch = branchName !== null

    let allModified: string[]
    if (onAutoresearchBranch) {
      const statusText = await tryGitStatus()
      const workDirPrefix = await tryGitPrefix()
      allModified = parseWorkDirDirtyPaths(statusText, workDirPrefix)
    } else {
      const { tracked, untracked } = await detectModifiedPaths(pendingRun.preRunDirtyPaths)
      allModified = [...tracked, ...untracked]
    }
    const scopeDeviations = computeScopeDeviations(allModified, session)

    const justification = input.justification?.trim() || null
    const warnings: string[] = []

    const headSha0 = await headSha()
    const explicitCommit = input.commit?.trim()
    let commitHash = explicitCommit && explicitCommit.length > 0 ? explicitCommit : headSha0

    let gitNote: string | null = null
    if (input.status === 'keep') {
      if (onAutoresearchBranch && allModified.length > 0) {
        const commitResult = await commitKeptExperiment(
          input.description,
          input.status,
          input.metric,
          input.metrics ?? {},
          allModified,
          session.primaryMetric,
        )
        if (commitResult.error) {
          return { data: { text: `Error: ${commitResult.error}` } }
        }
        gitNote = commitResult.note ?? null
        const newSha = await headSha()
        if (newSha) commitHash = newSha
      } else if (!onAutoresearchBranch) {
        warnings.push(
          'Auto-commit skipped: not on a dedicated autoresearch branch. Modified files remain in the worktree.',
        )
      } else if (allModified.length === 0) {
        gitNote = 'nothing to commit'
      }
      if (scopeDeviations.length > 0) {
        if (justification === null) {
          warnings.push(
            `Kept with unjustified scope deviations: ${scopeDeviations.join(', ')}. Pass \`justification\` next time or \`flag_runs\` this entry on a future log_experiment if it was a mistake.`,
          )
        } else {
          warnings.push(`Kept with scope deviations (justified): ${scopeDeviations.join(', ')}`)
        }
      }
    } else {
      const revertResult = await revertFailedExperiment(
        cwd,
        pendingRun.preRunDirtyPaths,
        onAutoresearchBranch,
      )
      if (revertResult.error) {
        return { data: { text: `Error: ${revertResult.error}` } }
      }
      gitNote = revertResult.note ?? null
    }

    const metric = input.metric
    const secondaryMetrics = mergeMetrics(
      pendingRun.parsedMetrics,
      input.metrics,
      session.primaryMetric,
    )
    const asi = mergeAsi(pendingRun.parsedAsi, sanitizeAsi(input.asi))

    if (pendingRun.parsedPrimary !== null && metric !== pendingRun.parsedPrimary) {
      warnings.push(
        `Logged metric ${metric} differs from parsed primary ${pendingRun.parsedPrimary}. Both values stored.`,
      )
    }

    const loggedAt = Date.now()
    const tentativeRun = await store.markRunLogged({
      runId: pendingRun.id,
      status: input.status,
      description: input.description,
      metric,
      metrics: secondaryMetrics,
      asi: asi ?? null,
      commitHash,
      confidence: null,
      modifiedPaths: allModified,
      scopeDeviations,
      justification,
      loggedAt,
    })

    const refreshedSession = store.getSessionById(session.id) ?? session
    const stateForConfidence = buildExperimentState(
      refreshedSession,
      store.listLoggedRuns(session.id),
    )
    const confidence = computeConfidence(
      stateForConfidence.results,
      stateForConfidence.currentSegment,
      stateForConfidence.bestDirection,
    )
    await store.updateRunConfidence(tentativeRun.id, confidence)

    const finalState = buildExperimentState(refreshedSession, store.listLoggedRuns(session.id))
    markAutoResumeArmed()

    const experiment: ExperimentResult = {
      runNumber: tentativeRun.id,
      commit: (commitHash ?? '').slice(0, 12),
      metric,
      metrics: secondaryMetrics,
      status: input.status,
      description: input.description,
      timestamp: loggedAt,
      segment: pendingRun.segment,
      confidence,
      asi,
      modifiedPaths: allModified,
      scopeDeviations,
      justification,
      flagged: false,
      flaggedReason: null,
    }

    const segmentRunCount = currentResults(finalState.results, finalState.currentSegment).length
    if (finalState.maxExperiments !== null && segmentRunCount >= finalState.maxExperiments) {
      disableAutoresearchMode()
    }

    const wallClockSeconds = pendingRun.durationMs !== null ? pendingRun.durationMs / 1000 : null
    const text = buildLogText(
      finalState,
      experiment,
      segmentRunCount,
      wallClockSeconds,
      gitNote,
      warnings,
      flaggedRuns,
    )

    return { data: { text } }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.text,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

interface KeepCommitResult {
  error?: string
  note?: string
}

async function commitKeptExperiment(
  description: string,
  status: ExperimentResult['status'],
  metric: number,
  metrics: NumericMetricMap,
  files: string[],
  primaryMetric: string,
): Promise<KeepCommitResult> {
  if (files.length === 0) return { note: 'nothing to commit' }
  try {
    await stageFiles(files)
  } catch (err) {
    return { error: `git add failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!(await diffHasCached(files))) {
    return { note: 'nothing to commit' }
  }
  const payload: { [key: string]: string | number } = {
    status,
    [primaryMetric]: metric,
  }
  for (const [name, value] of Object.entries(metrics)) {
    payload[name] = value
  }
  const commitMessage = `${description}\n\nResult: ${JSON.stringify(payload)}`
  try {
    const commitResult = await commit(commitMessage, { files })
    const summary = `${commitResult.stdout}${commitResult.stderr}`
      .split('\n')
      .find(line => line.trim().length > 0)
    return { note: summary?.trim() ?? 'committed' }
  } catch (err) {
    return { error: `git commit failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function revertFailedExperiment(
  cwd: string,
  preRunDirtyPaths: string[],
  onAutoresearchBranch: boolean,
): Promise<KeepCommitResult> {
  if (onAutoresearchBranch) {
    // Discard reverts only the current iteration's uncommitted changes — never
    // rewinds prior `keep` commits. Reset to HEAD so kept improvements survive.
    try {
      await resetHard('HEAD')
      await clean()
      return { note: 'worktree reset to HEAD' }
    } catch (err) {
      return {
        error: `git reset/clean failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  const statusText = await tryGitStatus()
  const workDirPrefix = await tryGitPrefix()
  const { tracked, untracked } = computeRunModifiedPaths(
    preRunDirtyPaths,
    statusText,
    workDirPrefix,
  )
  const total = tracked.length + untracked.length
  if (total === 0) return { note: 'nothing to revert' }
  if (tracked.length > 0) {
    try {
      await restore(tracked)
    } catch (err) {
      return { error: `git restore failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
  for (const filePath of untracked) {
    try {
      rmSync(join(cwd, filePath), { force: true, recursive: true })
    } catch {
      // best effort
    }
  }
  return { note: `reverted ${total} file${total === 1 ? '' : 's'}` }
}

async function detectModifiedPaths(
  preRunDirtyPaths: string[],
): Promise<{ tracked: string[]; untracked: string[] }> {
  const statusText = await tryGitStatus()
  const workDirPrefix = await tryGitPrefix()
  return computeRunModifiedPaths(preRunDirtyPaths, statusText, workDirPrefix)
}

function computeScopeDeviations(modifiedPaths: string[], session: SessionRow): string[] {
  const deviations: string[] = []
  for (const filePath of modifiedPaths) {
    if (session.offLimits.some(spec => pathMatchesSpec(filePath, spec))) {
      deviations.push(filePath)
      continue
    }
    if (
      session.scopePaths.length > 0 &&
      !session.scopePaths.some(spec => pathMatchesSpec(filePath, spec))
    ) {
      deviations.push(filePath)
    }
  }
  return deviations
}

function mergeMetrics(
  parsed: NumericMetricMap | null,
  overrides: NumericMetricMap | undefined,
  primaryMetricName: string,
): NumericMetricMap {
  const merged: NumericMetricMap = {}
  for (const [name, value] of Object.entries(parsed ?? {})) {
    if (name === primaryMetricName) continue
    merged[name] = value
  }
  for (const [name, value] of Object.entries(ensureNumericMetricMap(overrides))) {
    merged[name] = value
  }
  return merged
}

function buildLogText(
  state: ExperimentState,
  experiment: ExperimentResult,
  segmentRunCount: number,
  wallClockSeconds: number | null,
  gitNote: string | null,
  warnings: string[],
  flaggedRuns: Array<{ runId: number; reason: string }>,
): string {
  const displayRunNumber = experiment.runNumber ?? state.results.length
  const lines = [`Logged run #${displayRunNumber}: ${experiment.status} - ${experiment.description}`]
  if (wallClockSeconds !== null) {
    lines.push(`Wall clock: ${wallClockSeconds.toFixed(1)}s`)
  }
  if (state.bestMetric !== null) {
    lines.push(`Baseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`)
  }
  if (segmentRunCount > 1 && state.bestMetric !== null && experiment.metric !== state.bestMetric) {
    const delta = ((experiment.metric - state.bestMetric) / state.bestMetric) * 100
    const sign = delta > 0 ? '+' : ''
    lines.push(`This run: ${formatNum(experiment.metric, state.metricUnit)} (${sign}${delta.toFixed(1)}%)`)
  } else {
    lines.push(`This run: ${formatNum(experiment.metric, state.metricUnit)}`)
  }
  if (Object.keys(experiment.metrics).length > 0) {
    const baselineSecondary = findBaselineSecondary(
      state.results,
      state.currentSegment,
      state.secondaryMetrics,
    )
    const parts = Object.entries(experiment.metrics).map(([name, value]) => {
      const unit = state.secondaryMetrics.find(metric => metric.name === name)?.unit ?? ''
      const baseline = baselineSecondary[name]
      if (baseline === undefined || baseline === 0 || segmentRunCount === 1) {
        return `${name}: ${formatNum(value, unit)}`
      }
      const delta = ((value - baseline) / baseline) * 100
      const sign = delta > 0 ? '+' : ''
      return `${name}: ${formatNum(value, unit)} (${sign}${delta.toFixed(1)}%)`
    })
    lines.push(`Secondary metrics: ${parts.join('  ')}`)
  }
  const bestKept = findBestKeptMetric(state.results, state.currentSegment, state.bestDirection)
  if (bestKept !== null && state.bestMetric !== null && bestKept !== state.bestMetric) {
    lines.push(`Best kept ${state.metricName}: ${formatNum(bestKept, state.metricUnit)}`)
  }
  if (experiment.asi) {
    const asiSummary = Object.entries(experiment.asi)
      .map(([key, value]) => `${key}: ${truncateAsiValue(value)}`)
      .join(' | ')
    lines.push(`ASI: ${asiSummary}`)
  }
  if (state.confidence !== null) {
    const status =
      state.confidence >= 2 ? 'likely real' : state.confidence >= 1 ? 'marginal' : 'within noise'
    lines.push(`Confidence: ${state.confidence.toFixed(1)}x noise floor (${status})`)
  }
  if (gitNote) {
    lines.push(`Git: ${gitNote}`)
  }
  if (state.maxExperiments !== null) {
    lines.push(`Progress: ${segmentRunCount}/${state.maxExperiments} runs in current segment`)
    if (segmentRunCount >= state.maxExperiments) {
      lines.push(`Maximum experiments reached (${state.maxExperiments}). Autoresearch mode is now off.`)
    }
  }
  if (flaggedRuns.length > 0) {
    const formatted = flaggedRuns.map(({ runId, reason }) => `#${runId} (${reason})`).join(', ')
    lines.push(`Flagged: ${formatted}`)
  }
  for (const warning of warnings) {
    lines.push(`Warning: ${warning}`)
  }
  return lines.join('\n')
}

function truncateAsiValue(value: ASIData[string]): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}
