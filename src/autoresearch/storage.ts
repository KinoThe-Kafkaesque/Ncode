/**
 * Autoresearch storage — thin JSONL helpers over `.auto/log.jsonl`.
 *
 * Replaces the legacy out-of-tree JSON store (`~/.ncode/autoresearch/<encoded>.json`
 * with `AutoresearchStore`). The upstream pi-autoresearch model appends every
 * session config header and run entry as a single JSON line per record; state is
 * reconstructed from the log on demand (see `state.ts` / `jsonl.ts`). No locks:
 * the log is append-only and per-project.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from 'node:fs'
import { relative } from 'node:path'
import {
  ensureParentDir,
  sessionFileCandidates,
  sessionFilePath,
} from './paths.js'
import {
  isAutoresearchRunEntry,
  parseJsonlEntry,
  type JsonlEntry,
} from './jsonl.js'

/**
 * Config header appended at the start of a `.auto/log.jsonl` session (and at
 * the start of any new segment). Mirrors the fields `init_experiment` records.
 */
export interface ConfigHeader {
  name: string
  metricName: string
  metricUnit: string
  bestDirection: 'lower' | 'higher'
  goal?: string | null
  scopePaths?: string[]
  offLimits?: string[]
  constraints?: string[]
  maxIterations?: number | null
  baselineCommit?: string | null
}

/** True when a `.auto/log.jsonl` (or legacy `autoresearch.jsonl`) exists. */
export function sessionLogExists(workDir: string): boolean {
  return existsSync(sessionFilePath(workDir, 'log'))
}

/** Read the raw JSONL content of the session log, or '' if it does not exist. */
export function readJsonlContent(workDir: string): string {
  const filePath = sessionFilePath(workDir, 'log')
  if (!existsSync(filePath)) return ''
  return readFileSync(filePath, 'utf8')
}

/**
 * Return the last run entry in the session log, or null if there are none.
 * Used by hooks to inspect the most recently logged run.
 */
export function readLastRunEntry(workDir: string): JsonlEntry | null {
  const content = readJsonlContent(workDir)
  if (content.length === 0) return null
  let lastRun: JsonlEntry | null = null
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    const entry = parseJsonlEntry(line)
    if (entry && isAutoresearchRunEntry(entry)) lastRun = entry
  }
  return lastRun
}

/** Append a config header line to `.auto/log.jsonl` (for `init_experiment`). */
export function appendConfigHeader(workDir: string, config: ConfigHeader): void {
  const filePath = sessionFilePath(workDir, 'log')
  ensureParentDir(filePath)
  const entry: JsonlEntry = {
    type: 'config',
    name: config.name,
    metricName: config.metricName,
    metricUnit: config.metricUnit,
    bestDirection: config.bestDirection,
  }
  if (config.goal !== undefined) entry.goal = config.goal
  if (config.scopePaths !== undefined) entry.scopePaths = config.scopePaths
  if (config.offLimits !== undefined) entry.offLimits = config.offLimits
  if (config.constraints !== undefined) entry.constraints = config.constraints
  if (config.maxIterations !== undefined) entry.maxIterations = config.maxIterations
  if (config.baselineCommit !== undefined) entry.baselineCommit = config.baselineCommit
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`)
}

/** Append a run entry line to `.auto/log.jsonl` (for `log_experiment`). */
export function appendRunEntry(workDir: string, entry: Record<string, unknown>): void {
  const filePath = sessionFilePath(workDir, 'log')
  ensureParentDir(filePath)
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`)
}

/**
 * Delete session log files (current `.auto/log.jsonl` and legacy
 * `autoresearch.jsonl`). Returns the relative paths (relative to `workDir`)
 * that were actually deleted.
 */
export function deleteSessionLogs(workDir: string): string[] {
  const candidates = sessionFileCandidates(workDir, 'log')
  const deleted: string[] = []
  for (const filePath of [candidates.current, candidates.legacy]) {
    if (!existsSync(filePath)) continue
    unlinkSync(filePath)
    deleted.push(relative(workDir, filePath))
  }
  return deleted
}
