import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** A catalog stub answering from fixed rows, optionally failing. */
function catalogOf(rows, fail = false) {
  return {
    list: async () => {
      if (fail) throw new Error('catalog down')
      return { items: rows }
    },
  }
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

test('mode existing reuses the workspace blank session instead of minting one', async () => {
  const svc = services()
  const catalog = catalogOf([
    { id: 'busy-1', blank: false, updatedAt: 30, workspace: { id: 'w-beta' } },
    { id: 'blank-old', blank: true, updatedAt: 10, workspace: { id: 'w-beta' } },
    { id: 'blank-fresh', blank: true, updatedAt: 20, workspace: { id: 'w-beta' } },
    { id: 'blank-elsewhere', blank: true, updatedAt: 40, workspace: { id: 'w-alpha' } },
  ])
  await createProvisioner({ get: lookup(svc), catalog, logger: { warn() {} } }).createSession({
    mode: 'existing',
    workspaceId: 'w-beta',
  })

  // The newest blank of that workspace is named for reuse; the controller
  // re-checks blankness itself, so this is a suggestion, not an assertion.
  assert.deepEqual(svc.__created, [{ workspaceId: 'w-beta', sessionId: 'blank-fresh' }])
})

test('no blank in the workspace mints a new session', async () => {
  const svc = services()
  const catalog = catalogOf([{ id: 'busy-1', blank: false, updatedAt: 30, workspace: { id: 'w-beta' } }])
  await createProvisioner({ get: lookup(svc), catalog, logger: { warn() {} } }).createSession({
    mode: 'existing',
    workspaceId: 'w-beta',
  })

  assert.deepEqual(svc.__created, [{ workspaceId: 'w-beta' }])
})

test('a failed blank lookup still creates the session', async () => {
  const svc = services()
  await createProvisioner({
    get: lookup(svc),
    catalog: catalogOf([], true),
    logger: { warn() {} },
  }).createSession({ mode: 'existing', workspaceId: 'w-beta' })

  assert.deepEqual(svc.__created, [{ workspaceId: 'w-beta' }])
})

test('mode default does not look for a blank to reuse', async () => {
  const svc = services()
  const catalog = catalogOf([{ id: 'blank-1', blank: true, updatedAt: 10, workspace: { id: 'w-alpha' } }])
  await createProvisioner({ get: lookup(svc), catalog, logger: { warn() {} } }).createSession({ mode: 'default' })

  assert.deepEqual(svc.__created, [{}])
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

test('a missing workspace directory is created, then registered', async () => {
  // The real registry canonicalises through realpath and never mkdirs; this
  // stub reproduces that contract so the retry path stays honest.
  const dir = join(tmpdir(), `dsh-marker-provision-${randomBytes(4).toString('hex')}`)
  const attempts = []
  const svc = services({
    workspaceRegistry: {
      list: () => [{ id: 'w-alpha', title: 'alpha', path: 'D:/coding/alpha', sessionIds: [] }],
      create: async (path, title) => {
        attempts.push(path)
        if (attempts.length === 1) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), {
            code: 'ENOENT',
          })
        }
        return { id: 'w-made', title: title ?? 'made', path }
      },
    },
  })

  const value = await provisionerOf(svc).createSession({ mode: 'new', path: dir })
  assert.equal(value.workspace.id, 'w-made')
  assert.equal(attempts.length, 2)
  assert.equal((await stat(dir)).isDirectory(), true)
  await rm(dir, { recursive: true, force: true })
})

test('a directory the registry still refuses after mkdir reports the failure', async () => {
  const dir = join(tmpdir(), `dsh-marker-provision-${randomBytes(4).toString('hex')}`)
  const svc = services({
    workspaceRegistry: {
      list: () => [],
      create: async (path) => {
        throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), {
          code: 'ENOENT',
        })
      },
    },
  })

  await assert.rejects(provisionerOf(svc).createSession({ mode: 'new', path: dir }), /could not be created/)
  await rm(dir, { recursive: true, force: true })
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
