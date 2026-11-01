/**
 * Materialize remote sessions into this Host as ordinary Sessions.
 *
 * The built-in Web UI already lists, groups and renders Sessions, so a mirrored
 * session needs no custom view. Two carriers are used:
 *
 * - `live`: the mirror is an in-memory Session entered into `ctx.sessions` and
 *   seeded with the remote log, while the plugin keeps the persistence writer
 *   for that id. The Session is therefore rendered and pushed live by the
 *   native `session/follow` stream, and its projections (title, metadata) are
 *   folded by the native registry — but a local resume cannot take the writer,
 *   so the mirror stays read-only.
 * - `cold`: when seeding a live Session is refused (fork/seed logs), the log is
 *   written straight through the persistence handle and the projection cache is
 *   checkpointed so the list still shows a title.
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PAGE_EVENTS = 2000
const MAX_EVENTS = 50000
const MAX_LISTED = 200
const MAX_LIVE = 40

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** Directory that groups one remote machine's mirrored sessions. */
function mirrorDirectory(remoteId) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const safe = remoteId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'remote'
  return join(home, 'remote-bridge', safe)
}

/** Deterministic local id for one remote session. */
function mirrorId(remoteId, sessionId) {
  const digest = createHash('sha256').update(`${remoteId}\u0000${sessionId}`).digest('hex').slice(0, 24)
  return `session-rb-${digest}`
}

/** Surface intent arguments for one remote event. */
function surfaceOptions(event) {
  if (!SURFACE_TYPES.has(event.type)) return []
  const opts = {}
  if (event.surfaceOp !== undefined) opts.surfaceOp = event.surfaceOp
  if (event.sourceEventSeqs !== undefined) opts.sourceEventSeqs = event.sourceEventSeqs
  return [opts]
}

/** One mirrored session. */
class Mirror {
  /**
   * @param {string} id - local session id.
   * @param {object} handle - persistence write handle (keeps the mirror read-only).
   * @param {object | null} session - live Session, or null for a cold mirror.
   */
  constructor(id, handle, session) {
    this.id = id
    this.handle = handle
    this.session = session
    this.lastSeq = -1
    this.closed = false
  }

  /** @returns {boolean} whether the native live path drives this mirror. */
  get live() {
    return this.session !== null
  }

  /**
   * Append a contiguous batch of remote events.
   * @param {object[]} events - remote events in seq order.
   */
  append(events) {
    if (this.closed) return
    for (const event of events) {
      const seq = Number(event?.seq)
      if (!Number.isFinite(seq) || seq <= this.lastSeq) continue
      if (seq !== this.lastSeq + 1) throw new Error(`非连续事件：期望 ${this.lastSeq + 1}，收到 ${seq}`)
      if (this.session !== null) this.session.append(event.type, event.data, ...surfaceOptions(event))
      this.lastSeq = seq
    }
  }

  /** Release the writer. */
  async close() {
    if (this.closed) return
    this.closed = true
    if (this.session === null) await this.handle.close().catch(() => {})
  }
}

/** Owns every mirrored session of one remote link. */
export class RemoteMirror {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {{ config: object, label: string }} link - remote link face.
   * @param {object} log - Cordis logger.
   */
  constructor(ctx, link, log) {
    this.ctx = ctx
    this.link = link
    this.log = log
    this.dir = mirrorDirectory(link.config.id)
    this.mirrors = new Map()
    this.workspace = null
    this.version = undefined
    this.syncing = null
  }

