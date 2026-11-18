import assert from 'node:assert/strict'
import test from 'node:test'

import { SESSIONS_PATH } from '../src/protocol.js'
import { createSessionCatalog, registerSessionsRoute } from '../src/sessions.js'

/**
 * @param {object} services
 * @returns {(name: string) => any}
 */
function lookup(services) {
  return (name) => services[name]
}

function services(overrides = {}) {
  return {
    sessionController: {
      list: async () => ({
        items: [
          {
            sessionId: 's-old',
            updatedAt: 1_000,
            running: false,
            blank: false,
            agentAvailable: false,
            cwd: 'D:/coding/alpha',
          },
          {
            sessionId: 's-new',
            updatedAt: 3_000,
            running: true,
            blank: false,
            agentAvailable: true,
            cwd: 'D:/coding/beta',
          },
          { sessionId: 's-child', updatedAt: 9_000, origin: 'subagent', blank: false },
          { sessionId: 's-blank', updatedAt: 2_000, blank: true, agentAvailable: false },
        ],
      }),
    },
    sessionQuery: {
      readTitleSnapshots: async (ids) =>
        ids.map((sessionId) => ({
          sessionId,
          status: 'fulfilled',
          value: { session: { id: sessionId }, title: { title: `title:${sessionId}` } },
        })),
    },
    workspaceRegistry: {
      list: () => [
        { id: 'w-alpha', title: 'alpha', path: 'D:/coding/alpha', sessionIds: ['s-old'] },
        { id: 'w-beta', title: 'beta', path: 'D:/coding/beta', sessionIds: ['s-new', 's-blank'] },
      ],
    },
    ...overrides,
  }
}

test('catalog sorts by activity and hides subagent sessions', async () => {
  const catalog = createSessionCatalog({ get: lookup(services()) })
  const result = await catalog.list()

  assert.deepEqual(
    result.items.map((item) => item.id),
    ['s-new', 's-blank', 's-old'],
  )
  assert.equal(result.total, 3)
  assert.equal(result.truncated, false)
})

test('catalog carries title, workspace and activity per row', async () => {
  const catalog = createSessionCatalog({ get: lookup(services()) })
  const [first] = (await catalog.list()).items

  assert.equal(first.title, 'title:s-new')
  assert.equal(first.updatedAt, 3_000)
  assert.equal(first.running, true)
  assert.equal(first.agentAvailable, true)
  assert.equal(first.cwd, 'D:/coding/beta')
  assert.deepEqual(first.workspace, { id: 'w-beta', title: 'beta', path: 'D:/coding/beta' })
})

test('catalog leaves workspace null when no workspace claims the session', async () => {
  const catalog = createSessionCatalog({ get: lookup(services()) })
  const orphan = (await catalog.list()).items.find((item) => item.id === 's-blank')

  assert.equal(orphan.workspace.id, 'w-beta')
  const without = createSessionCatalog({ get: lookup(services({ workspaceRegistry: { list: () => [] } })) })
  assert.equal((await without.list()).items[0].workspace, null)
})

test('catalog lists subagent sessions only on request', async () => {
  const catalog = createSessionCatalog({ get: lookup(services()) })
  const result = await catalog.list({ includeSubagents: true })

  assert.equal(result.items[0].id, 's-child')
  assert.equal(result.total, 4)
})

test('catalog filters on title, id, cwd and workspace name', async () => {
  const catalog = createSessionCatalog({ get: lookup(services()) })

  assert.deepEqual(
    (await catalog.list({ query: 'ALPHA' })).items.map((item) => item.id),
    ['s-old'],
  )
  assert.deepEqual(
    (await catalog.list({ query: 's-blank' })).items.map((item) => item.id),
    ['s-blank'],
  )
  assert.deepEqual(
    (await catalog.list({ query: 'title:s-new' })).items.map((item) => item.id),
    ['s-new'],
  )
  assert.equal((await catalog.list({ query: 'nothing-matches' })).items.length, 0)
})

test('catalog reports truncation when the limit cuts rows', async () => {
  const catalog = createSessionCatalog({ get: lookup(services()) })
  const result = await catalog.list({ limit: 2 })

  assert.equal(result.items.length, 2)
  assert.equal(result.total, 3)
  assert.equal(result.truncated, true)
})

