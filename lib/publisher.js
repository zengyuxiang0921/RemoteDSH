/**
 * Publisher half of the client-to-client relay.
 *
 * A client that enables `client.share` offers a subset of its own sessions to
 * the server, which forwards them to other connected clients. This module owns
 * that offer: what is advertised, answering forwarded history requests, and
 * forwarding live events for the sessions it advertised.
 *
 * Everything it sends is already filtered by the local share scope, so the
 * server never sees a session this machine did not choose to share.
 */
import { SessionInventory } from './inventory.js'
import { shareAllowsSession, shareKey } from './protocol.js'

const MAX_ADVERTISED = 200

/** Advertises one Host's shared sessions to a bridge server. */
export class SessionPublisher {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {RemoteLink} link - link carrying the frames.
   * @param {{ enabled: boolean, sessions: string, cwdPrefixes: string[], consumers: string[] }} share - local share scope.
   * @param {object} log - Cordis logger.
   */
  constructor(ctx, link, share, log) {
    this.ctx = ctx
    this.link = link
    this.share = share
    this.log = log
    this.inventory = new SessionInventory(ctx, log)
    this.advertised = new Map()
    this.timer = null
    this.refreshing = null
    this.started = false
    this.lastKey = ''
    this.shareKey = shareKey(share)
    this.publishCount = 0
    this.lastPublishAt = null
  }

  /** Begin advertising; the first list goes out immediately. */
  start() {
    if (this.started) return
    this.started = true
    this.refresh({ reason: 'start' }).catch(() => {})
    this.timer = setInterval(() => {
      this.refresh().catch(() => {})
    }, 5000)
    this.timer.unref?.()
    this.log?.info?.(`已作为共享方上线，向服务器发布本机会话（${this.describeScope()}）`)
  }

  /**
   * Replace the share scope, re-announcing at once when it actually changed.
   *
   * A permission edit must not wait for the next periodic list: consumers that
   * just lost access have to be told, and consumers that just gained it should
   * see the catalogue immediately.
   * @param {object} next - new share scope.
   * @returns {Promise<void>} settles after the re-announcement.
   */
  async setShare(next) {
    const key = shareKey(next)
    this.share = next
    if (key === this.shareKey) return
    this.shareKey = key
    this.log?.info?.(`共享范围已变更，重新向服务器广播（${this.describeScope()}）`)
    await this.republish('share-changed')
  }

  /**
   * Re-announce the current catalogue, even when it looks unchanged.
   * @param {string} [reason] - why the announcement happens, for logs.
   */
  async republish(reason = 'manual') {
    if (!this.started) return
    this.lastKey = ''
    await this.refresh({ force: true, reason })
  }

  /** @returns {string} human scope description for logs. */
  describeScope() {
    const parts = [`会话 ${this.share.sessions}`]
    if (this.share.cwdPrefixes.length > 0) parts.push(`目录 ${this.share.cwdPrefixes.join(', ')}`)
    parts.push(this.share.consumers.length === 0 ? '对端 任意' : `对端 ${this.share.consumers.join(', ')}`)
    return parts.join(' · ')
  }

  /** Stop advertising and drop the timer. */
  stop() {
    this.started = false
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.advertised.clear()
  }

  /** @param {string} sessionId - local session id. @returns {boolean} whether it is shared. */
  shares(sessionId) {
    return this.advertised.has(sessionId)
  }

  /**
   * Recompute the advertised set and publish it when it changed.
   * @param {{ force?: boolean, reason?: string }} [options] - announce even when unchanged.
   */
  async refresh(options = {}) {
    if (!this.started || this.link.status !== 'online') return
    if (this.refreshing !== null) return this.refreshing
    const controller = new AbortController()
    this.refreshing = (async () => {
      try {
        // A disabled share advertises nothing at all, so the frame itself
        // carries the withdrawal instead of a catalogue the server must drop.
        const list = this.share.enabled === true ? await this.inventory.list(controller.signal) : []
        const next = new Map()
        for (const summary of list) {
          if (!shareAllowsSession(this.share, summary)) continue
          if (summary.blank === true) continue
          next.set(summary.id, summary)
          if (next.size >= MAX_ADVERTISED) break
        }
        this.advertised = next
        const key = JSON.stringify([...next.values()].map((item) => [item.id, item.updatedAt, item.title]))
        if (options.force !== true && key === this.lastKey) return
        this.lastKey = key
        this.publishCount += 1
        this.lastPublishAt = Date.now()
        this.link.send({
          t: 'publish',
          // `full` tells the server this frame is the whole truth for this peer,
          // so it may revoke access that a consumer had before.
          full: true,
          reason: options.reason ?? 'list-changed',
          share: {
            enabled: this.share.enabled === true,
            sessions: this.share.sessions,
            cwdPrefixes: this.share.cwdPrefixes,
            consumers: this.share.consumers,
          },
          sessions: [...next.values()].map((item) => ({
            id: item.id,
            title: item.title,
            updatedAt: item.updatedAt,
            running: item.running,
            blank: item.blank,
            cwd: item.cwd,
            parentId: item.parentId,
            origin: item.origin,
            preview: item.preview,
          })),
        })
      } catch (error) {
        this.log?.warn?.(`发布共享会话列表失败：${String(error?.message ?? error)}`)
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  /**
   * Answer one forwarded history request.
   * @param {string} rid - request id assigned by the server.
   * @param {string} sessionId - local session id.
   * @param {number | undefined} after - exclusive lower bound.
   * @param {number} max - page size.
   */
  answer(rid, sessionId, after, max) {
    if (!this.shares(sessionId)) {
      this.link.send({ t: 'history', rid, session: sessionId, events: [] })
      return
    }
    this.inventory
      .readEvents(sessionId, max, after)
      .then((events) => {
        this.link.send({ t: 'history', rid, session: sessionId, events })
      })
      .catch((error) => {
        this.log?.warn?.(`转发会话 ${sessionId} 的历史失败：${String(error?.message ?? error)}`)
        this.link.send({ t: 'history', rid, session: sessionId, events: [] })
      })
  }

  /**
   * Forward one committed event of a shared session.
   * @param {{ id: string }} session - appended session.
   * @param {object} event - committed event.
   */
  forwardEvent(session, event) {
    if (!this.started || this.link.status !== 'online') return
    const id = String(session?.id ?? '')
    if (id === '' || !this.shares(id)) return
    this.link.send({ t: 'publish/event', session: id, event })
  }
}
