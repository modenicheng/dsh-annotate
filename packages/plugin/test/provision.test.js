import assert from 'node:assert/strict'
import test from 'node:test'

import { SESSION_CREATE_PATH } from '../src/protocol.js'
import { createProvisioner, registerProvisionRoutes } from '../src/provision.js'

/**
 * @param {object} services
 * @returns {(name: string) => any}
 */
function lookup(services) {
  return (name) => services[name]
}

function services(overrides = {}) {
  const created = []
  return {
    __created: created,
    sessionController: {
      create: async (request) => {
        created.push(request)
        return { sessionId: `s-${created.length}` }
      },
    },
    workspaceRegistry: {
      list: () => [
        { id: 'w-alpha', title: 'alpha', path: 'D:/coding/alpha', sessionIds: [] },
        { id: 'w-beta', title: 'beta', path: 'D:/coding/beta', sessionIds: [] },
      ],
      create: async (path, title) => ({ id: 'w-made', title: title ?? 'made', path }),
    },
    ...overrides,
  }
}

/** @param {object} services */
function provisionerOf(svc, onCreated) {
  return createProvisioner({ get: lookup(svc), onCreated, logger: { warn() {} } })
}

test('listWorkspaces reports the registry rows', async () => {
  const svc = services()
  assert.deepEqual(await provisionerOf(svc).listWorkspaces(), [
    { id: 'w-alpha', title: 'alpha', path: 'D:/coding/alpha' },
    { id: 'w-beta', title: 'beta', path: 'D:/coding/beta' },
  ])
})

test('mode default asks the controller for its own default location', async () => {
  const svc = services()
  const value = await provisionerOf(svc).createSession({ mode: 'default' })

  assert.deepEqual(value, { sessionId: 's-1', workspace: null })
  assert.deepEqual(svc.__created, [{}])
})

test('mode existing joins the named workspace', async () => {
  const svc = services()
  const value = await provisionerOf(svc).createSession({ mode: 'existing', workspaceId: 'w-beta' })

  assert.equal(value.sessionId, 's-1')
  assert.deepEqual(value.workspace, { id: 'w-beta', title: 'beta', path: 'D:/coding/beta' })
  assert.deepEqual(svc.__created, [{ workspaceId: 'w-beta' }])
})

test('mode existing refuses a workspace the registry no longer has', async () => {
  const svc = services()
  await assert.rejects(
    provisionerOf(svc).createSession({ mode: 'existing', workspaceId: 'w-gone' }),
    /no longer exists/,
  )
  assert.equal(svc.__created.length, 0)
})

test('mode new registers the directory first and joins it', async () => {
  const svc = services()
  const value = await provisionerOf(svc).createSession({
    mode: 'new',
    path: 'D:/coding/fresh',
    title: 'Fresh',
  })

  assert.equal(value.workspace.id, 'w-made')
  assert.equal(value.workspace.path, 'D:/coding/fresh')
  assert.deepEqual(svc.__created, [{ workspaceId: 'w-made' }])
})

test('a created session reports through onCreated', async () => {
  const seen = []
  await provisionerOf(services(), (event) => seen.push(event)).createSession({ mode: 'default' })

  assert.deepEqual(seen, [{ sessionId: 's-1', workspace: null }])
})

test('a controller without a session identity is refused', async () => {
  const svc = services({ sessionController: { create: async () => ({}) } })
  await assert.rejects(provisionerOf(svc).createSession({ mode: 'default' }), /no identity/)
})

test('a missing registry is refused for workspace modes, not for default', async () => {
  const bare = { sessionController: { create: async () => ({ sessionId: 's-x' }) } }
  await provisionerOf(bare).createSession({ mode: 'default' })
  await assert.rejects(provisionerOf(bare).listWorkspaces(), /workspace registry/)
  await assert.rejects(provisionerOf(bare).createSession({ mode: 'new', path: 'D:/x' }), /workspace registry/)
})

// ── the route ────────────────────────────────────────────────────────────────

/** @param {object} options */
function mount(options) {
  let handler = null
  const webServer = {
    register(route) {
      handler = route.handler
      return () => {}
    },
  }
  registerProvisionRoutes(webServer, options)
  return { handler }
}

/**
 * One request with a JSON body the handler can read.
 * @param {any} handler
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init]
 */
