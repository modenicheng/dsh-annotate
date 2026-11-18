/**
 * Filesystem locations owned by the host plugin.
 *
 * Everything lives under `$DSH_HOME` so the bridge dies with the profile it
 * belongs to and never writes outside the user's harness directory.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { TOKEN_FILE } from './protocol.js'

/** Resolve `$DSH_HOME`, honouring the runtime override. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/** Directory holding `queue.jsonl`. */
export function annotationsDir(home = dshHome()) {
  return join(home, 'annotations')
}

/**
 * Read the bridge token, generating it on first use.
 *
 * The token is a 32-byte random hex string with owner-only permissions. It is
 * deliberately stable across restarts so an installed extension keeps working.
 * @param {string} [home]
 * @returns {Promise<string>}
 */
export async function ensureToken(home = dshHome()) {
  const file = join(home, TOKEN_FILE)
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
  }
  await mkdir(home, { recursive: true })
  const token = randomBytes(32).toString('hex')
  await writeFile(file, `${token}\n`, { mode: 0o600 })
  try {
    await chmod(file, 0o600)
  } catch {
    // Windows ignores POSIX modes; the file still lives under the user profile.
  }
  return token
}
