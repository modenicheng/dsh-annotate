import assert from 'node:assert/strict'
import test from 'node:test'

import { SESSIONS_PATH } from '../src/protocol.js'
import { createSessionCatalog, registerSessionsRoute } from '../src/sessions.js'

/** Auth the header-only world uses everywhere: the token rides the dedicated header. */
const AUTH = { headers: { 'x-anno-token': 'secret' } }

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

test('a fold that failed backs off instead of running on every request', async () => {
  let attempts = 0
  let clock = 1_000
  const offline = services({
    sessionQuery: {
      readTitleSnapshots: async () => {
        attempts += 1
        throw new Error('title backend offline')
      },
    },
  })
  const catalog = createSessionCatalog({ get: lookup(offline), now: () => clock })

  await catalog.list()
  clock += 1_000
  await catalog.list()

  assert.equal(attempts, 1, 'the second open backs off instead of folding again')
})

test('catalog fails loudly when the session controller is missing', async () => {
  const catalog = createSessionCatalog({ get: lookup({}) })
  await assert.rejects(() => catalog.list(), /session controller is not mounted/u)
})

/**
 * Wrap the fixtures so every title fold is recorded.
 * @param {object} [overrides]
 */
function counting(overrides = {}) {
  const fixture = services(overrides)
  /** @type {string[][]} */
  const calls = []
  const read = fixture.sessionQuery.readTitleSnapshots
  fixture.sessionQuery = {
    readTitleSnapshots: async (ids, signal) => {
      calls.push([...ids])
      return read(ids, signal)
    },
  }
  return { services: fixture, calls }
}

test('a title the summary already carries costs no fold at all', async () => {
  const hinted = counting({
    sessionController: {
      list: async () => ({
        items: [
          {
            sessionId: 's-hinted',
            updatedAt: 5_000,
            projections: { kind: 'cached', asOfSeq: 12, values: { title: '投影里的标题' } },
          },
        ],
      }),
    },
  })
  const catalog = createSessionCatalog({ get: lookup(hinted.services) })
  const [item] = (await catalog.list()).items

  assert.equal(item.title, '投影里的标题')
  assert.deepEqual(hinted.calls, [], 'the projection hint is authoritative')
})

test('a plain open folds only the rows it is about to draw', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({ sessionId: `s-${index}`, updatedAt: 1_000 + index }))
  const folded = counting({ sessionController: { list: async () => ({ items: rows }) } })
  const catalog = createSessionCatalog({ get: lookup(folded.services) })
  const result = await catalog.list({ limit: 2 })

  assert.deepEqual(folded.calls, [['s-29', 's-28']])
  assert.equal(result.total, 30)
  assert.equal(result.truncated, true)
  assert.equal(result.items[0].title, 'title:s-29')
})

test('a search folds every row, because a title is searchable', async () => {
  const folded = counting()
  const catalog = createSessionCatalog({ get: lookup(folded.services) })

  assert.deepEqual(
    (await catalog.list({ query: 'title:s-old' })).items.map((item) => item.id),
    ['s-old'],
  )
  assert.deepEqual(folded.calls, [['s-new', 's-blank', 's-old']], 'subagent rows stay out of it')
})

test('a folded title is memoized across opens, so a picker is slow once', async () => {
  let clock = 1_000
  const folded = counting()
  const catalog = createSessionCatalog({ get: lookup(folded.services), now: () => clock })

  await catalog.list()
  clock += 5_000
  await catalog.list()

  assert.equal(folded.calls.length, 1)
})

test('the warm-up pays the fold before the picker asks', async () => {
  const folded = counting()
  const catalog = createSessionCatalog({ get: lookup(folded.services), now: () => 1_000 })

  await catalog.warm()
  await catalog.list()

  assert.equal(folded.calls.length, 1)
  assert.equal(folded.calls[0].length, 3)
})

test('a warm-up that cannot read the catalog is a warning, not a crash', async () => {
  const warnings = []
  const catalog = createSessionCatalog({
    get: lookup({}),
    logger: { warn: (line) => warnings.push(line) },
  })

  await catalog.warm()
  assert.match(warnings.join('\n'), /catalog warm-up failed/u)
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
  assert.equal((await call(handler, `${SESSIONS_PATH}?token=secret`)).status, 401)
  assert.equal((await call(handler, SESSIONS_PATH, { headers: { authorization: 'Bearer nope' } })).status, 401)
})

test('the route accepts bearer and header tokens but never a query token', async () => {
  const catalog = createSessionCatalog({ get: lookup(services()) })
  const { handler } = mount({ catalog, token: 'secret', matchesToken: (a, b) => a === b })

  const bearer = await call(handler, SESSIONS_PATH, { headers: { authorization: 'Bearer secret' } })
  assert.equal(bearer.status, 200)
  assert.equal(bearer.body.ok, true)

  const custom = await call(handler, SESSIONS_PATH, { headers: { 'x-anno-token': 'secret' } })
  assert.equal(custom.status, 200)

  // The URL never carries credentials: even a correct token in the query string is refused.
  for (const url of [`${SESSIONS_PATH}?token=secret`, `${SESSIONS_PATH}?token=secret&limit=1`]) {
    assert.equal((await call(handler, url)).status, 401)
  }
})

test('the route answers the catalog with a default target', async () => {
  const { handler } = mount({
    catalog: createSessionCatalog({ get: lookup(services()) }),
    token: 'secret',
    matchesToken: (a, b) => a === b,
  })
  const { body } = await call(handler, `${SESSIONS_PATH}?limit=2`, { headers: { 'x-anno-token': 'secret' } })

  assert.deepEqual(
    body.items.map((item) => item.id),
    ['s-new', 's-blank'],
  )
  assert.equal(body.defaultSessionId, 's-new')
  assert.equal(body.truncated, true)
})

test('the Session the Client is showing becomes the default target, while it is listed', async () => {
  const registration = {
    catalog: createSessionCatalog({ get: lookup(services()) }),
    token: 'secret',
    matchesToken: (a, b) => a === b,
    preferred: () => 's-blank',
  }
  const { handler } = mount(registration)
  assert.equal((await call(handler, SESSIONS_PATH, AUTH)).body.defaultSessionId, 's-blank')

  // A hint for a Session this catalog no longer lists is not a choice.
  const gone = mount({ ...registration, preferred: () => 's-deleted' })
  assert.equal((await call(gone.handler, SESSIONS_PATH, AUTH)).body.defaultSessionId, 's-new')

  // And with no hint at all, activity decides, as before.
  const quiet = mount({ ...registration, preferred: () => undefined })
  assert.equal((await call(quiet.handler, SESSIONS_PATH, AUTH)).body.defaultSessionId, 's-new')
})

test('the route reports catalog failures without leaking a stack', async () => {
  const catalog = {
    list: async () => {
      throw new Error('boom')
    },
  }
  const { handler } = mount({ catalog, token: 'secret', matchesToken: (a, b) => a === b })
  const { status, body } = await call(handler, SESSIONS_PATH, { headers: { 'x-anno-token': 'secret' } })

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
