/**
 * Autoresearch git layer.
 *
 * Two parts:
 * 1. Pure dirty-path parsing + `computeRunModifiedPaths` — ported VERBATIM from
 *    oh-my-pi `autoresearch/git.ts` (porcelain-v1 NUL + line parsing, rename/copy
 *    handling, work-dir-prefix relativization).
 * 2. ncode git command wrappers. oh-my-pi calls high-level `git.*` helpers; ncode
 *    has no commit/reset/restore helpers, so we shell out via
 *    `execFileNoThrow(gitExe(), [...])` (runs in `getCwd()`). jj support is
 *    DROPPED (ncode is Git-only per AGENTS.md).
 */

import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import { gitExe } from '../utils/git.js'
import { normalizePathSpec } from './helpers.js'

const AUTORESEARCH_BRANCH_PREFIX = 'autoresearch/'
const BRANCH_NAME_MAX_LENGTH = 48

// === ncode git command wrappers =============================================

async function git(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { stdout, stderr, code } = await execFileNoThrow(gitExe(), args, {
    useCwd: true,
    preserveOutputOnError: true,
  })
  return { stdout, stderr, code }
}

export async function repoRoot(): Promise<string | null> {
  const { stdout, code } = await git(['rev-parse', '--show-toplevel'])
  if (code !== 0) return null
  const root = stdout.trim()
  return root.length > 0 ? root : null
}

/** Current branch name, or null when detached / not a repo. */
export async function currentBranch(): Promise<string | null> {
  const { stdout, code } = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (code !== 0) return null
  const branch = stdout.trim()
  if (branch.length === 0 || branch === 'HEAD') return null
  return branch
}

export async function headSha(): Promise<string | null> {
  const { stdout, code } = await git(['rev-parse', 'HEAD'])
  if (code !== 0) return null
  const sha = stdout.trim()
  return sha.length > 0 ? sha : null
}

export async function statusPorcelainZ(): Promise<string> {
  const { stdout, code } = await git([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ])
  return code === 0 ? stdout : ''
}

export async function showPrefix(): Promise<string> {
  const { stdout, code } = await git(['rev-parse', '--show-prefix'])
  return code === 0 ? stdout.trim() : ''
}

export async function refExists(ref: string): Promise<boolean> {
  const { code } = await git(['show-ref', '--verify', '--quiet', ref])
  return code === 0
}

export async function checkoutNewBranch(branchName: string): Promise<void> {
  const { code, stderr } = await git(['checkout', '-B', branchName])
  if (code !== 0) throw new Error(stderr.trim() || `git checkout -B ${branchName} failed`)
}

export async function stageFiles(files: string[]): Promise<void> {
  const args = files.length === 0 ? ['add', '-A'] : ['add', '--', ...files]
  const { code, stderr } = await git(args)
  if (code !== 0) throw new Error(stderr.trim() || 'git add failed')
}

export async function commit(
  message: string,
  options?: { files?: string[] },
): Promise<{ stdout: string; stderr: string }> {
  const args = ['commit', '-m', message]
  if (options?.files && options.files.length > 0) {
    args.push('--', ...options.files)
  }
  const { stdout, stderr, code } = await git(args)
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || 'git commit failed')
  return { stdout, stderr }
}

/** True when there are staged changes for the given files (`git diff --cached`). */
export async function diffHasCached(files: string[]): Promise<boolean> {
  const args = ['diff', '--cached', '--quiet']
  if (files.length > 0) args.push('--', ...files)
  const { code } = await git(args)
  // `--quiet` exits 1 when there is a diff, 0 when clean.
  return code !== 0
}

export async function resetHard(target: string): Promise<void> {
  const { code, stderr } = await git(['reset', '--hard', target])
  if (code !== 0) throw new Error(stderr.trim() || 'git reset --hard failed')
}

export async function clean(): Promise<void> {
  const { code, stderr } = await git(['clean', '-fd'])
  if (code !== 0) throw new Error(stderr.trim() || 'git clean -fd failed')
}

export async function restore(files: string[]): Promise<void> {
  if (files.length === 0) return
  const { code, stderr } = await git([
    'restore',
    '--source=HEAD',
    '--staged',
    '--worktree',
    '--',
    ...files,
  ])
  if (code !== 0) throw new Error(stderr.trim() || 'git restore failed')
}

export async function tryGitStatus(): Promise<string> {
  try {
    return await statusPorcelainZ()
  } catch {
    return ''
  }
}

export async function tryGitPrefix(): Promise<string> {
  try {
    return await showPrefix()
  } catch {
    return ''
  }
}

// === Branch isolation =======================================================

export interface EnsureAutoresearchBranchFailure {
  error: string
  ok: false
}

export interface EnsureAutoresearchBranchSuccess {
  branchName: string | null
  created: boolean
  ok: true
  warning?: string
}

export type EnsureAutoresearchBranchResult =
  | EnsureAutoresearchBranchFailure
  | EnsureAutoresearchBranchSuccess