  /**
   * Read one Host service, waiting for its asynchronous initialization.
   *
   * Cordis services are unavailable until their `Service.init` settles, and the
   * client may receive its first session list before the Workspace registry is
   * ready, so a plain `ctx.get` would silently disable the mirror.
   * @param {string} name - Cordis service key.
   * @param {number} timeoutMs - longest wait.
   * @returns {Promise<object | undefined>} the service, or undefined on timeout.
   */
  async service(name, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let value
      try {
        value = this.ctx.get(name)
      } catch {
        value = undefined
      }
      if (value !== undefined) return value
      if (Date.now() >= deadline) {
        this.log?.warn?.(`远程桥接：服务 ${name} 在 ${timeoutMs}ms 内未就绪`)
        return undefined
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  /**
   * Create the Workspace that groups this machine and title it.
   * @param {string} label - machine label.
   * @returns {Promise<object | null>} workspace entity.
   */
  async ensureWorkspace(label) {
    if (this.workspace !== null) return this.workspace
    const registry = await this.service('workspaceRegistry')
    if (registry === undefined) return null
    await mkdir(this.dir, { recursive: true })
    const workspace = await registry.create(this.dir)
    const title = `${label}（在那台机器${this.link.serverName ? `：${this.link.serverName}` : ''}）`
    try {
      if (workspace.title !== title) await workspace.setTitle(title)
    } catch {
      // renaming is cosmetic
    }
    this.workspace = workspace
    return workspace
  }

  /** @returns {Promise<number>} current local Session format version. */
  async formatVersion() {
    if (this.version !== undefined) return this.version
    const persistence = await this.service('sessionPersistence')
    if (persistence === undefined) throw new Error('sessionPersistence 不可用')
    const snapshots = await persistence.list()
    if (snapshots.length > 0) {
      this.version = snapshots[0].header.version
      return this.version
    }
    const sessions = await this.service('sessions')
    if (sessions === undefined) throw new Error('sessions 不可用')
    const prepared = sessions.prepare(undefined, { meta: { cwd: this.dir } })
    const detach = sessions.enter(prepared)
    try {
      this.version = prepared.header.version
    } finally {
      detach()
    }
    if (this.version === undefined) throw new Error('无法确定本机会话格式版本')
    return this.version
  }

  /**
   * Read the complete remote log, paging until the remote stops returning rows.
   * @param {string} sessionId - remote session id.
   * @returns {Promise<object[]>} every event from seq 0.
   */
  async fetchAll(sessionId) {
    const all = []
    let after = 0
    while (all.length < MAX_EVENTS) {
      const page = await this.link.fetchHistory(sessionId, after, PAGE_EVENTS)
      if (page.length === 0) break
      all.push(...page)
      after = Number(page[page.length - 1].seq) + 1
      if (page.length < PAGE_EVENTS) break
    }
    return all
  }

  /**
   * Create one local mirror and fill it with the remote log.
   * @param {object} summary - remote session summary.
   * @returns {Promise<Mirror | null>} created mirror.
   */
  async createMirror(summary) {
    const persistence = await this.service('sessionPersistence')
    if (persistence === undefined) return null
    const id = mirrorId(this.link.config.id, summary.id)
    const existing = await persistence.stat(id)
    if (existing !== undefined) return this.adoptExisting(summary, id)
    let events
    try {
      events = await this.fetchAll(summary.id)
    } catch (error) {
      this.log?.warn?.(`读取远端会话 ${summary.id} 失败：${String(error?.message ?? error)}`)
      return null
    }
    if (events.length === 0) return null
    if (Number(events[0].seq) !== 0) {
      this.log?.warn?.(`跳过远端会话 ${summary.id}：其日志不是从 0 开始的连续序列`)
      return null
    }
    const version = await this.formatVersion()
    this.sessionsService = await this.service('sessions')
    this.cacheService = await this.service('sessionProjectionCache', 5000)
    const handle = await persistence.create({
      version,
      id,
      createdAt: Number(summary.updatedAt) || Date.now(),
      cwd: this.dir,
      isSeeded: false,
    })
    const liveCount = [...this.mirrors.values()].filter((record) => record.live).length
    const session = liveCount < MAX_LIVE ? this.seedLive(handle.header, events) : null
    const record = new Mirror(id, handle, session)
    this.mirrors.set(summary.id, record)
    try {
      if (session === null) {
        await handle.append(events)
        this.seedProjections(handle.header, events)
      }
      record.lastSeq = Number(events[events.length - 1].seq)
    } catch (error) {
      this.log?.warn?.(`镜像会话 ${summary.id} 失败：${String(error?.message ?? error)}`)
      this.mirrors.delete(summary.id)
      await record.close()
      return null
    }
    await this.attach(id)
    if (session === null) this.publish(id, summary)
    return record
  }

  /**
   * Reuse a mirror left by an earlier run of this process.
   * @param {object} summary - remote session summary.
   * @param {string} id - local session id.
   * @returns {Promise<Mirror | null>} adopted mirror.
   */
  async adoptExisting(summary, id) {
    const persistence = await this.service('sessionPersistence')
    if (persistence === undefined) return null
    let handle
    try {
      handle = await persistence.open(id, 'write')
    } catch {
      return null
    }
    let events = []
    try {
      const read = await handle.read(0)
      events = read.events
    } catch {
      events = []
    }
    const liveCount = [...this.mirrors.values()].filter((record) => record.live).length
    this.sessionsService = await this.service('sessions')
    this.cacheService = await this.service('sessionProjectionCache', 5000)
    const session = liveCount < MAX_LIVE ? this.seedLive(handle.header, events) : null
    const record = new Mirror(id, handle, session)
    record.lastSeq = events.length === 0 ? -1 : Number(events[events.length - 1].seq)
    this.mirrors.set(summary.id, record)
    if (session === null) this.seedProjections(handle.header, events)
    await this.attach(id)
    return record
  }

  /**
   * Enter a live in-memory Session seeded with the remote log.
   *
   * The header must match the persistence header exactly: `session/list`
   * refuses a live row whose header disagrees with the durable one, and one
   * refusal fails the whole list call.
   * @param {object} header - header returned by `sessionPersistence.create`.
   * @param {object[]} events - remote log from seq 0.
   * @returns {object | null} the live Session, or null when seeding is refused.
   */
  seedLive(header, events) {
    const sessions = this.sessionsService
    if (sessions === undefined || events.length === 0 || header === undefined) return null
    try {
      return sessions.create(header.id, {
        seed: events,
        meta: {
          cwd: header.cwd,
          createdAt: header.createdAt,
          isSeeded: header.isSeeded ?? false,
          ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
          ...(header.origin === undefined ? {} : { origin: header.origin }),
          ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
          ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
        },
      })
    } catch (error) {
      this.log?.debug?.(`会话 ${header.id} 无法以 live 方式镜像，改用持久化镜像：${String(error?.message ?? error)}`)
      return null
    }
  }

  /**
   * Checkpoint the projection cache for a cold mirror so the list shows a title.
   * @param {object} header - local session header.
   * @param {object[]} events - complete log.
   */
  seedProjections(header, events) {
    const cache = this.cacheService
    if (cache === undefined || typeof cache.coldSnapshot !== 'function' || header === undefined) return
    try {
      cache.coldSnapshot(header, 0, events)
    } catch (error) {
      this.log?.debug?.(`镜像会话投影写入失败：${String(error?.message ?? error)}`)
    }
  }

  /**
   * Announce a cold mirror so connected clients upsert it immediately.
   * @param {string} id - local session id.
   * @param {object} summary - remote summary.
   */
  publish(id, summary) {
    const title = typeof summary?.title === 'string' && summary.title !== '' ? summary.title : null
    try {
      this.ctx.emit('api-session/added', {
        sessionId: id,
        updatedAt: Number(summary?.updatedAt) || Date.now(),
        agentAvailable: false,
        running: false,
        blank: false,
        cwd: this.dir,
        ...(title === null ? {} : { projections: { kind: 'cached', asOfSeq: -1, values: { title } } }),
      })
    } catch {
      // announcement is best effort
    }
  }

  /**
   * Attach one local session to this machine's Workspace.
   * @param {string} id - local session id.
   */
  async attach(id) {
    if (this.workspace === null) return
    try {
      await this.workspace.attachSession(id)
    } catch (error) {
      this.log?.debug?.(`无法把镜像会话加入工作区：${String(error?.message ?? error)}`)
    }
  }

  /**
   * Reconcile the local mirrors with a remote session list.
   * @param {object[]} sessions - remote session summaries.
   */
  sync(sessions) {
    const run = (this.syncing ?? Promise.resolve()).then(async () => {
      const workspace = await this.ensureWorkspace(this.link.config.label)
      if (workspace === null) return
      const wanted = new Map()
      for (const summary of sessions.slice(0, MAX_LISTED)) {
        if (summary.origin === 'subagent') continue
        if (String(summary.id).startsWith('session-rb-')) continue
        wanted.set(String(summary.id), summary)
      }
      for (const [remoteSessionId, summary] of wanted) {
        if (!this.mirrors.has(remoteSessionId)) {
          await this.createMirror(summary)
          continue
        }
        await this.pull(remoteSessionId)
      }
      for (const [remoteSessionId, record] of [...this.mirrors]) {
        if (wanted.has(remoteSessionId)) continue
        this.mirrors.delete(remoteSessionId)
        await record.close()
      }
    })
    this.syncing = run.catch((error) => {
      this.log?.warn?.(`同步远端会话列表失败：${String(error?.message ?? error)}`)
    })
    return this.syncing
  }

  /**
   * Append events committed by the remote since the local tail.
   * @param {string} remoteSessionId - remote identity.
   */
  async pull(remoteSessionId) {
    const record = this.mirrors.get(remoteSessionId)
    if (record === undefined || record.closed) return
    if (this.link.status !== 'online') return
    const events = await this.link.fetchHistory(remoteSessionId, record.lastSeq + 1, PAGE_EVENTS)
    if (events.length === 0) return
    record.append(events)
  }

  /**
   * Apply one live remote event to its mirror.
   * @param {string} remoteSessionId - remote identity.
   * @param {object} event - remote event.
   */
  async onEvent(remoteSessionId, event) {
    const record = this.mirrors.get(remoteSessionId)
    if (record === undefined || record.closed) return
    try {
      record.append([event])
    } catch (error) {
      this.log?.debug?.(`追加远端事件失败（${remoteSessionId}）：${String(error?.message ?? error)}`)
      await this.pull(remoteSessionId).catch(() => {})
    }
  }

  /** Close every mirror and release the writers. */
  async dispose() {
    const records = [...this.mirrors.values()]
    this.mirrors.clear()
    await Promise.all(records.map((record) => record.close()))
  }
}
