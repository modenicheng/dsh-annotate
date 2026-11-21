/**
 * Append-only annotation store.
 *
 * One JSONL file under `$DSH_HOME/annotations` holds every mutation as an
 * event line; the in-memory map is a fold over those lines. Images never enter
 * the log — only the attachment reference the host issued does.
 *
 * Events:
 *   { op: 'put', ts, seq, id, data: AnnotationRecord }
 *   { op: 'patch', ts, seq, id, data: Partial<AnnotationRecord> }
 *   { op: 'del', ts, seq, id }
 *   { op: 'img', ts, seq, id, ref: ImageAttachmentRef }
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LOG_NAME = 'queue.jsonl'
/** Compact once the log is both long and mostly superseded. */
const COMPACT_MIN_LINES = 2_000

/**
 * @typedef {import('./protocol.js').AnnotationRecord} AnnotationRecord
 */

export class AnnotationStore {
  /**
   * @param {{ dir: string, logger?: { debug: Function, warn: Function } }} options
   */
  constructor({ dir, logger }) {
    this.dir = dir
    this.logger = logger ?? { debug() {}, warn() {} }
    /** @type {Map<string, AnnotationRecord>} */
    this.records = new Map()
    /** @type {Map<string, any>} */
    this.images = new Map()
    this.seq = 0
    this.lines = 0
    this.ready = false
    this.queue = Promise.resolve()
  }

  get file() {
    return join(this.dir, LOG_NAME)
  }

