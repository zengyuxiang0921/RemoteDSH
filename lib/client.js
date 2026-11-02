/**
 * Client mode: connect to remote DSH bridge servers and mirror their session
 * records into this Host as ordinary local Sessions.
 *
 * The transport is one WebSocket per remote (HTTP upgrade), so the mirror sees
 * the list snapshot and every committed event as it happens.
 */
import { hostname } from 'node:os'
import { PLUGIN_VERSION, PROTOCOL_VERSION, normalizeWsUrl } from './protocol.js'
import { RemoteMirror } from './mirror.js'

const WELCOME_TIMEOUT_MS = 12000
const HEARTBEAT_MS = 20000
const REQUEST_TIMEOUT_MS = 20000

/** One remote DSH connection. */
export class RemoteLink {
  /**
   * @param {BridgeClient} owner - owning hub.
   * @param {object} config - normalized remote entry.
   * @param {object} log - Cordis logger.
   */
  constructor(owner, config, log) {
    this.owner = owner
    this.config = config
    this.log = log
    this.status = 'idle'
    this.error = null
    this.serverName = null
    this.connectedAt = null
    this.lastActiveAt = null
    this.sessions = []
    this.ws = null
    this.stopped = false
    this.attempt = 0
    this.retryTimer = null
    this.heartbeat = null
    this.welcomeTimer = null
    this.rid = 0
    this.pending = new Map()
    this.url = null
    try {
      this.url = normalizeWsUrl(config.url)
    } catch (error) {
      this.status = 'error'
      this.error = String(error?.message ?? error)
    }
  }

  /** Open the link, retrying with exponential backoff. */
  connect() {
    if (this.stopped || this.url === null) return
    this.clearRetry()
    this.status = 'connecting'
    let socket
    try {
      socket = new WebSocket(this.url)
    } catch (error) {
      this.error = String(error?.message ?? error)
      this.log?.warn?.(`远程桥接：无法建立 WebSocket（${this.config.label}）：${this.error}`)
      this.scheduleReconnect()
      return
    }
    this.ws = socket
    socket.addEventListener('open', () => {
      try {
        socket.send(
          JSON.stringify({
            t: 'hello',
            v: PROTOCOL_VERSION,
            client: { name: hostname(), version: PLUGIN_VERSION },
            auth: { token: this.config.token, password: this.config.password },
          }),
        )
      } catch {
        // the close handler owns recovery
      }
      this.welcomeTimer = setTimeout(() => {
        if (this.status !== 'online') {
          this.error = '服务端握手超时'
          try {
            socket.close()
          } catch {
            // ignore
          }
        }
      }, WELCOME_TIMEOUT_MS)
      this.welcomeTimer.unref?.()
      this.heartbeat = setInterval(() => {
        try {
          socket.send(JSON.stringify({ t: 'ping' }))
        } catch {
          // ignore
        }
      }, HEARTBEAT_MS)
      this.heartbeat.unref?.()
    })
    socket.addEventListener('message', (event) => this.handleMessage(event.data))
    socket.addEventListener('close', () => {
      this.cleanupSocket()
      this.scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      this.log?.warn?.(`远程桥接：连接 ${this.config.label} 出错（${this.url}）`)
    })
  }

  /** Stop for good. */
  dispose() {
    this.stopped = true
    this.clearRetry()
    this.cleanupSocket()
    this.rejectPending('remote link disposed')
  }