function call(handler, url, init = {}) {
  return new Promise((resolve) => {
    let status = 0
    const response = {
      writeHead: (code) => {
        status = code
      },
      end: (body) => resolve({ status, body: body === undefined ? undefined : JSON.parse(body) }),
    }
    const listeners = new Map()
    const request = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers ?? {},
      on(event, listener) {
        listeners.set(event, listener)
      },
      destroy() {},
    }
    handler(request, response)
    if (init.method === 'POST') {
      listeners.get('data')?.(Buffer.from(init.body ?? ''))
      listeners.get('end')?.()
    }
  })
}

const authed = {
  token: 'secret',
  matchesToken: (presented, expected) => presented === expected,
}

function mountedProvisioner(svc = services(), onCreated) {
  return mount({ provisioner: provisionerOf(svc, onCreated), ...authed })
}

test('the route rejects a missing or wrong token before touching services', async () => {
  const svc = services()
  const { handler } = mount({ provisioner: provisionerOf(svc), token: 'secret', matchesToken: () => false })

  const barePost = await call(handler, SESSION_CREATE_PATH, { method: 'POST', body: '{}' })
  assert.equal(barePost.status, 401)
  const posted = await call(handler, `${SESSION_CREATE_PATH}?token=nope`, { method: 'POST', body: '{}' })
  assert.equal(posted.status, 401)
  assert.equal(svc.__created.length, 0)
})

test('the route answers a valid create and returns the session', async () => {
  const { handler } = mountedProvisioner()

  const reply = await call(handler, SESSION_CREATE_PATH, {
    method: 'POST',
    headers: { 'x-anno-token': 'secret' },
    body: JSON.stringify({ mode: 'existing', workspaceId: 'w-alpha' }),
  })
  assert.equal(reply.status, 200)
  assert.equal(reply.body.ok, true)
  assert.equal(reply.body.sessionId, 's-1')
  assert.equal(reply.body.workspace.id, 'w-alpha')
})

test('the route refuses an invalid body with the validator message', async () => {
  const svc = services()
  const { handler } = mountedProvisioner(svc)

  const relative = await call(handler, SESSION_CREATE_PATH, {
    method: 'POST',
    headers: { 'x-anno-token': 'secret' },
    body: JSON.stringify({ mode: 'new', path: 'projects/app' }),
  })
  assert.equal(relative.status, 400)
  assert.match(relative.body.message, /absolute/)
  assert.equal(svc.__created.length, 0)

  const badMode = await call(handler, SESSION_CREATE_PATH, {
    method: 'POST',
    headers: { 'x-anno-token': 'secret' },
    body: JSON.stringify({ mode: 'elsewhere' }),
  })
  assert.equal(badMode.status, 400)
})

test('the route reports host failures without leaking a stack', async () => {
  const broken = services({
    sessionController: {
      create: async () => {
        throw new Error('no preset')
      },
    },
  })
  const { handler } = mountedProvisioner(broken)

  const { status, body } = await call(handler, SESSION_CREATE_PATH, {
    method: 'POST',
    headers: { 'x-anno-token': 'secret' },
    body: JSON.stringify({ mode: 'default' }),
  })
  assert.equal(status, 500)
  assert.equal(body.error, 'create')
  assert.equal(body.message, 'no preset')
  assert.equal(body.stack, undefined)
})

test('the route refuses methods other than POST and answers preflight', async () => {
  const { handler } = mountedProvisioner()

  assert.equal((await call(handler, SESSION_CREATE_PATH)).status, 405)
  assert.equal((await call(handler, SESSION_CREATE_PATH, { method: 'OPTIONS' })).status, 204)
  assert.equal(
    (await call(handler, SESSION_CREATE_PATH, { method: 'HEAD', headers: { 'x-anno-token': 'secret' } })).status,
    200,
  )
})

test('an oversized body is refused without reaching the services', async () => {
  const svc = services()
  const { handler } = mountedProvisioner(svc)

  const { status } = await call(handler, SESSION_CREATE_PATH, {
    method: 'POST',
    headers: { 'x-anno-token': 'secret' },
    body: 'x'.repeat(5_000),
  })
  assert.equal(status, 500)
  assert.equal(svc.__created.length, 0)
})
