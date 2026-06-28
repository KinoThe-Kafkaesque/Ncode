/**
 * Autoresearch storage — JSON store (faithful replacement for oh-my-pi's
 * `bun:sqlite` `AutoresearchStorage`).
 *
 * ncode has no sqlite, so the sessions+runs schema is persisted as a single
 * JSON document per project under `~/.ncode/autoresearch/<encoded-project>.json`,
 * with run artifact logs under `~/.ncode/autoresearch/<encoded-project>/runs/<id4>/`.
 * The on-disk shape mirrors the oh-my-pi `SessionRow`/`RunRow` records 1:1
 * (camelCase here instead of snake_case columns).
 *
 * Concurrency: mutations take a `proper-lockfile` lock on the store file
 * (precedent: `src/history.ts`) and re-read before applying, so two ncode
 * sessions in the same project don't clobber each other. Reads are lock-free
 * snapshots of the file.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getNcodeConfigHomeDir } from '../utils/envUtils.js'
import { lock } from '../utils/lockfile.js'
import { repoRoot } from './git.js'
import type {
  ASIData,
  ExperimentStatus,
  MetricDirection,
  NumericMetricMap,
} from './types.js'

const STORE_SCHEMA_VERSION = 1

export interface SessionRow {
  id: number
  name: string
  goal: string | null
  primaryMetric: string
  metricUnit: string
  direction: MetricDirection
  preferredCommand: string | null
  branch: string | null
  baselineCommit: string | null
  currentSegment: number
  maxIterations: number | null
  scopePaths: string[]
  offLimits: string[]
  constraints: string[]
  secondaryMetrics: string[]
  notes: string
  createdAt: number
  closedAt: number | null
}

export interface RunRow {
  id: number
  sessionId: number
  segment: number
  command: string
  startedAt: number
  completedAt: number | null
  durationMs: number | null
  exitCode: number | null
  timedOut: boolean
  parsedPrimary: number | null
  parsedMetrics: NumericMetricMap | null
  parsedAsi: ASIData | null
  preRunDirtyPaths: string[]
  logPath: string
  status: ExperimentStatus | null
  description: string | null
  metric: number | null
  metrics: NumericMetricMap | null
  asi: ASIData | null
  commitHash: string | null
  confidence: number | null
  modifiedPaths: string[] | null
  scopeDeviations: string[] | null
  justification: string | null
  flagged: boolean
  flaggedReason: string | null
  loggedAt: number | null
  abandonedAt: number | null
}

interface StoreData {
  schemaVersion: number
  nextSessionId: number
  nextRunId: number
  sessions: SessionRow[]
  runs: RunRow[]
}

export interface OpenSessionParams {
  name: string
  goal: string | null
  primaryMetric: string
  metricUnit: string
  direction: MetricDirection
  preferredCommand: string | null
  branch: string | null
  baselineCommit: string | null
  maxIterations: number | null
  scopePaths: string[]
  offLimits: string[]
  constraints: string[]
  secondaryMetrics: string[]
}

export interface UpdateSessionParams {
  goal?: string | null
  preferredCommand?: string | null
  maxIterations?: number | null
  scopePaths?: string[]
  offLimits?: string[]
  constraints?: string[]
  secondaryMetrics?: string[]
  primaryMetric?: string
  metricUnit?: string
  direction?: MetricDirection
  branch?: string | null
  baselineCommit?: string | null
  notes?: string
}

export interface InsertRunParams {
  sessionId: number
  segment: number
  command: string
  logPath: string
  preRunDirtyPaths: string[]
  startedAt: number
}

export interface MarkRunCompletedParams {
  runId: number
  completedAt: number
  durationMs: number
  exitCode: number | null
  timedOut: boolean
  parsedPrimary: number | null
  parsedMetrics: NumericMetricMap | null
  parsedAsi: ASIData | null
}

export interface MarkRunLoggedParams {
  runId: number
  status: ExperimentStatus
  description: string
  metric: number
  metrics: NumericMetricMap
  asi: ASIData | null
  commitHash: string | null
  confidence: number | null
  modifiedPaths: string[]
  scopeDeviations: string[]
  justification: string | null
  loggedAt: number
}

/**
 * Encode an absolute project path into a single filesystem-safe segment.
 * Mirrors oh-my-pi's `encodeProjectKey` (the `--…--` wrapper is kept for parity).
 */