  clearRetry() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  cleanupSocket() {
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer)
    this.heartbeat = null
    this.welcomeTimer = null
    this.ws = null
  }

  /** Schedule the next connection attempt. */
  scheduleReconnect() {
    if (this.stopped || this.status === 'denied') return
    this.status = 'offline'
    this.attempt = Math.min(this.attempt + 1, 34)
    const delay = Math.min(1000 * 2 ** Math.min(this.attempt - 1, 5), this.owner.config.reconnectMaxMs)
    this.clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
    this.retryTimer.unref?.()
  }

  /**
   * @param {string | ArrayBuffer} raw - WebSocket payload.
   */
  handleMessage(raw) {
    if (typeof raw !== 'string') return
    this.lastActiveAt = Date.now()
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    switch (message.t) {
      case 'welcome':
        this.serverName = typeof message.server?.name === 'string' ? message.server.name : this.config.label
        this.error = null
        this.attempt = 0
        this.clearRetry()
        if (this.welcomeTimer !== null) clearTimeout(this.welcomeTimer)
        this.welcomeTimer = null
        this.status = 'online'
        this.connectedAt = Date.now()
        this.sessions = Array.isArray(message.sessions) ? message.sessions : []
        this.log?.info?.(`已连接远程 DSH「${this.config.label}」（${this.serverName}），会话 ${this.sessions.length} 个`)
        this.owner.onSessions(this, this.sessions)
        return
      case 'sessions':
        this.sessions = Array.isArray(message.sessions) ? message.sessions : []
        this.owner.onSessions(this, this.sessions)
        return
      case 'event':
        this.owner.onEvent(this, String(message.session ?? ''), message.event)
        return
      case 'history': {
        const pending = this.pending.get(String(message.rid ?? ''))
        if (pending === undefined) return
        this.pending.delete(String(message.rid ?? ''))
        pending.resolve(Array.isArray(message.events) ? message.events : [])
        return
      }
      case 'error': {
        const rid = String(message.rid ?? '')
        if (rid !== '') {
          const pending = this.pending.get(rid)
          if (pending !== undefined) {
            this.pending.delete(rid)
            pending.reject(new Error(String(message.message ?? message.code ?? 'remote error')))
          }
          return
        }
        if (message.code === 'auth-failed') {
          this.error = String(message.message ?? '鉴权失败')
          this.status = 'denied'
          this.rejectPending(this.error)
          try {
            this.ws?.close()
          } catch {
            // ignore
          }
          return
        }
        this.error = String(message.message ?? message.code ?? 'remote error')
        this.log?.warn?.(`远程桥接（${this.config.label}）错误：${this.error}`)
        return
      }
      case 'pong':
        return
      default:
        return
    }
  }

  /**
   * Read one history slice from the remote log.
   * @param {string} sessionId - remote session id.
   * @param {number} after - exclusive lower bound; `0` reads from the beginning.
   * @param {number} max - event budget.
   * @returns {Promise<object[]>} events in seq order.
   */
  async fetchHistory(sessionId, after, max) {
    if (this.ws === null || this.status !== 'online') {
      throw new Error(`远程连接不可用（${this.status}）`)
    }
    const rid = `h${++this.rid}`
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        reject(new Error('远程历史读取超时'))
      }, REQUEST_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(rid, {
        resolve: (events) => {
          clearTimeout(timer)
          resolve(events)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.ws.send(JSON.stringify({ t: 'history', rid, session: sessionId, after, max }))
      } catch (error) {
        this.pending.delete(rid)
        clearTimeout(timer)
        reject(error)
      }
    })
    return promise
  }

  /**
   * @param {string} reason - rejection text for in-flight requests.
   */
  rejectPending(reason) {
    for (const [rid, pending] of this.pending) {
      pending.reject(new Error(reason))
      this.pending.delete(rid)
    }
  }
}

/** The client-side hub: one link and one mirror per configured remote. */
export class BridgeClient {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {object} config - normalized `client` config.
   * @param {object} log - Cordis logger.
   */
  constructor(ctx, config, log) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.links = config.remotes.map((remote) => new RemoteLink(this, remote, log))
    this.mirrors = new Map(this.links.map((link) => [link.config.id, new RemoteMirror(ctx, link, log)]))
    this.started = false
  }

  /** Live outbound-link metadata for the management panel. */
  snapshot() {
    return {
      enabled: true,
      links: this.links.map((link) => ({
        id: link.config.id,
        label: link.config.label,
        url: link.url ?? link.config.url,
        status: link.status,
        error: link.error,
        serverName: link.serverName,
        connectedAt: link.connectedAt,
        lastActiveAt: link.lastActiveAt,
        sessions: link.sessions.length,
        attempt: link.attempt,
      })),
    }
  }

  /** Connect every configured remote. */
  start() {
    if (this.started) return
    this.started = true
    for (const link of this.links) link.connect()
  }

  /** Disconnect and release every mirror writer. */
  stop() {
    this.started = false
    for (const link of this.links) link.dispose()
    for (const mirror of this.mirrors.values()) {
      mirror.dispose().catch(() => {})
    }
  }

  /**
   * @param {RemoteLink} link - link that published its session list.
   * @param {object[]} sessions - remote session summaries.
   */
  onSessions(link, sessions) {
    const mirror = this.mirrors.get(link.config.id)
    if (mirror === undefined) return
    mirror.sync(sessions).catch((error) => {
      this.log?.warn?.(`同步远程「${link.config.label}」会话失败：${String(error?.message ?? error)}`)
    })
  }

  /**
   * @param {RemoteLink} link - link that received the event.
   * @param {string} sessionId - remote session id.
   * @param {object} event - committed remote event.
   */
  onEvent(link, sessionId, event) {
    const mirror = this.mirrors.get(link.config.id)
    if (mirror === undefined || sessionId === '' || event === null || typeof event !== 'object') return
    mirror.onEvent(sessionId, event).catch(() => {})
  }
}
