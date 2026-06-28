/**
 * run_experiment — run an arbitrary shell command as an experiment.
 *
 * Ported from oh-my-pi `autoresearch/tools/run-experiment.ts` (arktype → zod).
 * Accepts an arbitrary `command`. When `.auto/measure.sh` (or legacy
 * `autoresearch.sh`) exists, only that benchmark script may be run. Output is
 * captured and `METRIC name=value` / `ASI key=value` lines are parsed back.
 * After a passing benchmark, if `.auto/checks.sh` exists it is run as a
 * backpressure gate; failures are reported as `checks_failed`. The pending
 * result is stored in the autoresearch runtime for `log_experiment` to consume.
 */

import * as React from 'react'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod/v4'
import {
  markAutoResumeArmed,
  isAutoresearchToolAvailable,
  getAutoresearchRuntime,
} from '../../autoresearch/index.js'
import { parseWorkDirDirtyPaths, tryGitPrefix, tryGitStatus } from '../../autoresearch/git.js'
import {
  EXPERIMENT_MAX_BYTES,
  EXPERIMENT_MAX_LINES,
  formatNum,
  parseAsiLines,
  parseMetricLines,
} from '../../autoresearch/helpers.js'
import { buildExperimentState } from '../../autoresearch/state.js'
import type { ASIData, NumericMetricMap, PendingRunResult } from '../../autoresearch/types.js'
import { sessionFilePath } from '../../autoresearch/paths.js'
import { exec } from '../../utils/Shell.js'
import { Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { hasActiveSession, NO_SESSION_ERROR, resolveWorkDir } from './shared.js'

const DEFAULT_TIMEOUT_SECONDS = 600
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300
const CHECKS_OUTPUT_TAIL_LINES = 80

/**
 * Check if a command's primary purpose is running the benchmark script.
 *
 * Strips common harmless prefixes (env vars, env/time/nice wrappers) then
 * verifies the core command is the benchmark script invoked via a known
 * pattern. Rejects chaining tricks like "evil.py; measure.sh" because we
 * require the benchmark script to be the *first* real command.
 *
 * Ported from upstream pi-autoresearch `isAutoresearchShCommand`.
 */
function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim()

  // Strip leading env variable assignments: FOO=bar BAZ="qux" ...
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, '')

  // Strip known harmless command wrappers (env, time, nice, nohup) repeatedly.
  // Allows flags and their numeric values: e.g. "nice -n 10 time env ..."
  let prev: string
  do {
    prev = cmd
    cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, '')
  } while (cmd !== prev)

  // The core command must be the benchmark script via a known invocation.
  // Current layout requires `.auto/measure.sh`; legacy `autoresearch.sh` is
  // still accepted. An optional path prefix allows `./.auto/measure.sh`,
  // `/abs/path/.auto/measure.sh`, `bash [-flags] autoresearch.sh`, etc.
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\/|\.{1,2}\/|[\w.-]+\/)*(?:autoresearch\.sh|\.auto\/measure\.sh)(?:\s|$)/.test(cmd)
}

const inputSchema = () =>
  z.strictObject({
    command: z.string().describe('Shell command to run'),
    timeout_seconds: z.number().optional().describe('Kill after this many seconds (default 600)'),
    checks_timeout_seconds: z.number().optional().describe('Kill .auto/checks.sh after this many seconds (default 300)'),
  })
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = () => z.object({ text: z.string() }).passthrough()
type OutputSchema = ReturnType<typeof outputSchema>
type Output = { text: string }

