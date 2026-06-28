/**
 * Shared constants + the no-active-session guard for the autoresearch tools.
 *
 * Under the JSONL storage model the session is per-working-directory: an active
 * session is simply one whose `.auto/log.jsonl` (or legacy `autoresearch.jsonl`)
 * exists. There is no store and no per-branch session lookup.
 */

import { getCwd } from '../../utils/cwd.js'
import { sessionLogExists } from '../../autoresearch/storage.js'

export const NO_SESSION_ERROR =
  'Error: no active autoresearch session. Call init_experiment first.'

/** The working directory the experiment tools operate on. */
export function resolveWorkDir(): string {
  return getCwd()
}

/** True when an autoresearch session log exists in the current working directory. */
export function hasActiveSession(): boolean {
  return sessionLogExists(getCwd())
}
