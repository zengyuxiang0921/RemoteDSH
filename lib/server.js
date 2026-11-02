/**
 * Server mode: expose this Host's session records over HTTP + WebSocket.
 *
 * The protocol is read-only. A peer authenticates with a shared token and/or
 * password (or one entry of `server.clients`), then receives the session list,
 * live `session/event` frames and on-demand history pages.
 */
import http from 'node:http'
import { ServerSocket, isWebSocketUpgrade } from './ws.js'
import { PROTOCOL_VERSION, PLUGIN_VERSION, allowsSession, safeEqual } from './protocol.js'

const MAX_PEERS = 64
const HELLO_TIMEOUT_MS = 10000
const MAX_LISTED_SESSIONS = 500
const MAX_HISTORY = 20000
let nextPeerId = 0

/** One admitted bridge peer. */
class Peer {
  /**
   * @param {BridgeServer} server - owning server.
   * @param {ServerSocket} socket - accepted WebSocket.
   * @param {{ name: string, allow: object }} grant - admitted identity and scope.
   */
  constructor(server, socket, grant) {
    this.server = server
    this.socket = socket
    this.grant = grant
    this.welcomed = false
    this.dead = false
    this.id = `peer-${Date.now().toString(36)}-${++nextPeerId}`
    this.connectedAt = Date.now()
    this.lastActiveAt = this.connectedAt
    this.welcomedAt = null
    this.remoteAddress = 'unknown'
    this.remotePort = null
    this.clientName = null
    this.clientVersion = null
    this.protocol = null
    this.historyReads = 0
    this.lastHistoryAt = null
    this.hello = setTimeout(() => {
      if (!this.welcomed) this.fail('hello-timeout', '没有在限定时间内完成握手')
    }, HELLO_TIMEOUT_MS)
    this.hello.unref?.()
  }

  /** @param {object} summary - wire session summary. @returns {boolean} visibility. */
  canSee(summary) {
    return allowsSession(this.grant.allow, summary)
  }

  /** @param {unknown} value - JSON payload. */
  send(value) {
    if (this.dead || this.socket === null) return
    this.socket.send(value)
  }

  /**
   * Report a protocol failure and close.
   * @param {string} code - machine code.
   * @param {string} message - human text.
   */
  fail(code, message) {
    this.send({ t: 'error', code, message })
    this.close()
  }

  /** @param {object} payload - `welcome` payload without sessions. */
  welcome(payload) {
    this.welcomed = true
    this.welcomedAt = Date.now()
    this.lastActiveAt = this.welcomedAt
    clearTimeout(this.hello)
    this.send(payload)
  }

  close() {
    if (this.dead) return
    this.dead = true
    clearTimeout(this.hello)
    this.socket?.close()
  }
}

/**
 * First text block of a user message, collapsed and truncated for a list preview.
 * @param {unknown} content - prompt content blocks.
 * @returns {string | null} preview text.
 */
