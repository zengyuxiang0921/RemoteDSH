/**
 * Session catalogue and durable-log reads shared by the server half and by a
 * client acting as a relay publisher.
 *
 * Both roles answer the same two questions — "which sessions exist" and "give me
 * the events of this one" — so the folding logic, the caches and the diagnostic
 * counters live here instead of being duplicated per role.
 */
const MAX_HISTORY = 20000

/**
 * First text block of a user message, collapsed and truncated for a list preview.
 * @param {unknown} content - prompt content blocks.
 * @returns {string | null} preview text.
 */
export function firstText(content) {
  if (typeof content === 'string') return content.slice(0, 80)
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
    if (parts.join(' ').length > 80) break
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return text === '' ? null : text.slice(0, 80)
}

/** One Host's session inventory. */
export class SessionInventory {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {object} log - Cordis logger.
   */
  constructor(ctx, log) {
    this.ctx = ctx
    this.log = log
    this.titleCache = new Map()
    this.previewCache = new Map()
    this.diag = { query: false, records: 0, mapped: 0, titleCache: 0, previewCache: 0 }
    this.lastError = null
  }

  /**
   * Build wire summaries from the query corpus plus the zero-I/O projection cache.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object[]>} wire session summaries.
   */
  async list(signal) {
    const query = this.ctx.get('sessionQuery')
    this.diag.query = query !== undefined
    if (query === undefined) {
      this.lastError = 'sessionQuery service unavailable'
      return []
    }
    const cache = this.ctx.get('sessionProjectionCache')
    const liveSessions = this.ctx.get('sessions')
    const agents = this.ctx.get('agents')
    const records = await query.listSessions(signal)
    const out = []
    for (const record of records) {
      signal?.throwIfAborted?.()
      const header = record.header
      let values
      if (cache !== undefined) {
        try {
          values = cache.cachedSnapshot(header, ['title', 'sessionListMetadata'])?.values
        } catch {
          values = undefined
        }
      }
      const meta = values?.sessionListMetadata
      const live = typeof liveSessions?.get === 'function' ? liveSessions.get(header.id) : undefined
      const running = typeof agents?.get === 'function' && agents.get(header.id)?.status === 'running'
      out.push({
        id: String(header.id),
        title: typeof values?.title === 'string' && values.title !== '' ? values.title : null,
        updatedAt: Math.max(Number(header.createdAt) || 0, Number(meta?.lastPromptAt) || 0),
        running,
        blank: typeof meta?.blank === 'boolean' ? meta.blank : live !== undefined ? live.seq === 0 : false,
        cwd: typeof header.cwd === 'string' ? header.cwd : null,
        parentId: header.parentSession ? String(header.parentSession) : null,
        origin: header.origin === 'subagent' ? 'subagent' : null,
        preview: null,
      })
    }
    await this.foldTitles(query, signal, out)
    await this.foldPreviews(signal, out)
    this.diag.titleCache = this.titleCache.size
    this.diag.previewCache = this.previewCache.size
    return out
  }

  /**
   * Read the opening events of an untitled session so the list can show its
   * first user message instead of a bare id.
   * @param {AbortSignal} [signal] - cancellation.
   * @param {object[]} list - wire summaries to enrich in place.
   */
  async foldPreviews(signal, list) {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return
    const now = Date.now()
    const targets = []
    for (const item of list) {
      if (item.title !== null) continue
      const cached = this.previewCache.get(item.id)
      if (cached !== undefined && now - cached.at < 600000) {
        item.preview = cached.text
        continue
      }
      targets.push(item)
    }
    if (targets.length === 0) return
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        if (signal?.aborted) return
        const item = targets[cursor]
        cursor += 1
        try {
          const handle = await persistence.open(item.id, 'read')
          let text = null
          try {
            const result = await handle.read(0, 40)
            const userEvent = result.events.find((event) => event.type === 'user/message')
            if (userEvent !== undefined) text = firstText(userEvent.data?.content)
          } finally {
            await handle.close().catch(() => {})
          }
          item.preview = text
          this.previewCache.set(item.id, { text, at: now })
        } catch {
          this.previewCache.set(item.id, { text: null, at: now })
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
  }

  /**
   * Fold titles for sessions the zero-I/O cache did not answer, remembering the
   * result for a while so a periodic refresh does not re-read every cold log.
   * @param {object} query - `ctx.sessionQuery` service.
   * @param {AbortSignal} [signal] - cancellation.
   * @param {object[]} list - wire summaries to enrich in place.
   */
  async foldTitles(query, signal, list) {
    if (typeof query?.readTitleSnapshots !== 'function') return
    const now = Date.now()
    const missing = []
    for (const item of list) {
      if (item.title !== null) continue
      const cached = this.titleCache.get(item.id)
      if (cached !== undefined && now - cached.at < 600000) {
        item.title = cached.title
        continue
      }
      missing.push(item)
    }
    if (missing.length === 0) return
    const byId = new Map(missing.map((item) => [item.id, item]))
    let results
    try {
      results = await query.readTitleSnapshots(missing.map((item) => item.id), signal)
    } catch {
      return
    }
    for (const result of results) {
      const item = byId.get(String(result.sessionId))
      if (item === undefined) continue
      if (result.status === 'fulfilled') {
        const snapshot = result.value?.title
        const title = typeof snapshot?.title === 'string' && snapshot.title !== '' ? snapshot.title : null
        item.title = title
        if (Number(snapshot?.updatedAt) > 0) item.updatedAt = Math.max(item.updatedAt, Number(snapshot.updatedAt))
        this.titleCache.set(item.id, { title, at: now })
      } else {
        this.titleCache.set(item.id, { title: null, at: now })
      }
    }
  }

  /**
   * Read at most `max` events of one session, starting at `after` or from the tail.
   * @param {string} sessionId - session identity.
   * @param {number} max - event budget.
   * @param {number} [after] - exclusive lower bound; omitted reads the tail.
   * @returns {Promise<object[]>} durable events.
   */
  async readEvents(sessionId, max, after) {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('sessionPersistence 不可用')
    const snapshot = await persistence.stat(sessionId)
    const handle = await persistence.open(sessionId, 'read')
    try {
      const total = typeof snapshot?.eventCount === 'number' ? snapshot.eventCount : undefined
      const from = after !== undefined ? after : total === undefined ? 0 : Math.max(0, total - max)
      const result = await handle.read(from)
      const events = result.events
      return events.length > max ? events.slice(0, max) : events
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /**
   * Clamp one requested page size against the configured default.
   * @param {unknown} requested - `max` field of a request.
   * @param {number} fallback - configured budget.
   * @returns {number} page size.
   */
  static pageSize(requested, fallback) {
    const value = Number(requested)
    const base = Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
    return Math.min(Math.max(base, 1), MAX_HISTORY)
  }
}
