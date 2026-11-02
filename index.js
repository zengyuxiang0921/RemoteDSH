/**
 * remote-bridge — bridge session records between DSH instances.
 *
 * Server mode exposes this Host's session list, live events and history pages
 * over a standalone HTTP + WebSocket listener. Client mode connects to remote
 * bridges and materializes their sessions as ordinary local Sessions under a
 * per-machine Workspace, so the built-in sidebar and conversation view render
 * them with no plugin UI.
 *
 * Fields are declared `.volatile()` so the Settings form projection exposes
 * them: the Plugins view edits a row's configuration through those fields.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { BridgeServer } from './lib/server.js'
import { BridgeClient } from './lib/client.js'
import { normalizeConfig } from './lib/protocol.js'
import { BridgeAdmin, mountAdminRoutes } from './lib/admin.js'
/**
 * Load the profile's schemastery.
 *
 * A linked plugin directory has no `node_modules` of its own, so the package is
 * resolved from the profile that installed it. A missing schema only costs the
 * configuration form, never the bridge itself.
 * @returns {object | undefined} schemastery factory, or undefined.
 */
function loadSchemastery() {
  const candidates = []
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '') candidates.push(join(profileDir, 'package.json'))
  candidates.push(import.meta.url)
  for (const base of candidates) {
    try {
      const local = createRequire(base)
      const loaded = local('@deepseek-ai/schemastery')
      const factory = loaded?.default ?? loaded
      if (typeof factory === 'function' || typeof factory?.object === 'function') return factory
    } catch {
      // try the next base
    }
  }
  return undefined
}

const z = loadSchemastery()

const MODES = ['both', 'server', 'client', 'off']

/** One remote machine entry. */
const remoteEntry = z?.object({
  id: z.string().default(''),
  label: z.string().default(''),
  url: z.string().default(''),
  token: z.string().role('secret').default(''),
  password: z.string().role('secret').default(''),
})

/** One per-client grant. */
const clientGrant = z?.object({
  name: z.string().default(''),
  token: z.string().role('secret').default(''),
  password: z.string().role('secret').default(''),
  allow: z
    ?.object({
      sessions: z.string().default('*'),
      cwdPrefixes: z.array(z.string()).default([]),
    })
    .default({}),
})

/**
 * Visibility scope shared by the server's own grant and each client grant.
 * @returns {object} schemastery object schema.
 */
const scopeSchema = () =>
  z.object({
    sessions: z.string().default('*'),
    cwdPrefixes: z.array(z.string()).default([]),
  })

export const Config = z?.object({
  mode: z.union(MODES).default('both').volatile(),
  server: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().default('0.0.0.0'),
      port: z.number().step(1).min(1).max(65535).default(4590),
      name: z.string().default(''),
      auth: z
        .object({
          token: z.string().role('secret').default(''),
          password: z.string().role('secret').default(''),
        })
        .default({}),
      allow: scopeSchema().default({}),
      clients: z.array(clientGrant).default([]),
    })
    .default({})
    .volatile(),
  client: z
    .object({
      enabled: z.boolean().default(true),
      remotes: z.array(remoteEntry).default([]),
    })
    .default({})
    .volatile(),
})

/**
 * Cordis plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - loader config.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = typeof ctx.logger === 'function' ? ctx.logger('remote-bridge') : ctx.logger
  const admin = new BridgeAdmin()
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (scope) => {
      if (!mountAdminRoutes(scope, admin)) {
        log?.info?.('远程桥接管理面板不可用（Connection Fetch 路由未就绪）')
      }
    })
  } else if (!mountAdminRoutes(ctx, admin)) {
    log?.info?.('远程桥接管理面板不可用（Connection Fetch 路由未就绪）')
  }

  if (config.mode === 'off') {
    log?.info?.('远程桥接已关闭（mode: off）')
    return
  }

  if (config.server.enabled) {
    ctx.effect(() => {
      const server = new BridgeServer(ctx, config.server, log)
      admin.server = server
      server.start().catch((error) => log?.warn?.(`远程桥接服务启动失败：${String(error?.message ?? error)}`))
      return () => server.stop()
    }, 'remote-bridge: server')
  }

  if (config.client.enabled) {
    const client = new BridgeClient(ctx, config.client, log)
    admin.client = client
    ctx.effect(() => {
      client.start()
      return () => client.stop()
    }, 'remote-bridge: client')
  }
}