test('catalog degrades to untitled rows when titles are unavailable', async () => {
  const failing = services({
    sessionQuery: {
      readTitleSnapshots: async () => {
        throw new Error('title backend offline')
      },
    },
  })
  const warnings = []
  const catalog = createSessionCatalog({ get: lookup(failing), logger: { warn: (line) => warnings.push(line) } })
  const result = await catalog.list()

  assert.equal(result.items.length, 3)
  assert.equal(result.items[0].title, '')
  assert.match(warnings.join('\n'), /session titles unavailable/u)
})

test('catalog fails loudly when the session controller is missing', async () => {
  const catalog = createSessionCatalog({ get: lookup({}) })
  await assert.rejects(() => catalog.list(), /session controller is not mounted/u)
})

/**
 * Capture the registered handler and drive it with minimal fakes.
 * @param {object} registration
 */
function mount(registration) {
  let handler
  const webServer = {
    register: (route) => {
      assert.equal(route.path, SESSIONS_PATH)
      handler = route.handler
      return () => {}
    },
  }
  const dispose = registerSessionsRoute(webServer, registration)
  return { dispose, handler }
}

/**
 * @param {string} url
 * @param {object} [init]
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
    handler({ method: init.method ?? 'GET', url, headers: init.headers ?? {} }, response)
  })
}

test('catalog keeps untitled rows when one title in the batch is rejected', async () => {
  const mixed = services({
    sessionQuery: {
      readTitleSnapshots: async (ids) =>
        ids.map((sessionId) =>
          sessionId === 's-old'
            ? { sessionId, status: 'rejected', reason: new Error('log missing') }
            : {
                sessionId,
                status: 'fulfilled',
                value: { session: { id: sessionId }, title: { title: `title:${sessionId}` } },
              },
        ),
    },
  })
  const catalog = createSessionCatalog({ get: lookup(mixed) })
  const items = (await catalog.list()).items

  assert.equal(items.find((item) => item.id === 's-old').title, '')
  assert.equal(items.find((item) => item.id === 's-new').title, 'title:s-new')
})

test('the route rejects a missing or wrong token', async () => {
  const { handler } = mount({
    catalog: createSessionCatalog({ get: lookup(services()) }),
    token: 'secret',
    matchesToken: (presented, expected) => presented === expected,
  })

  assert.equal((await call(handler, SESSIONS_PATH)).status, 401)
  assert.equal((await call(handler, `${SESSIONS_PATH}?token=nope`)).status, 401)
  assert.equal((await call(handler, SESSIONS_PATH, { headers: { authorization: 'Bearer nope' } })).status, 401)
})

test('the route accepts query, bearer and header tokens', async () => {
  const catalog = createSessionCatalog({ get: lookup(services()) })
  const { handler } = mount({ catalog, token: 'secret', matchesToken: (a, b) => a === b })

  for (const url of [`${SESSIONS_PATH}?token=secret`, `${SESSIONS_PATH}?token=secret&limit=1`]) {
    const { status, body } = await call(handler, url)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
  }

  const bearer = await call(handler, SESSIONS_PATH, { headers: { authorization: 'Bearer secret' } })
  assert.equal(bearer.status, 200)

  const custom = await call(handler, SESSIONS_PATH, { headers: { 'x-anno-token': 'secret' } })
  assert.equal(custom.status, 200)
})

test('the route answers the catalog with a default target', async () => {
  const { handler } = mount({
    catalog: createSessionCatalog({ get: lookup(services()) }),
    token: 'secret',
    matchesToken: (a, b) => a === b,
  })
  const { body } = await call(handler, `${SESSIONS_PATH}?token=secret&limit=2`)

  assert.deepEqual(
    body.items.map((item) => item.id),
    ['s-new', 's-blank'],
  )
  assert.equal(body.defaultSessionId, 's-new')
  assert.equal(body.truncated, true)
})

test('the route reports catalog failures without leaking a stack', async () => {
  const catalog = {
    list: async () => {
      throw new Error('boom')
    },
  }
  const { handler } = mount({ catalog, token: 'secret', matchesToken: (a, b) => a === b })
  const { status, body } = await call(handler, `${SESSIONS_PATH}?token=secret`)

  assert.equal(status, 500)
  assert.equal(body.error, 'catalog')
  assert.equal(body.message, 'boom')
  assert.equal(body.stack, undefined)
})

test('the route answers CORS preflight without a token', async () => {
  const { handler } = mount({
    catalog: createSessionCatalog({ get: lookup(services()) }),
    token: 'secret',
    matchesToken: () => false,
  })
  const { status } = await call(handler, SESSIONS_PATH, { method: 'OPTIONS' })

  assert.equal(status, 204)
})