function firstText(content) {
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

/** The bridge HTTP + WebSocket server. */
export class BridgeServer {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {object} config - normalized `server` config.
   * @param {object} log - Cordis logger.
   */
  constructor(ctx, config, log) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.peers = new Set()
    this.sessions = new Map()
    this.lastListKey = ''
    this.lastError = null
    this.diag = { query: false, records: 0, mapped: 0, titleCache: 0, previewCache: 0 }
    this.titleCache = new Map()
    this.previewCache = new Map()
    this.refreshing = null
    this.offEvent = null
    this.listTimer = null
    this.http = null
    this.stopped = false
  }

  /** Start listening and streaming. Resolves after the port is bound or failed. */
  async start() {
    if (this.stopped) return
    const { host, port } = this.config
    this.http = http.createServer((req, res) => {
      this.handleHttp(req, res)
    })
    this.http.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head)
    })
    this.http.on('clientError', (_error, socket) => {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    })

    await new Promise((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve()
      }
      this.http.once('error', (error) => {
        this.log?.warn?.(`远程桥接服务无法监听 ${host}:${port}：${error?.message ?? error}`)
        this.http = null
        settle()
      })
      this.http.listen(port, host, () => {
        this.port = this.http?.address()?.port ?? port
        settle()
      })
    })

    if (this.http === null) return
    if (!this.config.auth.token && !this.config.auth.password && this.config.clients.length === 0) {
      this.log?.warn?.('远程桥接服务未配置任何 token / password，任何能访问该端口的人都能读取会话记录')
    }

    this.offEvent = this.ctx.on('session/event', (session, event) => {
      this.broadcastEvent(session, event)
    })
    this.listTimer = setInterval(() => {
      if (this.peers.size === 0) return
      this.refresh().catch(() => {})
    }, this.config.listIntervalMs)
    this.listTimer.unref?.()
    this.log?.info?.(`远程桥接服务已启动：${host}:${this.port}`)
  }

  /** A credential-free view for the authenticated management RPC. */
  snapshot() {
    return {
      enabled: true,
      listening: this.http !== null,
      host: this.config.host,
      port: this.port ?? this.config.port,
      name: this.config.name,
      authRequired: Boolean(this.config.auth.token || this.config.auth.password || this.config.clients.length),
      lastError: this.lastError,
      peers: [...this.peers].map((peer) => ({
        id: peer.id,
        state: peer.dead ? 'closed' : peer.welcomed ? 'online' : 'handshaking',
        name: peer.clientName ?? peer.grant.name,
        identity: peer.grant.name,
        version: peer.clientVersion,
        protocol: peer.protocol,
        address: peer.remoteAddress,
        port: peer.remotePort,
        connectedAt: peer.connectedAt,
        welcomedAt: peer.welcomedAt,
        lastActiveAt: peer.lastActiveAt,
        visibleSessions: peer.welcomed ? [...this.sessions.values()].filter((item) => peer.canSee(item)).length : 0,
        scope: { sessions: peer.grant.allow.sessions, cwdPrefixes: [...peer.grant.allow.cwdPrefixes] },
        historyReads: peer.historyReads,
        lastHistoryAt: peer.lastHistoryAt,
      })),
    }
  }

  /** Drop one connection; a normally configured client will reconnect later. */
  disconnect(peerId) {
    const peer = [...this.peers].find((item) => item.id === peerId)
    if (peer === undefined) return { ok: false, error: '连接已断开或不存在' }
    peer.fail('admin-disconnect', '已被服务端管理面板断开')
    return { ok: true, peerId }
  }

  /** Stop listening, drop peers and timers. */
  stop() {
    this.stopped = true
    for (const peer of this.peers) peer.close()
    this.peers.clear()
    if (this.listTimer) clearInterval(this.listTimer)
    this.listTimer = null
    try {
      this.offEvent?.()
    } catch {
      // ignore
    }
    this.offEvent = null
    try {
      this.http?.close()
    } catch {
      // ignore
    }
    this.http = null
  }

  /**
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   */
  handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://bridge.local')
    const send = (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (url.pathname === '/health') {
      send(200, { ok: true, name: this.config.name, version: PLUGIN_VERSION, protocol: PROTOCOL_VERSION })
      return
    }
    send(200, {
      ok: true,
      name: this.config.name,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      transport: 'websocket',
      endpoint: '/ws',
      sessions: this.sessions.size,
      lastError: this.lastError,
      diag: this.diag,
    })
  }

  /**
   * @param {import('node:http').IncomingMessage} req - upgrade request.
   * @param {import('node:stream').Duplex} socket - raw socket.
   * @param {Buffer} head - buffered bytes.
   */
  handleUpgrade(req, socket, head) {
    if (this.stopped || this.peers.size >= MAX_PEERS || !isWebSocketUpgrade(req)) {
      try {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      } catch {
        // ignore
      }
      return
    }
    const peer = new Peer(this, null, { name: 'pending', allow: { sessions: '*', cwdPrefixes: [] } })
    peer.remoteAddress = String(req.socket.remoteAddress ?? socket.remoteAddress ?? 'unknown')
    peer.remotePort = Number(req.socket.remotePort ?? socket.remotePort) || null
    this.peers.add(peer)
    const ws = ServerSocket.accept(req, socket, head, {
      maxPayload: 1024 * 1024,
      onMessage: (text) => this.handleMessage(peer, text),
      onClose: () => {
        clearTimeout(peer.hello)
        peer.dead = true
        this.peers.delete(peer)
      },
    })
    if (ws === null) {
      clearTimeout(peer.hello)
      this.peers.delete(peer)
      return
    }
    peer.socket = ws
    ws.prime()
  }

  /**
   * @param {Peer} peer - peer whose socket produced the frame.
   * @param {string} text - raw JSON text.
   */
  handleMessage(peer, text) {
    if (peer.dead) return
    peer.lastActiveAt = Date.now()
    let message
    try {
      message = JSON.parse(text)
    } catch {
      peer.fail('bad-frame', '无法解析的消息')
      return
    }
    if (message === null || typeof message !== 'object') {
      peer.fail('bad-frame', '消息必须是对象')
      return
    }
    if (!peer.welcomed) {
      this.handleHello(peer, message)
      return
    }
    switch (message.t) {
      case 'ping':
        peer.send({ t: 'pong', at: Date.now() })
        return
      case 'refresh':
        this.refresh().catch(() => {})
        return
      case 'history':
        this.handleHistory(peer, message)
        return
      default:
        peer.send({ t: 'error', code: 'unknown-message', message: `未知消息类型：${String(message.t)}` })
    }
  }

  /**
   * @param {Peer} peer - unauthenticated peer.
   * @param {object} message - `hello` frame.
   */
  handleHello(peer, message) {
    if (message.t !== 'hello') {
      peer.fail('expected-hello', '第一帧必须是 hello')
      return
    }
    if (Number(message.v) !== PROTOCOL_VERSION) {
      peer.fail('protocol-mismatch', `协议版本不匹配：需要 ${PROTOCOL_VERSION}`)
      return
    }
    const grant = this.authenticate(message)
    if (grant === null) {
      peer.fail('auth-failed', 'token 或 password 不正确')
      return
    }
    peer.grant = grant
    peer.protocol = Number(message.v)
    peer.clientName = typeof message.client?.name === 'string' ? message.client.name.slice(0, 120) : grant.name
    peer.clientVersion = typeof message.client?.version === 'string' ? message.client.version.slice(0, 40) : null
    this.log?.info?.(`远程 DSH 已连接：${peer.clientName}（${peer.remoteAddress}）`)
    this.refresh()
      .catch(() => {})
      .finally(() => {
        if (peer.dead) return
        const sessions = [...this.sessions.values()]
          .filter((summary) => peer.canSee(summary))
          .sort((left, right) => right.updatedAt - left.updatedAt)
        peer.welcome({
          t: 'welcome',
          v: PROTOCOL_VERSION,
          server: { name: this.config.name, version: PLUGIN_VERSION },
          you: { name: grant.name },
          sessions,
          diagnostics: this.lastError ?? null,
        })
      })
  }

  /**
   * Resolve the identity and scope of a `hello` frame.
   * @param {object} message - hello frame.
   * @returns {{ name: string, allow: object } | null} grant, or null when refused.
   */
  authenticate(message) {
    const auth = message.auth !== null && typeof message.auth === 'object' ? message.auth : {}
    const token = typeof auth.token === 'string' ? auth.token : ''
    const password = typeof auth.password === 'string' ? auth.password : ''
    const clients = this.config.clients
    if (clients.length > 0) {
      for (const client of clients) {
        if (client.token && !safeEqual(token, client.token)) continue
        if (client.password && !safeEqual(password, client.password)) continue
        if (!client.token && !client.password) continue
        return { name: client.name, allow: client.allow }
      }
      return null
    }
    const expected = this.config.auth
    if (expected.token && !safeEqual(token, expected.token)) return null
    if (expected.password && !safeEqual(password, expected.password)) return null
    const name = typeof message.client?.name === 'string' && message.client.name !== '' ? message.client.name.slice(0, 120) : 'client'
    return { name, allow: this.config.allow }
  }

  /**
   * Serve one history request from the durable log.
   * @param {Peer} peer - requesting peer.
   * @param {object} message - `history` frame.
   */
  handleHistory(peer, message) {
    peer.historyReads += 1
    peer.lastHistoryAt = Date.now()
    const rid = typeof message.rid === 'string' ? message.rid : ''
    const sessionId = String(message.session ?? '')
    const summary = this.sessions.get(sessionId)
    if (!summary || !peer.canSee(summary)) {
      peer.send({ t: 'error', rid, code: 'forbidden', message: '该会话不可见' })
      return
    }
    const max = Math.min(Number(message.max) > 0 ? Math.floor(Number(message.max)) : this.config.maxHistory, MAX_HISTORY)
    const after = Number.isFinite(Number(message.after)) ? Math.max(0, Math.floor(Number(message.after))) : undefined
    this.readEvents(sessionId, max, after)
      .then((events) => {
        peer.send({ t: 'history', rid, session: sessionId, events, hasMore: false, at: Date.now() })
      })
      .catch((error) => {
        peer.send({ t: 'error', rid, code: 'history-failed', message: String(error?.message ?? error) })
      })
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
   * Build wire summaries from the query corpus plus the zero-I/O projection cache.
   * @param {AbortSignal} signal - cancellation.
   * @returns {Promise<object[]>} wire session summaries.
   */
  async buildList(signal) {
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
   * @param {AbortSignal} signal - cancellation.
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
        if (signal.aborted) return
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
   * @param {AbortSignal} signal - cancellation.
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

  /** Re-read the Host session list and push it to peers when it changed. */
  async refresh() {
    if (this.stopped || this.peers.size === 0) return
    if (this.refreshing !== null) return this.refreshing
    const controller = new AbortController()
    this.refreshing = (async () => {
      try {
        const list = await this.buildList(controller.signal)
        this.diag.records = list.length
        const next = new Map()
        for (const wire of list.slice(0, MAX_LISTED_SESSIONS)) next.set(wire.id, wire)
        this.diag.mapped = next.size
        this.sessions = next
        this.lastError = null
        const key = JSON.stringify([...next.values()].map((item) => [item.id, item.updatedAt, item.title, item.running]))
        if (key === this.lastListKey) return
        this.lastListKey = key
        this.pushSessions()
      } catch (error) {
        this.lastError = String(error?.stack ?? error)
        this.log?.warn?.(`远程桥接会话列表读取失败：${String(error?.message ?? error)}`)
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  /** Push the current filtered list to every welcomed peer. */
  pushSessions() {
    const ordered = [...this.sessions.values()].sort((left, right) => right.updatedAt - left.updatedAt)
    for (const peer of this.peers) {
      if (!peer.welcomed || peer.dead) continue
      peer.send({ t: 'sessions', sessions: ordered.filter((summary) => peer.canSee(summary)), at: Date.now() })
    }
  }

  /**
   * Fan out one committed session event.
   * @param {{ id: string, header?: { cwd?: string } }} session - appended session.
   * @param {object} event - committed event.
   */
  broadcastEvent(session, event) {
    if (this.peers.size === 0) return
    const id = String(session.id)
    const summary = this.sessions.get(id) ?? { id, cwd: session.header?.cwd ?? null }
    let frame = null
    for (const peer of this.peers) {
      if (!peer.welcomed || peer.dead) continue
      if (!peer.canSee(summary)) continue
      frame ??= { t: 'event', session: id, event }
      peer.send(frame)
    }
  }
}
