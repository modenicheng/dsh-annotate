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
  'src/background/endpoints.js',
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

/** @param {() => boolean} predicate @param {number} [timeoutMs] */
async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('the background did not reach the expected state in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Boot the background in a fresh `vm` context and wait for its first connection
 * attempt to settle.
 *
 * `main.js` starts booting as soon as it loads, so the stored token has to exist
 * before the scripts are evaluated; otherwise the first attempt stops at
 * `no-token` and no socket is ever constructed.
 * @param {{ token?: string, fetch?: (url: string) => Promise<any> }} [options]
 */
async function bootBackground(options = {}) {
  const {
    token = 'test-token',
    fetch = async () => {
      throw new Error('offline')
    },
  } = options
  const { browser, events, stored, badge } = createBrowserStub()
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
    fetch,
    AbortController,
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
  if (token !== '') stored.set('anno.token', token)

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
  // The page load kicks off `boot()`; wait for its `connect()` to reach either
  // a constructed socket or a terminal early return.
  await waitUntil(
    () =>
      sockets.length > 0 ||
      ns.netState.connection === 'no-token' ||
      ns.netState.connection === 'offline' ||
      ns.netState.connection === 'error',
  )
  return { sandbox, ns, errors, sockets, events, stored, badge, timers }
}

/** A health body shaped like the host's, for the probe stubs below. */
function healthBody({ secure = false, wsUrl = 'ws://127.0.0.1:3080/ext/anno' } = {}) {
  return { ok: true, version: 1, secure, wsUrl }
}

test('the background boots in manifest order without throwing', async () => {
  /** @type {string[]} */
  const fetchCalls = []
  const { ns, errors, sockets, events } = await bootBackground({
    fetch: async (url) => {
      fetchCalls.push(url)
      return { ok: true, status: 200, json: async () => healthBody() }
    },
  })

  for (const member of ['PROTOCOL', 'msg', 'log', 'status', 'routing', 'outbox', 'net', 'capture', 'endpoints']) {
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

  // The default local path is plain HTTP: one probe to http (never https), and
  // the host's `secure: false` answer yields ws://. With the MV3 default CSP
  // this request would have been upgraded to https and the socket to wss; the
  // manifest's explicit CSP is what keeps that from happening.
  assert.deepEqual(fetchCalls, ['http://127.0.0.1:3080/ext/anno/health'])
  assert.equal(sockets.length, 1)
  assert.equal(sockets[0].url, 'ws://127.0.0.1:3080/ext/anno')
  assert.equal(ns.netState.wsUrlSource, 'health')
  assert.equal(ns.netState.secure, false)

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

test('the background connects with wss when the host advertises it', async () => {
  const { ns, sockets } = await bootBackground({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => healthBody({ secure: true, wsUrl: 'wss://127.0.0.1:3080/ext/anno' }),
    }),
  })
  assert.equal(sockets[0].url, 'wss://127.0.0.1:3080/ext/anno')
  assert.equal(ns.netState.secure, true)
  assert.equal(ns.netState.wsUrlSource, 'health')
})

test('a failing health probe falls back to the configured address', async () => {
  const { ns, sockets, errors } = await bootBackground({
    fetch: async () => {
      throw new Error('connection refused')
    },
  })
  assert.equal(sockets[0].url, 'ws://127.0.0.1:3080/ext/anno')
  assert.equal(ns.netState.wsUrlSource, 'configured')
  assert.match(ns.netState.discoveryError, /connection refused/)
  assert.deepEqual(errors, [], `a failed probe must not log as a warning: ${errors.join(' | ')}`)
})

test('a submitted draft keeps the click-time snapshot in the queued record', async () => {
  // The content script freezes the frame the user clicked in; the background is
  // the one that rebuilds the record, so this is the seam where a field can be
  // lost without anyone noticing until a card shows the wrong moment.
  const { ns, events } = await bootBackground({
    fetch: async () => ({ ok: true, status: 200, json: async () => healthBody() }),
  })
  const snapshot = {
    at: '2026-11-19T11:51:07.943Z',
    rect: { x: 556, y: 553, w: 920, h: 337 },
    viewport: { width: 2032, height: 1216, dpr: 1.25, scrollX: 0, scrollY: 0 },
  }
  const answer = await events.onMessage.listeners[0](
    {
      type: 'anno.submit',
      record: {
        url: 'http://127.0.0.1:3099/',
        title: 'Greeting',
        anchor: {
          kind: 'selection',
          quote: { exact: 'chip delivery', prefix: '', suffix: '' },
          rect: { x: 1, y: 2, w: 3, h: 4 },
        },
        comment: '看看这条',
        snapshot,
      },
      cropRect: snapshot.rect,
      viewport: { width: 2032, height: 1216, devicePixelRatio: 1.25 },
    },
    { tab: { id: 1, windowId: 1, url: 'http://127.0.0.1:3099/' } },
  )

  assert.equal(answer.ok, true)
  assert.equal(ns.PROTOCOL.validateRecord(answer.record).length, 0)
  // Cross-realm objects: compare the projection, not the prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(answer.record.snapshot)), snapshot)
})

test('the page names the chip, even when no target Session was picked', async () => {
  // The Host routes an untargeted annotation to the Session on screen, so the
  // label has to survive even though `routing.sessionId` is absent: the Host
  // cannot reproduce the page's own wording for "批注 · …".
  const { ns, events } = await bootBackground({
    fetch: async () => ({ ok: true, status: 200, json: async () => healthBody() }),
  })
  const answer = await events.onMessage.listeners[0](
    {
      type: 'anno.submit',
      record: {
        url: 'http://127.0.0.1:3099/',
        title: 'Greeting',
        anchor: { kind: 'region', pageRect: { x: 1, y: 2, w: 30, h: 40 }, viewportRect: { x: 1, y: 2, w: 30, h: 40 } },
        comment: '',
        routing: { source: 'user', label: '批注 · 30×40' },
      },
      cropRect: { x: 1, y: 2, w: 30, h: 40 },
      viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    },
    { tab: { id: 1, windowId: 1, url: 'http://127.0.0.1:3099/' } },
  )

  assert.equal(answer.ok, true)
  assert.equal(answer.record.routing.label, '批注 · 30×40')
  assert.equal(answer.record.routing.sessionId, undefined)
  assert.equal(ns.PROTOCOL.validateRecord(answer.record).length, 0)
})

test('every script listed by the manifest exists', async () => {
  const manifest = JSON.parse(await readScript('manifest.json'))
  const referenced = new Set()
  for (const script of manifest.background?.scripts ?? []) referenced.add(script)
  for (const entry of manifest.content_scripts ?? []) for (const script of entry.js ?? []) referenced.add(script)
  referenced.add(manifest.action.default_popup)
  for (const path of referenced) await readScript(path)
})
