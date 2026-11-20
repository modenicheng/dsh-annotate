/**
 * The message-name contract is mirrored by hand in classic scripts that cannot
 * import the shared ES module (`background/core.js`, `content/main.js`). One
 * such mirror silently missed `anno.session.create`, and the background's
 * allow-list dropped the message: the composer answered a bare "create failed"
 * with no reason. This test pins every mirror to `src/shared/messages.js` so
 * the drift can never ship again.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** @param {string} path */
function read(path) {
  return readFileSync(join(root, path), 'utf8')
}

/**
 * Extract the balanced-brace object literal that follows `anchor`, then
 * evaluate it as an object expression. The mirrors hold only string literals,
 * so evaluation needs no host globals.
 * @param {string} text @param {string} anchor @param {string} label
 */
function objectAfter(text, anchor, label) {
  const at = text.indexOf(anchor)
  assert.notEqual(at, -1, `${label}: anchor "${anchor}" not found`)
  const open = text.indexOf('{', at + anchor.length)
  assert.notEqual(open, -1, `${label}: no object literal after "${anchor}"`)
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const literal = text.slice(open, i + 1)
        // Plain JSON round-trip: a vm realm's Object.prototype is a different
        // identity than the host's, which strict deepEqual would reject.
        return JSON.parse(JSON.stringify(vm.runInNewContext(`(${literal})`)))
      }
    }
  }
  assert.fail(`${label}: unbalanced braces after "${anchor}"`)
}

const shared = read('shared/messages.js')
const core = read('background/core.js')
const content = read('content/main.js')

const contract = {
  TO_BACKGROUND: objectAfter(shared, 'export const TO_BACKGROUND', 'shared/messages.js'),
  TO_CONTENT: objectAfter(shared, 'export const TO_CONTENT', 'shared/messages.js'),
  TO_BACKGROUND_POPUP: objectAfter(shared, 'export const TO_BACKGROUND_POPUP', 'shared/messages.js'),
  STORAGE_KEYS: objectAfter(shared, 'export const STORAGE_KEYS', 'shared/messages.js'),
}

test('background/core.js mirrors the shared message contract', () => {
  const mirror = objectAfter(core, 'ns.msg =', 'background/core.js')
  assert.deepEqual(mirror.TO_BACKGROUND, contract.TO_BACKGROUND, 'TO_BACKGROUND drifted')
  assert.deepEqual(mirror.TO_CONTENT, contract.TO_CONTENT, 'TO_CONTENT drifted')
  assert.deepEqual(mirror.TO_BACKGROUND_POPUP, contract.TO_BACKGROUND_POPUP, 'TO_BACKGROUND_POPUP drifted')
  assert.deepEqual(mirror.STORAGE_KEYS, contract.STORAGE_KEYS, 'STORAGE_KEYS drifted')
})

test('content/main.js mirrors the shared message contract', () => {
  const mirror = objectAfter(content, 'const MSG =', 'content/main.js')
  assert.deepEqual(mirror.background, contract.TO_BACKGROUND, 'TO_BACKGROUND drifted')
  assert.deepEqual(mirror.content, contract.TO_CONTENT, 'TO_CONTENT drifted')
})