  /** Load the log into memory; safe to call once per activation. */
  async load() {
    await mkdir(this.dir, { recursive: true })
    let text = ''
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      this.lines += 1
      let event
      try {
        event = JSON.parse(line)
      } catch {
        // A torn final line from a hard kill is expected; everything before it
        // is still authoritative.
        this.logger.warn('annotations: skipping an unparseable log line')
        continue
      }
      this.#apply(event)
      if (typeof event.seq === 'number' && event.seq > this.seq) this.seq = event.seq
    }
    this.ready = true
    this.logger.debug(`annotations: loaded ${this.records.size} records from ${this.lines} lines`)
    return this
  }

  /**
   * Serialize every mutation so append order matches seq order.
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  #serialize(work) {
    const next = this.queue.then(work, work)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** @param {any} event */
  #apply(event) {
    switch (event.op) {
      case 'put':
        this.records.set(event.id, event.data)
        break
      case 'patch': {
        const current = this.records.get(event.id)
        if (current !== undefined) this.records.set(event.id, { ...current, ...event.data })
        break
      }
      case 'del':
        this.records.delete(event.id)
        this.images.delete(event.id)
        break
      case 'img':
        this.images.set(event.id, event.ref)
        break
      default:
        break
    }
  }

  /**
   * Append one event and fold it into memory.
   * @param {Record<string, any>} event
   */
  async #write(event) {
    const full = { ...event, ts: new Date().toISOString(), seq: this.seq + 1 }
    await appendFile(this.file, `${JSON.stringify(full)}\n`, 'utf8')
    this.seq = full.seq
    this.lines += 1
    this.#apply(full)
    return full.seq
  }

  /**
   * Insert or replace a record.
   * @param {AnnotationRecord} record
   * @returns {Promise<number>} the assigned seq
   */
  put(record) {
    return this.#serialize(() => this.#write({ op: 'put', id: record.id, data: record }))
  }

  /**
   * Merge fields into an existing record.
   * @param {string} id
   * @param {Partial<AnnotationRecord>} fields
   * @returns {Promise<AnnotationRecord | undefined>}
   */
  async patch(id, fields) {
    if (!this.records.has(id)) return undefined
    await this.#serialize(() => this.#write({ op: 'patch', id, data: fields }))
    return this.records.get(id)
  }

  /**
   * Delete every record matching the predicate. Unlike `list()`, this scans
   * the whole in-memory map — no window — because bulk clear semantics
   * ("everything resolved before X") must reach records older than the list
   * limit. Each hit appends the same `del` event `delete(id)` would.
   * @param {(record: AnnotationRecord) => boolean} predicate
   * @returns {Promise<AnnotationRecord[]>} the removed records
   */
  async deleteWhere(predicate) {
    const doomed = [...this.records.values()].filter(predicate)
    if (doomed.length === 0) return doomed
    await this.#serialize(async () => {
      for (const record of doomed) {
        await this.#write({ op: 'del', id: record.id })
      }
    })
    return doomed
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    if (!this.records.has(id)) return false
    await this.#serialize(() => this.#write({ op: 'del', id }))
    return true
  }

  /**
   * Remember the attachment reference for one annotation's crop.
   * @param {string} id
   * @param {any} ref
   */
  setImage(id, ref) {
    return this.#serialize(() => this.#write({ op: 'img', id, ref }))
  }

  /** @param {string} id */
  get(id) {
    return this.records.get(id)
  }

  /** @param {string} id */
  image(id) {
    return this.images.get(id)
  }

  get size() {
    return this.records.size
  }

  /**
   * @param {{ status?: string, url?: string, kind?: string, limit?: number }} [filter]
   * @returns {AnnotationRecord[]}
   */
  list(filter = {}) {
    const status = filter.status ?? 'open'
    const url = filter.url
    const kind = filter.kind
    const limit = Math.max(1, Math.min(200, filter.limit ?? 20))
    /** @type {AnnotationRecord[]} */
    const out = []
    for (const record of this.records.values()) {
      if (status !== 'all' && record.state !== status) continue
      if (typeof url === 'string' && url !== '' && !matchesUrl(record.url, url)) continue
      if (typeof kind === 'string' && record.anchor?.kind !== kind) continue
      out.push(record)
    }
    out.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    return out.slice(0, limit)
  }

  /** @param {(record: AnnotationRecord) => boolean} predicate */
  count(predicate) {
    let total = 0
    for (const record of this.records.values()) if (predicate(record)) total += 1
    return total
  }

  /**
   * Rewrite the log when most of its lines are superseded, keeping only the
   * live projection. Atomic: a rename replaces the file in one step.
   */
  async maybeCompact(force = false) {
    if (this.lines < COMPACT_MIN_LINES) return false
    const live = this.records.size + this.images.size
    if (!force && this.lines <= live * 2) return false
    return this.#serialize(async () => {
      if (force && this.lines < COMPACT_MIN_LINES) return false
      const lines = []
      let seq = 0
      for (const [id, record] of this.records) {
        seq += 1
        lines.push(JSON.stringify({ op: 'put', ts: new Date().toISOString(), seq, id, data: record }))
        const ref = this.images.get(id)
        if (ref !== undefined) {
          seq += 1
          lines.push(JSON.stringify({ op: 'img', ts: new Date().toISOString(), seq, id, ref }))
        }
      }
      const temporary = `${this.file}.tmp`
      await writeFile(temporary, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
      await rename(temporary, this.file)
      this.lines = lines.length
      this.seq = seq
      this.logger.debug(`annotations: compacted to ${lines.length} lines`)
      return true
    })
  }

  /** Wait for queued writes to settle (tests and shutdown). */
  async flush() {
    await this.queue
  }
}

/**
 * Match a stored URL against a filter: exact, origin, pathname, or host
 * substring. Deliberately forgiving because the caller may hold a URL with a
 * different query string than the one recorded.
 * @param {string} stored
 * @param {string} filter
 */
export function matchesUrl(stored, filter) {
  if (stored === filter) return true
  try {
    const left = new URL(stored)
    const right = filter.includes('://') ? new URL(filter) : undefined
    if (right !== undefined) {
      if (left.origin !== right.origin) return false
      if (right.pathname === '/' || right.pathname === '') return true
      return left.pathname === right.pathname
    }
    return left.hostname.includes(filter) || left.pathname.includes(filter)
  } catch {
    return filter === '' ? true : stored.includes(filter)
  }
}
