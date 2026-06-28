/**
 * run_experiment — run the benchmark harness (`bash autoresearch.sh`).
 *
 * Ported from oh-my-pi `autoresearch/tools/run-experiment.ts` (arktype → zod).
 * The command is fixed. Output is captured to `runs/<id4>/benchmark.log` and the
 * `METRIC name=value` / `ASI key=value` lines printed by the harness are parsed
 * back. ncode streams via `exec(...,'bash',{ timeout })` and awaits `.result`
 * (default 600s) instead of oh-my-pi's `executeBash`.
 */

import * as React from 'react'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import {
  markAutoResumeArmed,
  pendingRunSummaryFromRow,
} from '../../autoresearch/index.js'
import { isAutoresearchToolAvailable } from '../../autoresearch/index.js'
import { parseWorkDirDirtyPaths, tryGitPrefix, tryGitStatus } from '../../autoresearch/git.js'
import {
  EXPERIMENT_MAX_BYTES,
  EXPERIMENT_MAX_LINES,
  formatNum,
  parseAsiLines,
  parseMetricLines,
} from '../../autoresearch/helpers.js'
import { buildExperimentState } from '../../autoresearch/state.js'
import type { NumericMetricMap } from '../../autoresearch/types.js'
import { getCwd } from '../../utils/cwd.js'
import { exec } from '../../utils/Shell.js'
import { Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { DEFAULT_HARNESS_COMMAND, NO_SESSION_ERROR, resolveActiveSession } from './shared.js'

const DEFAULT_TIMEOUT_SECONDS = 600

const inputSchema = () =>
  z.strictObject({
    timeout_seconds: z.number().optional().describe('timeout in seconds (default 600)'),
  })
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = () => z.object({ text: z.string() }).passthrough()
type OutputSchema = ReturnType<typeof outputSchema>
type Output = { text: string }

export const RunExperimentTool: Tool<InputSchema, Output> = buildTool({
  name: 'run_experiment',
  searchHint: 'run the autoresearch benchmark harness (bash autoresearch.sh)',
  maxResultSizeChars: 16_000,
  async description() {
    return 'Run the benchmark (`bash autoresearch.sh`). Output is captured automatically; `METRIC name=value` and `ASI key=value` lines printed by the harness are parsed. The command is fixed.'
  },
  async prompt() {
    return 'Run the autoresearch benchmark harness (`bash autoresearch.sh`). The command is fixed. Output is captured and `METRIC name=value` / `ASI key=value` lines are parsed back to you. Pass `timeout_seconds` to bound the run (default 600).'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Run Experiment'
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
  renderToolUseMessage() {
    return `run_experiment ${DEFAULT_HARNESS_COMMAND}`
  },
  renderToolResultMessage(output: Output) {
    return React.createElement(Text, {}, output.text)
  },
  async call(input: Input, context) {
    if (context.agentId) {
      throw new Error('run_experiment cannot be used in agent contexts')
    }
    const cwd = getCwd()
    const { store, session } = await resolveActiveSession()
    if (!store || !session) {
      return { data: { text: NO_SESSION_ERROR } }
    }

    // Abandon any prior unlogged run before starting a new one.
    let abandonedPriorRun: number | null = null
    const pending = store.getPendingRun(session.id)
    if (pending) {
      await store.abandonPendingRuns(session.id)
      abandonedPriorRun = pending.id
    }

    const resolvedCommand = DEFAULT_HARNESS_COMMAND
    const preRunStatus = await tryGitStatus()
    const workDirPrefix = await tryGitPrefix()
    const preRunDirtyPaths = parseWorkDirDirtyPaths(preRunStatus, workDirPrefix)

    const startedAt = Date.now()
    const insertedRun = await store.insertRun({
      sessionId: session.id,
      segment: session.currentSegment,
      command: resolvedCommand,
      logPath: '',
      preRunDirtyPaths,
      startedAt,
    })

    const runDirectory = join(store.projectDir, 'runs', String(insertedRun.id).padStart(4, '0'))
    const benchmarkLogPath = join(runDirectory, 'benchmark.log')
    mkdirSync(runDirectory, { recursive: true })
    await store.updateRunLogPath(insertedRun.id, benchmarkLogPath)

    const timeoutMs = Math.max(
      0,
      Math.floor((input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
    )

    const shellCommand = await exec(resolvedCommand, context.abortController.signal, 'bash', {
      timeout: timeoutMs > 0 ? timeoutMs : undefined,
    })
    const result = await shellCommand.result
    try {
      shellCommand.cleanup()
    } catch {
      // best-effort
    }

    let stdout = result.stdout
    if (result.outputFilePath) {
      try {
        stdout = readFileSync(result.outputFilePath, 'utf8')
      } catch {
        // fall back to the in-memory stdout
      }
    }
    const output = [stdout, result.stderr]
      .filter(part => part && part.length > 0)
      .join('\n')
    writeFileSync(benchmarkLogPath, output, { mode: 0o600 })

    const completedAt = Date.now()
    const durationMs = completedAt - startedAt
    const durationSeconds = durationMs / 1000
    const exitCode = result.code
    const timedOut = result.interrupted

    const parsedMetricsMap = parseMetricLines(output)
    const parsedMetrics =
      parsedMetricsMap.size > 0 ? Object.fromEntries(parsedMetricsMap.entries()) : null
    const parsedPrimary = parsedMetricsMap.get(session.primaryMetric) ?? null
    const parsedAsi = parseAsiLines(output)

    await store.markRunCompleted({
      runId: insertedRun.id,
      completedAt,
      durationMs,
      exitCode,
      timedOut,
      parsedPrimary,
      parsedMetrics,
      parsedAsi,
    })

    markAutoResumeArmed()

    const refreshedSession = store.getSessionById(session.id) ?? session
    const state = buildExperimentState(refreshedSession, store.listLoggedRuns(session.id))
    void pendingRunSummaryFromRow(store.getPendingRun(session.id))

    const passed = exitCode === 0 && !timedOut
    const headerLines: string[] = []
    if (abandonedPriorRun !== null) {
      headerLines.push(
        `Note: abandoned prior pending run #${abandonedPriorRun} before starting this run.`,
      )
    }
    const warningPrefix = headerLines.length > 0 ? `${headerLines.join('\n')}\n\n` : ''
    const preview = truncateTail(output)

    const text =
      warningPrefix +
      buildRunText(
        {
          runNumber: insertedRun.id,
          runDirectory,
          exitCode,
          durationSeconds,
          passed,
          timedOut,
          parsedPrimary,
          parsedMetrics,
          parsedAsi,
          metricName: session.primaryMetric,
          metricUnit: session.metricUnit,
        },
        preview.content,
        state.bestMetric,
        preview.truncated ? benchmarkLogPath : null,
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

interface RunTextDetails {
  runNumber: number
  runDirectory: string
  exitCode: number
  durationSeconds: number
  passed: boolean
  timedOut: boolean
  parsedPrimary: number | null
  parsedMetrics: NumericMetricMap | null
  parsedAsi: Record<string, unknown> | null
  metricName: string
  metricUnit: string
}

function buildRunText(
  details: RunTextDetails,
  outputPreview: string,
  bestMetric: number | null,
  truncatedLogPath: string | null,
): string {
  const lines: string[] = []
  lines.push(`Run #${details.runNumber} directory: ${details.runDirectory}`)
  if (details.timedOut) {
    lines.push(`TIMEOUT after ${details.durationSeconds.toFixed(1)}s`)
  } else if (details.exitCode !== 0) {
    lines.push(`FAILED with exit code ${details.exitCode} in ${details.durationSeconds.toFixed(1)}s`)
  } else {
    lines.push(`PASSED in ${details.durationSeconds.toFixed(1)}s`)
  }
  if (bestMetric !== null) {
    lines.push(`Current baseline ${details.metricName}: ${formatNum(bestMetric, details.metricUnit)}`)
  }
  if (details.parsedPrimary !== null) {
    lines.push(`Parsed ${details.metricName}: ${details.parsedPrimary}`)
    lines.push(`Next log_experiment metric: ${details.parsedPrimary}`)
  }
  if (details.parsedMetrics) {
    const secondaryEntries = Object.entries(details.parsedMetrics).filter(
      ([name]) => name !== details.metricName,
    )
    const secondary = secondaryEntries.map(([name, value]) => `${name}=${value}`)
    if (secondary.length > 0) {
      lines.push(`Parsed metrics: ${secondary.join(', ')}`)
      lines.push(
        `Next log_experiment metrics: ${JSON.stringify(Object.fromEntries(secondaryEntries))}`,
      )
    }
  }
  if (details.parsedAsi) {
    lines.push(`Parsed ASI keys: ${Object.keys(details.parsedAsi).join(', ')}`)
  }
  lines.push('')
  lines.push(outputPreview)
  if (truncatedLogPath) {
    lines.push('')
    lines.push(`Output truncated. Full output: ${truncatedLogPath}`)
  }
  return lines.join('\n').trimEnd()
}

/** Tail truncation to the LLM byte/line budget (mirrors oh-my-pi's truncateTail). */
function truncateTail(output: string): { content: string; truncated: boolean } {
  let truncated = false
  let lines = output.split('\n')
  if (lines.length > EXPERIMENT_MAX_LINES) {
    lines = lines.slice(-EXPERIMENT_MAX_LINES)
    truncated = true
  }
  let content = lines.join('\n')
  if (Buffer.byteLength(content, 'utf8') > EXPERIMENT_MAX_BYTES) {
    content = content.slice(-EXPERIMENT_MAX_BYTES)
    truncated = true
  }
  return { content, truncated }
}
