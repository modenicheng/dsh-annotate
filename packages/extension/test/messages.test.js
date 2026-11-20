/**
 * Keep the three runtime mirrors of the message contract honest.
 *
 * Firefox loads content scripts and the background as classic scripts, so they
 * cannot import `src/shared/messages.js`. Each context therefore mirrors the
 * names it uses. This test makes `messages.js` the single declared contract and
 * fails the moment a mirror invents, drops, or renames a message.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { CLIENT_FRAMES, SERVER_FRAMES } from '../src/shared/protocol.js'
import { STORAGE_KEYS, TO_BACKGROUND, TO_BACKGROUND_POPUP, TO_CONTENT } from '../src/shared/messages.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

/** Files that are allowed to name an `anno.*` literal. */
const CONSUMERS = [
  'src/background/core.js',
  'src/background/routing.js',
  'src/background/outbox.js',
  'src/background/socket.js',
  'src/background/capture.js',
  'src/background/main.js',
  'src/content/main.js',
  'src/content/ui/strings.js',
  'src/content/ui/styles.js',
  'src/content/ui/dom.js',
  'src/content/ui/overlay.js',
  'src/content/ui/hud.js',
  'src/content/ui/target.js',
  'src/content/ui/composer.js',
  'src/content/ui/badges.js',
  'src/content/ui/index.js',
  'src/content/anchor.js',
  'src/content/hydrator.js',
  'src/popup/popup.js',
  'src/popup/popup.discovery.js',
]

/** @param {Record<string, string>} table */
function values(table) {
  return Object.values(table)
}

/**
 * Wire frames and browser-side alarm names share the `anno.` prefix but are not
 * runtime messages; they are declared here so a typo in either is still caught.
 */
const NON_MESSAGE_NAMES = ['anno.keepalive']

const runtimeMessages = new Set([
  ...values(TO_BACKGROUND),
  ...values(TO_CONTENT),
  ...values(TO_BACKGROUND_POPUP),
  ...values(STORAGE_KEYS),
  ...NON_MESSAGE_NAMES,
])

// Wire frame names carry no `anno.` prefix, so they are only checked for
// membership; the "declared but unused" direction applies to messages.
const declared = new Set([...runtimeMessages, ...CLIENT_FRAMES, ...SERVER_FRAMES])

/** @param {string} text */
function literals(text) {
  return [...text.matchAll(/'(anno\.[a-z.]+)'/g)].map((match) => match[1])
}

test('every name a runtime file mentions is declared', async () => {
  const problems = []
  for (const file of CONSUMERS) {
    const text = await readFile(join(extensionRoot, file), 'utf8')
    for (const literal of new Set(literals(text))) {
      if (!declared.has(literal)) problems.push(`${file} uses undeclared ${literal}`)
    }
  }
  assert.deepEqual(problems, [])
})

test('the declared contract has no name that no runtime file uses', async () => {
  const used = new Set()
  for (const file of CONSUMERS) {
    const text = await readFile(join(extensionRoot, file), 'utf8')
    for (const literal of literals(text)) used.add(literal)
  }
  const unused = [...runtimeMessages].filter((name) => !used.has(name))
  assert.deepEqual(unused, [], 'declared but unused names drift the contract')
})

test('the pick flow is declared on all three edges', () => {
  assert.equal(TO_CONTENT.pickRequest, 'anno.pick.request')
  assert.equal(TO_CONTENT.pickCancel, 'anno.pick.cancel')
  assert.equal(TO_BACKGROUND.pickResult, 'anno.pick.result')
})

test('the event payload key does not shadow the envelope type', async () => {
  // `anno.event` is the one message whose host frame also carries `type`; the
  // contract renames it to `event` so the envelope key stays unambiguous.
  const routing = await readFile(join(extensionRoot, 'src/background/routing.js'), 'utf8')
  assert.match(routing, /event:\s*type/)
  assert.doesNotMatch(routing, /\{\s*type:\s*'anno\.event',\s*type:/)
})