export const RunExperimentTool: Tool<InputSchema, Output> = buildTool({
  name: 'run_experiment',
  searchHint: 'run an experiment command (captures duration, output, exit code, parsed metrics)',
  maxResultSizeChars: 16_000,
  async description() {
    return 'Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. `METRIC name=value` and `ASI key=value` lines are parsed automatically. If `.auto/measure.sh` exists, only that script may be run. After a passing benchmark, `.auto/checks.sh` is run as a backpressure gate if present.'
  },
  async prompt() {
    return 'Run a shell command as an experiment. Pass `command` (or `bash .auto/measure.sh` when the benchmark script exists). Output is captured and `METRIC name=value` / `ASI key=value` lines are parsed back to you. Pass `timeout_seconds` to bound the run (default 600). If `.auto/checks.sh` exists, it runs after a passing benchmark (timeout via `checks_timeout_seconds`, default 300); failed checks mean you must log as `checks_failed`.'
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
  renderToolUseMessage(input: Partial<Input>) {
    return `run_experiment ${input.command ?? ''}`
  },
  renderToolResultMessage(output: Output) {
    return React.createElement(Text, {}, output.text)
  },
  async call(input: Input, context) {
    if (context.agentId) {
      throw new Error('run_experiment cannot be used in agent contexts')
    }
    if (!hasActiveSession()) {
      return { data: { text: NO_SESSION_ERROR } }
    }

    const workDir = resolveWorkDir()
    const runtime = getAutoresearchRuntime()
    const state = buildExperimentState(workDir)

    // Block if the per-segment experiment cap is already reached.
    if (state.maxExperiments !== null) {
      const segCount = state.results.filter(r => r.segment === state.currentSegment).length
      if (segCount >= state.maxExperiments) {
        return {
          data: {
            text: `Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.`,
          },
        }
      }
    }

    // Guard: if the benchmark script exists, only allow running it.
    const measureShPath = sessionFilePath(workDir, 'measure')
    if (existsSync(measureShPath) && !isAutoresearchShCommand(input.command)) {
      const rel = measureShPath
      return {
        data: {
          text: `${rel} exists — you must run it instead of a custom command.\n\nFound: ${measureShPath}\nYour command: ${input.command}\n\nUse: run_experiment({ command: "bash ${rel}" }) or run_experiment({ command: "./${rel}" })`,
        },
      }
    }

    const runNumber = state.results.length + 1
    const startedAt = Date.now()

    runtime.runningExperiment = { startedAt, command: input.command }

    const preRunStatus = await tryGitStatus()
    const workDirPrefix = await tryGitPrefix()
    const preRunDirtyPaths = parseWorkDirDirtyPaths(preRunStatus, workDirPrefix)

    const timeoutMs = Math.max(
      0,
      Math.floor((input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
    )

    const shellCommand = await exec(input.command, context.abortController.signal, 'bash', {
      timeout: timeoutMs > 0 ? timeoutMs : undefined,
    })
    const result = await shellCommand.result
    try {
      shellCommand.cleanup()
    } catch {
      // best-effort
    }

    runtime.runningExperiment = null

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

    const completedAt = Date.now()
    const durationMs = completedAt - startedAt
    const durationSeconds = durationMs / 1000
    const exitCode = result.code
    const timedOut = result.interrupted

    const parsedMetricsMap = parseMetricLines(output)
    const parsedMetrics: NumericMetricMap | null =
      parsedMetricsMap.size > 0 ? Object.fromEntries(parsedMetricsMap.entries()) : null
    const parsedPrimary = parsedMetricsMap.get(state.metricName) ?? null
    const parsedAsi: ASIData | null = parseAsiLines(output)

    const benchmarkPassed = exitCode === 0 && !timedOut

    // Run backpressure checks if benchmark passed and checks file exists.
    let checksPass: boolean | null = null
    let checksOutput = ''
    let checksDuration = 0

    const checksShPath = sessionFilePath(workDir, 'checks')
    if (benchmarkPassed && existsSync(checksShPath)) {
      const checksTimeoutMs = Math.max(
        0,
        Math.floor((input.checks_timeout_seconds ?? DEFAULT_CHECKS_TIMEOUT_SECONDS) * 1000),
      )
      const checksStartedAt = Date.now()
      try {
        const checksShell = await exec(`bash ${checksShPath}`, context.abortController.signal, 'bash', {
          timeout: checksTimeoutMs > 0 ? checksTimeoutMs : undefined,
        })
        const checksResult = await checksShell.result
        try {
          checksShell.cleanup()
        } catch {
          // best-effort
        }
        checksDuration = Date.now() - checksStartedAt
        const checksTimedOut = checksResult.interrupted
        checksPass = checksResult.code === 0 && !checksTimedOut
        let checksStdout = checksResult.stdout
        if (checksResult.outputFilePath) {
          try {
            checksStdout = readFileSync(checksResult.outputFilePath, 'utf8')
          } catch {
            // fall back to in-memory stdout
          }
        }
        checksOutput = [checksStdout, checksResult.stderr]
          .filter(part => part && part.length > 0)
          .join('\n')
      } catch (err) {
        checksDuration = Date.now() - checksStartedAt
        checksPass = false
        checksOutput = err instanceof Error ? err.message : String(err)
      }
    }

    const passed = benchmarkPassed && (checksPass === null || checksPass)

    // Store the pending run result for log_experiment to consume.
    const pendingRunResult: PendingRunResult = {
      runNumber,
      command: input.command,
      durationMs,
      exitCode,
      timedOut,
      parsedPrimary,
      parsedMetrics,
      parsedAsi,
      passed,
      preRunDirtyPaths,
      checksPass,
      checksOutput: checksOutput.split('\n').slice(-CHECKS_OUTPUT_TAIL_LINES).join('\n'),
      checksDuration,
    }
    runtime.lastRunResult = pendingRunResult

    markAutoResumeArmed()

    // Rebuild state for the response (best metric, baseline, etc.).
    const refreshedState = buildExperimentState(workDir)

    const preview = truncateTail(output)
    const truncatedLogPath = preview.truncated ? (result.outputFilePath ?? null) : null

    const text = buildRunText(
      {
        runNumber,
        command: input.command,
        exitCode,
        durationSeconds,
        passed,
        timedOut,
        parsedPrimary,
        parsedMetrics,
        parsedAsi,
        metricName: state.metricName,
        metricUnit: state.metricUnit,
        checksPass,
        checksOutput: pendingRunResult.checksOutput,
        checksDuration: checksDuration / 1000,
      },
      preview.content,
      refreshedState.bestMetric,
      truncatedLogPath,
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
  command: string
  exitCode: number
  durationSeconds: number
  passed: boolean
  timedOut: boolean
  parsedPrimary: number | null
  parsedMetrics: NumericMetricMap | null
  parsedAsi: Record<string, unknown> | null
  metricName: string
  metricUnit: string
  checksPass: boolean | null
  checksOutput: string
  checksDuration: number
}

function buildRunText(
  details: RunTextDetails,
  outputPreview: string,
  bestMetric: number | null,
  truncatedLogPath: string | null,
): string {
  const lines: string[] = []
  lines.push(`Run #${details.runNumber}: \`${details.command}\``)
  if (details.timedOut) {
    lines.push(`TIMEOUT after ${details.durationSeconds.toFixed(1)}s`)
  } else if (details.exitCode !== 0) {
    lines.push(`FAILED with exit code ${details.exitCode} in ${details.durationSeconds.toFixed(1)}s`)
  } else if (details.checksPass === false) {
    lines.push(`PASSED in ${details.durationSeconds.toFixed(1)}s — CHECKS FAILED in ${details.checksDuration.toFixed(1)}s`)
    lines.push(`Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.`)
  } else {
    lines.push(`PASSED in ${details.durationSeconds.toFixed(1)}s`)
    if (details.checksPass === true) {
      lines.push(`Checks passed in ${details.checksDuration.toFixed(1)}s`)
    }
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
  if (details.checksPass === false && details.checksOutput) {
    lines.push('')
    lines.push(`── Checks output (last ${CHECKS_OUTPUT_TAIL_LINES} lines) ──`)
    lines.push(details.checksOutput)
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
