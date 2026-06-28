/**
 * Shared constants + the no-active-session guard for the autoresearch tools.
 */

import { currentBranch } from '../../autoresearch/git.js'
import { openAutoresearchStoreIfExists } from '../../autoresearch/index.js'
import type {
  AutoresearchStore,
  SessionRow,
} from '../../autoresearch/storage.js'

export const HARNESS_FILENAME = 'autoresearch.sh'
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`

export const NO_SESSION_ERROR =
  'Error: no active autoresearch session for the current branch. Call init_experiment first.'

/**
 * Resolve the active session for the current branch, or null. Mirrors the
 * oh-my-pi `storage.getActiveSessionForBranch(currentBranch)` lookup the
 * run/log/update tools all perform.
 */
export async function resolveActiveSession(): Promise<{
  store: AutoresearchStore | null
  session: SessionRow | null
}> {
  const store = await openAutoresearchStoreIfExists()
  const branch = await currentBranch()
  const session = store?.getActiveSessionForBranch(branch) ?? null
  return { store, session }
}
