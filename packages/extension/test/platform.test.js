/**
 * The platform seam, without a browser.
 *
 * `src/shared/platform.js` is the only file allowed to branch on the engine, so
 * it is exercised against every shape that reaches it:
 *
 *   - Gecko: `browser` exists and a promise-returning `runtime.onMessage`
 *     listener is the documented reply, so the handler must be registered as
 *     written.
 *   - Chromium below 148: only `chrome` exists, and a promise-returning
 *     listener has its channel closed — the caller receives `undefined` unless
 *     the listener answers through `sendResponse` and returns `true`.
 *   - No extension API at all, which is how the test suite loads the file and
 *     what must never throw.
 *
 * The tests run the real file in `node:vm`; only the namespace around it is a
 * stub, so a change in the file is what makes them fail.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)
const PLATFORM_SCRIPT = 'src/shared/platform.js'

/** A `runtime.onMessage` event whose listeners the test can inspect. */
function messageEvent() {
  /** @type {Function[]} */
  const listeners = []
  return { listeners, addListener: (listener) => listeners.push(listener) }
}

/**
 * An extension API just large enough for `platform.js`. `prefix` is the
 * `runtime.getURL('')` prefix, which is the only value the file uses to tell
 * the engines apart.
 * @param {string} prefix
 */
function apiOf(prefix) {
  const onMessage = messageEvent()
  return {
    onMessage,
    api: { runtime: { id: 'dsh-marker@test', getURL: (path) => `${prefix}${path}`, onMessage } },
  }
}

/**
 * Evaluate `platform.js` in a fresh context that has exactly the namespaces
 * given: Chromium gets `chrome` only, Gecko gets `browser`.
 * @param {{ browser?: any, chrome?: any }} namespaces
 * @param {number} [times] how many times to load the file (double injection)
 */
async function loadPlatform({ browser, chrome } = {}, times = 1) {
  /** @type {string[]} */
  const errors = []
  const sandbox = {
    console: {
      debug() {},
      info() {},
      warn: (...args) => errors.push(args.join(' ')),
      error: (...args) => errors.push(args.join(' ')),
    },
  }
  if (browser !== undefined) sandbox.browser = browser
  if (chrome !== undefined) sandbox.chrome = chrome
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  const code = await readFile(join(extensionRoot, PLATFORM_SCRIPT), 'utf8')
  for (let index = 0; index < times; index += 1) vm.runInContext(code, context, { filename: PLATFORM_SCRIPT })
  return { sandbox, errors }
}

/** Collects every `sendResponse` call instead of blocking on the first. */
function captureResponses() {
  /** @type {any[]} */
  const calls = []
  return { calls, sendResponse: (value) => calls.push(value) }
}

/** Let the wrapper's promise chain settle before asserting on it. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** A structural copy, so assertions compare across the `vm` realm boundary. */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

test('Gecko keeps the raw async listener and its own namespace', async () => {
  const gecko = apiOf('moz-extension://test/')
  const { sandbox, errors } = await loadPlatform({ browser: gecko.api })
  const platform = sandbox.__DSH_PLATFORM__
  assert.ok(platform !== undefined, 'platform.js published its namespace')
  assert.equal(platform.isGecko, true)
  assert.equal(platform.isChromium, false)
  assert.equal(sandbox.browser, gecko.api, 'the existing namespace is not replaced')

  const handler = async () => ({ ok: true })
  assert.equal(platform.onMessage(handler), true)
  assert.equal(gecko.onMessage.listeners.length, 1)
  // Gecko's documented form is the promise itself; wrapping it would change the
  // shape every other file already relies on.
  assert.equal(gecko.onMessage.listeners[0], handler)
  assert.deepEqual(errors, [])
})

test('Chromium below 148 gets a `browser` alias and a sendResponse wrapper', async () => {
  const chromium = apiOf('chrome-extension://test/')
  const { sandbox, errors } = await loadPlatform({ chrome: chromium.api })
  const platform = sandbox.__DSH_PLATFORM__
  assert.equal(platform.isChromium, true)
  assert.equal(platform.isGecko, false)
  assert.equal(sandbox.browser, chromium.api, 'the only namespace Chrome has becomes `browser`')

  const handler = async (message, sender) => ({ ok: true, type: message.type, tabId: sender.tab.id })
  assert.equal(platform.onMessage(handler), true)
  const listener = chromium.onMessage.listeners[0]
  assert.notEqual(listener, handler, 'the listener is wrapped, not registered as written')

  const response = captureResponses()
  const returned = listener({ type: 'anno.status' }, { tab: { id: 7 } }, response.sendResponse)
  assert.equal(returned, true, '`true` is what keeps the channel open for the async answer')
  await settle()
  assert.deepEqual(plain(response.calls), [{ ok: true, type: 'anno.status', tabId: 7 }])
  assert.deepEqual(errors, [])
})

test('an unhandled message still answers, so the caller resolves instead of hanging', async () => {
  const chromium = apiOf('chrome-extension://test/')
  const { sandbox } = await loadPlatform({ chrome: chromium.api })
  sandbox.__DSH_PLATFORM__.onMessage(() => undefined)

  const response = captureResponses()
  const returned = chromium.onMessage.listeners[0]({ type: 'not.a.message' }, {}, response.sendResponse)
  assert.equal(returned, true)
  await settle()
  // `undefined` is the answer Gecko gives to a handler that returns nothing; the
  // point is that `sendResponse` was called at all, which is what keeps
  // `sendMessage` from rejecting with "the message port closed".
  assert.equal(response.calls.length, 1)
  assert.equal(response.calls[0], undefined)
})

test('a rejected handler answers with the failure envelope, not a silent channel', async () => {
  const chromium = apiOf('chrome-extension://test/')
  const { sandbox, errors } = await loadPlatform({ chrome: chromium.api })
  sandbox.__DSH_PLATFORM__.onMessage(async () => {
    throw new Error('boom')
  })

  const response = captureResponses()
  chromium.onMessage.listeners[0]({}, {}, response.sendResponse)
  await settle()
  assert.deepEqual(plain(response.calls), [{ ok: false, error: 'boom' }])
  assert.equal(errors.length, 1, 'the failure is reported once')
  assert.match(errors[0], /boom/)
})

test('a global without an extension API loads, and registers nothing', async () => {
  const { sandbox } = await loadPlatform({})
  const platform = sandbox.__DSH_PLATFORM__
  assert.ok(platform !== undefined)
  assert.equal(platform.isChromium, false, 'an unknown engine keeps the tolerant Gecko form')
  assert.equal(
    platform.onMessage(async () => ({ ok: true })),
    false,
    'there is nothing to attach to',
  )
  assert.equal(sandbox.browser, undefined)
})

test('loading the shim twice registers one listener', async () => {
  const chromium = apiOf('chrome-extension://test/')
  const { sandbox } = await loadPlatform({ chrome: chromium.api }, 2)
  assert.equal(chromium.onMessage.listeners.length, 0, 'the file itself registers nothing')
  assert.equal(
    sandbox.__DSH_PLATFORM__.onMessage(async () => undefined),
    true,
  )
  assert.equal(chromium.onMessage.listeners.length, 1)
})