export async function getCurrentAutoresearchBranch(): Promise<string | null> {
  const branch = (await currentBranch()) ?? ''
  return branch.startsWith(AUTORESEARCH_BRANCH_PREFIX) ? branch : null
}

/**
 * Ensure the working tree is on an `autoresearch/*` branch when possible.
 *
 * If the worktree is dirty and we're not already on an autoresearch branch this
 * fails (a fresh branch needs a clean baseline). Outside a git repo it returns
 * `{ ok: true, branchName: null, warning }` so the caller continues on the
 * current branch without isolation.
 */
export async function ensureAutoresearchBranch(
  goal: string | null,
): Promise<EnsureAutoresearchBranchResult> {
  const root = await repoRoot()
  if (!root) {
    return {
      ok: true,
      branchName: null,
      created: false,
      warning:
        'Not in a git repository — autoresearch will run without branch isolation, baseline reset, or auto-commits.',
    }
  }

  let dirtyPathsOutput: string
  try {
    dirtyPathsOutput = await statusPorcelainZ()
  } catch (err) {
    return {
      ok: false,
      error: `Unable to inspect git status before starting autoresearch: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const workDirPrefix = await tryGitPrefix()
  const dirtyPaths = collectRelativeDirtyPaths(dirtyPathsOutput, workDirPrefix)
  const current = await getCurrentAutoresearchBranch()
  if (current) {
    return { ok: true, branchName: current, created: false }
  }
  if (dirtyPaths.length > 0) {
    const preview = formatDirtyPaths(dirtyPaths)
    return {
      ok: false,
      error: `Worktree is dirty (${preview}). Commit or stash these changes before starting autoresearch — a fresh autoresearch/* branch needs a clean baseline.`,
    }
  }

  const branchName = await allocateBranchName(goal)
  try {
    await checkoutNewBranch(branchName)
  } catch (err) {
    return {
      ok: false,
      error: `Failed to create autoresearch branch ${branchName}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  return { ok: true, branchName, created: true }
}

async function allocateBranchName(goal: string | null): Promise<string> {
  const baseName = `${AUTORESEARCH_BRANCH_PREFIX}${slugifyGoal(goal)}-${currentDateStamp()}`
  let candidate = baseName
  let suffix = 2
  while (await refExists(`refs/heads/${candidate}`)) {
    candidate = `${baseName}-${suffix}`
    suffix += 1
  }
  return candidate
}

function slugifyGoal(goal: string | null): string {
  const normalized = (goal ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const trimmed = normalized.slice(0, BRANCH_NAME_MAX_LENGTH).replace(/-+$/g, '')
  return trimmed || 'session'
}

function currentDateStamp(): string {
  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

// === Pure dirty-path parsing (ported verbatim) ==============================

export function parseWorkDirDirtyPaths(
  statusOutput: string,
  workDirPrefix: string,
): string[] {
  const relativePaths: string[] = []
  for (const dirtyPath of parseDirtyPaths(statusOutput)) {
    const relativePath = relativizeGitPathToWorkDir(dirtyPath, workDirPrefix)
    if (relativePath === null) continue
    relativePaths.push(relativePath)
  }
  return relativePaths
}

export function relativizeGitPathToWorkDir(
  repoRelativePath: string,
  workDirPrefix: string,
): string | null {
  const normalizedPath = normalizeStatusPath(repoRelativePath)
  const normalizedPrefix = normalizePathSpec(workDirPrefix)
  if (normalizedPrefix === '' || normalizedPrefix === '.') {
    return normalizedPath
  }
  if (normalizedPath === normalizedPrefix) {
    return '.'
  }
  if (!normalizedPath.startsWith(`${normalizedPrefix}/`)) {
    return null
  }
  return normalizePathSpec(normalizedPath.slice(normalizedPrefix.length + 1))
}

export function parseDirtyPaths(statusOutput: string): string[] {
  if (statusOutput.includes('\0')) {
    return parseDirtyPathsNul(statusOutput)
  }
  return parseDirtyPathsLines(statusOutput)
}

function parseDirtyPathsNul(statusOutput: string): string[] {
  const unsafePaths = new Set<string>()
  let index = 0
  while (index + 3 <= statusOutput.length) {
    const statusToken = statusOutput.slice(index, index + 3)
    index += 3
    const pathEnd = statusOutput.indexOf('\0', index)
    if (pathEnd < 0) break
    const firstPath = statusOutput.slice(index, pathEnd)
    index = pathEnd + 1
    addDirtyPath(unsafePaths, firstPath)
    if (isRenameOrCopy(statusToken)) {
      const secondPathEnd = statusOutput.indexOf('\0', index)
      if (secondPathEnd < 0) break
      const secondPath = statusOutput.slice(index, secondPathEnd)
      index = secondPathEnd + 1
      addDirtyPath(unsafePaths, secondPath)
    }
  }
  return [...unsafePaths]
}

function parseDirtyPathsLines(statusOutput: string): string[] {
  const unsafePaths = new Set<string>()
  for (const line of statusOutput.split('\n')) {
    const trimmedLine = line.trimEnd()
    if (trimmedLine.length < 4) continue
    const rawPath = trimmedLine.slice(3).trim()
    if (rawPath.length === 0) continue
    const renameParts = rawPath.split(' -> ')
    for (const renamePart of renameParts) {
      addDirtyPath(unsafePaths, renamePart)
    }
  }
  return [...unsafePaths]
}

export function normalizeStatusPath(rawPath: string): string {
  let normalized = rawPath.trim()
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1)
  }
  return normalizePathSpec(normalized)
}

function addDirtyPath(paths: Set<string>, rawPath: string): void {
  const normalizedPath = normalizeStatusPath(rawPath)
  if (normalizedPath.length === 0) return
  paths.add(normalizedPath)
}

function isRenameOrCopy(statusToken: string): boolean {
  const trimmed = statusToken.trim()
  return trimmed.startsWith('R') || trimmed.startsWith('C')
}

function collectRelativeDirtyPaths(
  statusOutput: string,
  workDirPrefix: string,
): string[] {
  const dirtyPaths: string[] = []
  for (const dirtyPath of parseDirtyPaths(statusOutput)) {
    const relativePath = relativizeGitPathToWorkDir(dirtyPath, workDirPrefix)
    dirtyPaths.push(relativePath ?? normalizeStatusPath(dirtyPath))
  }
  return dirtyPaths
}

function formatDirtyPaths(paths: string[]): string {
  const preview = paths.slice(0, 5).join(', ')
  return paths.length > 5 ? `${preview} (+${paths.length - 5} more)` : preview
}

export interface DirtyPathEntry {
  path: string
  untracked: boolean
}

export function parseDirtyPathsWithStatus(statusOutput: string): DirtyPathEntry[] {
  if (statusOutput.includes('\0')) {
    return parseDirtyPathsNulWithStatus(statusOutput)
  }
  return parseDirtyPathsLinesWithStatus(statusOutput)
}

function parseDirtyPathsNulWithStatus(statusOutput: string): DirtyPathEntry[] {
  const seen = new Set<string>()
  const results: DirtyPathEntry[] = []
  let index = 0
  while (index + 3 <= statusOutput.length) {
    const statusToken = statusOutput.slice(index, index + 3)
    index += 3
    const pathEnd = statusOutput.indexOf('\0', index)
    if (pathEnd < 0) break
    const firstPath = statusOutput.slice(index, pathEnd)
    index = pathEnd + 1
    const untracked = statusToken.trim().startsWith('??')
    addDirtyPathEntry(seen, results, firstPath, untracked)
    if (isRenameOrCopy(statusToken)) {
      const secondPathEnd = statusOutput.indexOf('\0', index)
      if (secondPathEnd < 0) break
      const secondPath = statusOutput.slice(index, secondPathEnd)
      index = secondPathEnd + 1
      addDirtyPathEntry(seen, results, secondPath, false)
    }
  }
  return results
}

function parseDirtyPathsLinesWithStatus(statusOutput: string): DirtyPathEntry[] {
  const seen = new Set<string>()
  const results: DirtyPathEntry[] = []
  for (const line of statusOutput.split('\n')) {
    const trimmedLine = line.trimEnd()
    if (trimmedLine.length < 4) continue
    const statusToken = trimmedLine.slice(0, 3)
    const rawPath = trimmedLine.slice(3).trim()
    if (rawPath.length === 0) continue
    const untracked = statusToken.trim().startsWith('??')
    const renameParts = rawPath.split(' -> ')
    for (const renamePart of renameParts) {
      addDirtyPathEntry(seen, results, renamePart, untracked)
    }
  }
  return results
}

function addDirtyPathEntry(
  seen: Set<string>,
  results: DirtyPathEntry[],
  rawPath: string,
  untracked: boolean,
): void {
  const normalizedPath = normalizeStatusPath(rawPath)
  if (normalizedPath.length === 0 || seen.has(normalizedPath)) return
  seen.add(normalizedPath)
  results.push({ path: normalizedPath, untracked })
}

export function parseWorkDirDirtyPathsWithStatus(
  statusOutput: string,
  workDirPrefix: string,
): DirtyPathEntry[] {
  const results: DirtyPathEntry[] = []
  for (const entry of parseDirtyPathsWithStatus(statusOutput)) {
    const relativePath = relativizeGitPathToWorkDir(entry.path, workDirPrefix)
    if (relativePath === null) continue
    results.push({ path: relativePath, untracked: entry.untracked })
  }
  return results
}

export function computeRunModifiedPaths(
  preRunDirtyPaths: string[],
  currentStatusOutput: string,
  workDirPrefix: string,
): { tracked: string[]; untracked: string[] } {
  const preRunSet = new Set(preRunDirtyPaths)
  const tracked: string[] = []
  const untracked: string[] = []
  for (const entry of parseWorkDirDirtyPathsWithStatus(
    currentStatusOutput,
    workDirPrefix,
  )) {
    if (preRunSet.has(entry.path)) continue
    if (entry.untracked) {
      untracked.push(entry.path)
    } else {
      tracked.push(entry.path)
    }
  }
  return { tracked, untracked }
}
