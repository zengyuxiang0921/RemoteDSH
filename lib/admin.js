/**
 * Live bridge inventory served to the management panel.
 *
 * The data crosses an exact, owner-only Fetch route on the Host Connection
 * carrier, so it rides the same cookie authentication as the Web UI: a peer that
 * is not the browser owner receives 403 before the handler runs. Only connection
 * metadata crosses this surface; tokens, passwords and event bodies never do.
 */
import { hostname, platform, release, arch } from 'node:os'
import { PLUGIN_VERSION, PROTOCOL_VERSION } from './protocol.js'

export const ADMIN_ROUTES = {
  status: '/api/remoteBridge/status',
  disconnect: '/api/remoteBridge/disconnect',
  republish: '/api/remoteBridge/republish',
  pull: '/api/remoteBridge/pull',
}

/** Ownership hub for the running server and client halves. */
export class BridgeAdmin {
  constructor() {
    this.server = null
    this.client = null
  }

  /** One consistent snapshot for the management panel. */
  snapshot() {
    return {
      at: Date.now(),
      machine: { hostname: hostname(), platform: platform(), release: release(), arch: arch() },
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      server: this.server?.snapshot() ?? { enabled: false, listening: false, peers: [] },
      client: this.client?.snapshot() ?? { enabled: false, links: [] },
    }
  }

  /**
   * Drop one admitted peer.
   * @param {unknown} peerId - id from a previous snapshot.
   * @returns {{ ok: boolean, error?: string }} outcome.
   */
  disconnect(peerId) {
    if (typeof peerId !== 'string' || peerId === '') return { ok: false, error: '连接 id 不能为空' }
    return this.server?.disconnect(peerId) ?? { ok: false, error: '服务端未启用' }
  }

  /**
   * Re-announce this machine's share catalogue to every connected server.
   * @param {unknown} [share] - optional share scope to adopt first.
   * @returns {Promise<{ ok: boolean, links?: number, error?: string }>} outcome.
   */
  async republish(share) {
    if (this.client === null) return { ok: false, error: '客户端未启用' }
    const links = await this.client.republish(share)
    return links === 0 ? { ok: false, error: '没有在线且正在共享的连接' } : { ok: true, links }
  }

  /**
   * Ask every connected server for its current relay catalogue.
   * @returns {{ ok: boolean, links?: number, error?: string }} outcome.
   */
  pull() {
    if (this.client === null) return { ok: false, error: '客户端未启用' }
    const links = this.client.pullRelays()
    return links === 0 ? { ok: false, error: '没有在线且已开启转发读取的连接' } : { ok: true, links }
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Publish the management routes on the Connection carrier.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {BridgeAdmin} admin - inventory owner.
 * @returns {boolean} whether the routes were claimed.
 */
export function mountAdminRoutes(ctx, admin) {
  const connection = ctx.get('connection')
  const registry = connection?.fetch
  if (registry === undefined || typeof registry.register !== 'function') return false
  registry.register({
    path: ADMIN_ROUTES.status,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(admin.snapshot()),
  })
  registry.register({
    path: ADMIN_ROUTES.disconnect,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body = null
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, error: '请求体不是 JSON' }, 400)
      }
      const result = admin.disconnect(body?.peerId)
      return json(result, result.ok ? 200 : 409)
    },
  })
  registry.register({
    path: ADMIN_ROUTES.republish,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body = null
      try {
        const text = await request.text()
        body = text === '' ? null : JSON.parse(text)
      } catch {
        return json({ ok: false, error: '请求体不是 JSON' }, 400)
      }
      const result = await admin.republish(body?.share)
      return json(result, result.ok ? 200 : 409)
    },
  })
  registry.register({
    path: ADMIN_ROUTES.pull,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      const result = admin.pull()
      return json(result, result.ok ? 200 : 409)
    },
  })
  return true
}
