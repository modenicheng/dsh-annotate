/**
 * Boot the background half outside Firefox.
 *
 * The extension ships as classic scripts with no bundler and no browser test
 * runner, so a typo in one of the six background files would only surface when
 * a user loads the add-on. This harness evaluates them in a `node:vm` context
 * with a permissive `browser` stub, then drives the lifecycle listeners the
 * manifest relies on, which catches load-order mistakes, missing namespace
 * members, and throws during boot.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

const SCRIPTS = [
  'src/shared/protocol.global.js',
  'src/background/core.js',
  'src/background/socket.js',
  'src/background/outbox.js',
  'src/background/capture.js',
  'src/background/routing.js',
  'src/background/main.js',
]

/**
 * An event object whose listeners the test can fire.
 * @param {string} name
 */
function event(name) {
  const listeners = []
  return {
    name,
    listeners,
    addListener: (listener) => listeners.push(listener),
    removeListener: (listener) => {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
    hasListener: (listener) => listeners.includes(listener),
    async fire(...args) {
      // Firefox ignores a listener's returned promise unless the caller awaits;
      // the harness awaits so a rejected boot is visible.
      for (const listener of listeners) await listener(...args)
    },
  }
}

/** @param {any} value */
function resolved(value) {
  return () => Promise.resolve(value)
}

/**
 * The `browser` surface the background touches. Anything not modelled here is
 * a deliberate failure, not a silent no-op: an unknown API means this stub and
 * the code have diverged.
 */
function createBrowserStub() {
  const onMessage = event('runtime.onMessage')
  const onInstalled = event('runtime.onInstalled')
  const onStartup = event('runtime.onStartup')
  const onAlarm = event('alarms.onAlarm')
  const onCommand = event('commands.onCommand')
  const onTabRemoved = event('tabs.onRemoved')
  const onTabUpdated = event('tabs.onUpdated')
  const onTabActivated = event('tabs.onActivated')
  const storageChanged = event('storage.onChanged')

  /** @type {Map<string, any>} */
  const stored = new Map()
  const badge = { text: '', color: undefined }

  const browser = {
    runtime: {
      getManifest: () => ({ version: '0.1.0', manifest_version: 3 }),
      getURL: (path) => `moz-extension://test/${path}`,
      id: 'dsh-annotate@modenic.top',
      onMessage,
      onInstalled,
      onStartup,
      sendMessage: resolved(undefined),
      lastError: undefined,
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys === undefined || keys === null) return Object.fromEntries(stored)
          const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys)
          const out = {}
          for (const key of list) if (stored.has(key)) out[key] = stored.get(key)
          return out
        },
        set: async (patch) => {
          for (const [key, value] of Object.entries(patch)) {
            stored.set(key, value)
            void storageChanged.fire({ [key]: { newValue: value } }, 'local')
          }
        },
        remove: async (key) => {
          for (const name of Array.isArray(key) ? key : [key]) stored.delete(name)
        },
      },
      onChanged: storageChanged,
    },
    alarms: {
      onAlarm,
      create: resolved(undefined),
      clear: resolved(true),
      get: async () => undefined,
      getAll: resolved([]),
    },
    commands: { onCommand },
    tabs: {
      onRemoved: onTabRemoved,
      onUpdated: onTabUpdated,
      onActivated: onTabActivated,
      query: resolved([{ id: 1, url: 'https://example.com/', active: true, windowId: 1 }]),
      sendMessage: resolved(undefined),
      captureVisibleTab: resolved('data:image/png;base64,AAAA'),
      update: resolved(undefined),
    },
    windows: { getLastFocused: resolved({ id: 1 }), update: resolved(undefined) },
    action: {
      setBadgeText: async (details) => {
        badge.text = details.text
      },
      setBadgeBackgroundColor: async (details) => {
        badge.color = details.backgroundColor
      },
      setTitle: resolved(undefined),
    },
  }

  return {
    browser,
    events: { onMessage, onInstalled, onStartup, onAlarm, onCommand, onTabRemoved, onTabUpdated, onTabActivated },
    stored,
    badge,
  }
}

/** @param {string} path */
async function readScript(path) {
  return readFile(join(extensionRoot, path), 'utf8')
}

test('the background boots in manifest order without throwing', async () => {
  const { browser, events } = createBrowserStub()
  /** @type {string[]} */
  const errors = []
  /** @type {any[]} */
  const sockets = []

  class FakeWebSocket {
    /** @param {string} url */
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.sent = []
      sockets.push(this)
    }

    send(data) {
      this.sent.push(data)
    }

    close() {
      this.readyState = 3
    }
  }

  const timers = []
  const sandbox = {
    browser,
    WebSocket: FakeWebSocket,
    console: {
      debug() {},
      info() {},
      warn: (...args) => errors.push(args.join(' ')),
      error: (...args) => errors.push(args.join(' ')),
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimeout() {},
    setInterval: (fn, ms) => {
      timers.push({ fn, ms, repeat: true })
      return timers.length
    },
    clearInterval() {},
    structuredClone: (value) => JSON.parse(JSON.stringify(value)),
    URL,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    navigator: { userAgent: 'node', language: 'en-US' },
    document: undefined,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)

  for (const path of SCRIPTS) {
    const code = await readScript(path)
    try {
      vm.runInContext(code, context, { filename: path })
    } catch (error) {
      throw new Error(`${path} threw while loading: ${error.message}`)
    }
  }

  const ns = sandbox.__DSH_ANNO_BG__
  assert.ok(ns !== undefined, 'background namespace was published')
  for (const member of ['PROTOCOL', 'msg', 'log', 'status', 'routing', 'outbox', 'net', 'capture']) {
    assert.ok(ns[member] !== undefined, `namespace is missing ${member}`)
  }
  assert.equal(ns.PROTOCOL.PROTOCOL_VERSION, 1)
  assert.equal(ns.msg.TO_BACKGROUND.submit, 'anno.submit')

  // The event page must have registered its lifecycle listeners synchronously.
  assert.ok(events.onStartup.listeners.length >= 1, 'onStartup listener registered')
  assert.ok(events.onMessage.listeners.length >= 1, 'onMessage listener registered')
  assert.ok(events.onAlarm.listeners.length >= 1, 'onAlarm listener registered')

  await events.onStartup.fire()
  assert.deepEqual(errors, [], `boot logged problems: ${errors.join(' | ')}`)

  // Message handling must answer a known type and ignore an unknown one.
  const listener = events.onMessage.listeners[0]
  const unknown = await listener({ type: 'not.a.message' }, {})
  assert.equal(unknown, undefined)
  const status = await listener({ type: 'anno.status' }, {})
  assert.equal(typeof status, 'object')
  assert.equal(status.ok, true)
  assert.ok('connection' in status)
  assert.equal(status.protocolVersion, 1)
})

test('every script listed by the manifest exists', async () => {
  const manifest = JSON.parse(await readScript('manifest.json'))
  const referenced = new Set()
  for (const script of manifest.background?.scripts ?? []) referenced.add(script)
  for (const entry of manifest.content_scripts ?? []) for (const script of entry.js ?? []) referenced.add(script)
  referenced.add(manifest.action.default_popup)
  for (const path of referenced) await readScript(path)
})