function encodeProjectKey(root: string): string {
  return `--${root.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

function emptyStore(): StoreData {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    nextSessionId: 1,
    nextRunId: 1,
    sessions: [],
    runs: [],
  }
}

export class AutoresearchStore {
  readonly #filePath: string
  readonly #projectDir: string

  constructor(filePath: string, projectDir: string) {
    this.#filePath = filePath
    this.#projectDir = projectDir
  }

  get projectDir(): string {
    return this.#projectDir
  }

  get filePath(): string {
    return this.#filePath
  }

  #load(): StoreData {
    try {
      if (!existsSync(this.#filePath)) return emptyStore()
      const parsed = JSON.parse(readFileSync(this.#filePath, 'utf8')) as StoreData
      if (!parsed || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.runs)) {
        return emptyStore()
      }
      return {
        schemaVersion: parsed.schemaVersion ?? STORE_SCHEMA_VERSION,
        nextSessionId: parsed.nextSessionId ?? maxId(parsed.sessions) + 1,
        nextRunId: parsed.nextRunId ?? maxId(parsed.runs) + 1,
        sessions: parsed.sessions,
        runs: parsed.runs,
      }
    } catch {
      return emptyStore()
    }
  }

  #save(data: StoreData): void {
    mkdirSync(dirname(this.#filePath), { recursive: true })
    writeFileSync(this.#filePath, JSON.stringify(data), { mode: 0o600 })
  }

  async #mutate<T>(fn: (data: StoreData) => T): Promise<T> {
    mkdirSync(dirname(this.#filePath), { recursive: true })
    // proper-lockfile needs the target file to exist before locking.
    if (!existsSync(this.#filePath)) this.#save(emptyStore())
    const release = await lock(this.#filePath, {
      stale: 10_000,
      retries: { retries: 5, minTimeout: 50 },
    })
    try {
      const data = this.#load()
      const result = fn(data)
      this.#save(data)
      return result
    } finally {
      await release()
    }
  }

  // === Sessions ===

  getActiveSession(): SessionRow | null {
    const open = this.#load().sessions.filter(s => s.closedAt === null)
    return open.length > 0 ? open[open.length - 1]! : null
  }

  getActiveSessionForBranch(branch: string | null): SessionRow | null {
    const open = this.#load().sessions.filter(
      s => s.closedAt === null && (branch === null ? s.branch === null : s.branch === branch),
    )
    return open.length > 0 ? open[open.length - 1]! : null
  }

  getSessionById(sessionId: number): SessionRow | null {
    return this.#load().sessions.find(s => s.id === sessionId) ?? null
  }

  async openSession(params: OpenSessionParams): Promise<SessionRow> {
    return this.#mutate(data => {
      const session: SessionRow = {
        id: data.nextSessionId,
        name: params.name,
        goal: params.goal,
        primaryMetric: params.primaryMetric,
        metricUnit: params.metricUnit,
        direction: params.direction,
        preferredCommand: params.preferredCommand,
        branch: params.branch,
        baselineCommit: params.baselineCommit,
        currentSegment: 0,
        maxIterations: params.maxIterations,
        scopePaths: [...params.scopePaths],
        offLimits: [...params.offLimits],
        constraints: [...params.constraints],
        secondaryMetrics: [...params.secondaryMetrics],
        notes: '',
        createdAt: Date.now(),
        closedAt: null,
      }
      data.nextSessionId += 1
      data.sessions.push(session)
      return { ...session }
    })
  }

  async updateSession(
    sessionId: number,
    updates: UpdateSessionParams,
  ): Promise<SessionRow> {
    return this.#mutate(data => {
      const session = data.sessions.find(s => s.id === sessionId)
      if (!session) throw new Error(`Session ${sessionId} not found after update`)
      if (updates.goal !== undefined) session.goal = updates.goal
      if (updates.preferredCommand !== undefined)
        session.preferredCommand = updates.preferredCommand
      if (updates.maxIterations !== undefined)
        session.maxIterations = updates.maxIterations
      if (updates.scopePaths !== undefined) session.scopePaths = [...updates.scopePaths]
      if (updates.offLimits !== undefined) session.offLimits = [...updates.offLimits]
      if (updates.constraints !== undefined)
        session.constraints = [...updates.constraints]
      if (updates.secondaryMetrics !== undefined)
        session.secondaryMetrics = [...updates.secondaryMetrics]
      if (updates.primaryMetric !== undefined)
        session.primaryMetric = updates.primaryMetric
      if (updates.metricUnit !== undefined) session.metricUnit = updates.metricUnit
      if (updates.direction !== undefined) session.direction = updates.direction
      if (updates.branch !== undefined) session.branch = updates.branch
      if (updates.baselineCommit !== undefined)
        session.baselineCommit = updates.baselineCommit
      if (updates.notes !== undefined) session.notes = updates.notes
      return { ...session }
    })
  }

  async bumpSegment(sessionId: number): Promise<SessionRow> {
    return this.#mutate(data => {
      const session = data.sessions.find(s => s.id === sessionId)
      if (!session) throw new Error(`Session ${sessionId} not found after bumping segment`)
      session.currentSegment += 1
      return { ...session }
    })
  }

  async closeSession(sessionId: number): Promise<void> {
    await this.#mutate(data => {
      const session = data.sessions.find(s => s.id === sessionId)
      if (session) session.closedAt = Date.now()
    })
  }

  // === Runs ===

  async insertRun(params: InsertRunParams): Promise<RunRow> {
    return this.#mutate(data => {
      const run: RunRow = {
        id: data.nextRunId,
        sessionId: params.sessionId,
        segment: params.segment,
        command: params.command,
        startedAt: params.startedAt,
        completedAt: null,
        durationMs: null,
        exitCode: null,
        timedOut: false,
        parsedPrimary: null,
        parsedMetrics: null,
        parsedAsi: null,
        preRunDirtyPaths: [...params.preRunDirtyPaths],
        logPath: params.logPath,
        status: null,
        description: null,
        metric: null,
        metrics: null,
        asi: null,
        commitHash: null,
        confidence: null,
        modifiedPaths: null,
        scopeDeviations: null,
        justification: null,
        flagged: false,
        flaggedReason: null,
        loggedAt: null,
        abandonedAt: null,
      }
      data.nextRunId += 1
      data.runs.push(run)
      return { ...run }
    })
  }

  async updateRunLogPath(runId: number, logPath: string): Promise<RunRow> {
    return this.#mutate(data => {
      const run = requireRun(data, runId)
      run.logPath = logPath
      return { ...run }
    })
  }

  async updateRunConfidence(runId: number, confidence: number | null): Promise<RunRow> {
    return this.#mutate(data => {
      const run = requireRun(data, runId)
      run.confidence = confidence
      return { ...run }
    })
  }

  async markRunCompleted(params: MarkRunCompletedParams): Promise<RunRow> {
    return this.#mutate(data => {
      const run = requireRun(data, params.runId)
      run.completedAt = params.completedAt
      run.durationMs = params.durationMs
      run.exitCode = params.exitCode
      run.timedOut = params.timedOut
      run.parsedPrimary = params.parsedPrimary
      run.parsedMetrics = params.parsedMetrics
      run.parsedAsi = params.parsedAsi
      return { ...run }
    })
  }

  async markRunLogged(params: MarkRunLoggedParams): Promise<RunRow> {
    return this.#mutate(data => {
      const run = requireRun(data, params.runId)
      run.status = params.status
      run.description = params.description
      run.metric = params.metric
      run.metrics = params.metrics
      run.asi = params.asi
      run.commitHash = params.commitHash
      run.confidence = params.confidence
      run.modifiedPaths = params.modifiedPaths
      run.scopeDeviations = params.scopeDeviations
      run.justification = params.justification
      run.loggedAt = params.loggedAt
      return { ...run }
    })
  }

  async flagRun(runId: number, reason: string): Promise<RunRow> {
    return this.#mutate(data => {
      const run = requireRun(data, runId)
      run.flagged = true
      run.flaggedReason = reason
      return { ...run }
    })
  }

  async abandonPendingRuns(sessionId: number): Promise<number> {
    return this.#mutate(data => {
      const pending = data.runs.filter(
        r => r.sessionId === sessionId && r.status === null && r.abandonedAt === null,
      )
      const now = Date.now()
      for (const run of pending) run.abandonedAt = now
      return pending.length
    })
  }

  getPendingRun(sessionId: number): RunRow | null {
    const pending = this.#load().runs.filter(
      r => r.sessionId === sessionId && r.status === null && r.abandonedAt === null,
    )
    return pending.length > 0 ? { ...pending[pending.length - 1]! } : null
  }

  getRunById(runId: number): RunRow | null {
    const run = this.#load().runs.find(r => r.id === runId)
    return run ? { ...run } : null
  }

  listRuns(sessionId: number): RunRow[] {
    return this.#load()
      .runs.filter(r => r.sessionId === sessionId)
      .sort((a, b) => a.id - b.id)
  }

  listLoggedRuns(sessionId: number): RunRow[] {
    return this.#load()
      .runs.filter(r => r.sessionId === sessionId && r.status !== null)
      .sort((a, b) => a.id - b.id)
  }
}

function requireRun(data: StoreData, runId: number): RunRow {
  const run = data.runs.find(r => r.id === runId)
  if (!run) throw new Error(`Run ${runId} not found`)
  return run
}

function maxId(rows: Array<{ id: number }>): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0)
}

// === Path resolution + open helpers =========================================

const storeCache = new Map<string, AutoresearchStore>()

function autoresearchHomeDir(): string {
  return join(getNcodeConfigHomeDir(), 'autoresearch')
}

async function resolvePaths(): Promise<{ filePath: string; projectDir: string }> {
  const root = (await repoRoot()) ?? process.cwd()
  const encoded = encodeProjectKey(root)
  const home = autoresearchHomeDir()
  return {
    filePath: join(home, `${encoded}.json`),
    projectDir: join(home, encoded),
  }
}

export async function openAutoresearchStore(): Promise<AutoresearchStore> {
  const { filePath, projectDir } = await resolvePaths()
  const cached = storeCache.get(filePath)
  if (cached) return cached
  const store = new AutoresearchStore(filePath, projectDir)
  storeCache.set(filePath, store)
  return store
}

export async function openAutoresearchStoreIfExists(): Promise<AutoresearchStore | null> {
  const { filePath, projectDir } = await resolvePaths()
  const cached = storeCache.get(filePath)
  if (cached) return cached
  if (!existsSync(filePath)) return null
  const store = new AutoresearchStore(filePath, projectDir)
  storeCache.set(filePath, store)
  return store
}
