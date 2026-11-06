/**
 * Preflight: would this package validate as an entry of a plugin market index?
 *
 * The official market (`@deepseek-ai/dsh-plugin-market`) validates every index
 * with `parseMarketIndex`, so running that same validator over an index built
 * from this package's manifest is the executable form of "can it be listed".
 *
 * Run: node test/market-index-check.mjs [--git <40-hex commit>]
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Resolve the shipped validator from the DSH installation or this profile. */
function loadIndex() {
  const candidates = []
  if (process.env.DSH_PROFILE_DIR) candidates.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  candidates.push(join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/package.json'))
  candidates.push(import.meta.url)
  for (const base of candidates) {
    for (const name of ['@deepseek-ai/dsh-plugin-market-index']) {
      try {
        return createRequire(base)(name)
      } catch {
        // try the next base
      }
    }
  }
  return undefined
}

const market = loadIndex()
if (market === undefined) {
  console.log('SKIP: @deepseek-ai/dsh-plugin-market-index is not resolvable here')
  process.exit(0)
}

const commitArgument = process.argv.indexOf('--git')
const commit = commitArgument > 0 ? process.argv[commitArgument + 1] : '0'.repeat(40)

const repositoryUrl = typeof manifest.repository === 'string'
  ? manifest.repository.replace(/^git\+/, '').replace(/\.git$/, '')
  : undefined
// A Git entry needs a repository URL; this placeholder only lets the structural
// check run when the manifest does not declare one yet (reported as a GAP below).
const gitUrlForProbe = repositoryUrl ?? 'https://example.invalid/owner/dsh-remote-bridge'

/**
 * Build one index entry from the manifest.
 * @param {{ type: 'npm' } | { type: 'git' }} source - install source to model.
 * @returns {object} format-1 index document.
 */
function buildIndex(source) {
  const version = {
    version: manifest.version,
    publishTimestamp: Math.floor(Date.now() / 1000),
    engines: { dsh: manifest.engines?.dsh ?? '>=0.2.0' },
    ...(source.type === 'npm'
      ? { source: { type: 'npm' } }
      : { source: { type: 'git', url: gitUrlForProbe, commit } }),
  }
  return {
    format: 1,
    title: { en: 'Remote Bridge', 'zh-cn': '远程桥接' },
    description: {
      en: manifest.description,
      'zh-cn': '在 DSH 之间桥接会话记录，支持客户端经服务器互相转发。',
    },
    metadata: {
      categories: { integration: { title: { en: 'Integration', 'zh-cn': '集成' } } },
    },
    plugins: [
      {
        name: manifest.name,
        title: { en: 'Remote Bridge', 'zh-cn': '远程桥接' },
        description: { en: manifest.description },
        author: 'yuxia',
        homepage: 'https://github.com/deepseek-ai/deepseek-harness',
        ...(repositoryUrl === undefined ? {} : { repository: { url: repositoryUrl } }),
        metadata: { category: 'integration', keywords: manifest.keywords ?? [] },
        versions: [version],
      },
    ],
  }
}

let failures = 0
for (const kind of ['npm', 'git']) {
  const index = buildIndex({ type: kind })
  try {
    const parsed = market.parseMarketIndex(index, 'https://example.invalid/plugins.json')
    const plugin = parsed.plugins[0]
    const defaultVersion = plugin.versions[0]
    const target = market.marketInstallTarget(plugin.name, defaultVersion)
    console.log(`OK   ${kind.padEnd(3)} :: ${plugin.name}@${defaultVersion.version} -> ${target.spec}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${kind.padEnd(3)} :: ${error?.path ?? '?'} ${error?.reason ?? error?.message ?? error}`)
  }
}

console.log('---')
console.log('manifest checks:')
const checks = [
  ['private must be false to publish to npm', manifest.private !== true],
  ['repository declared', manifest.repository !== undefined],
  ['homepage declared', manifest.homepage !== undefined],
  ['keywords declared', Array.isArray(manifest.keywords) && manifest.keywords.length > 0],
  ['engines.dsh declared', typeof manifest.engines?.dsh === 'string'],
  ['bundle patch declared', typeof manifest.dsh?.bundle?.patch === 'string'],
  ['client half declared', manifest.dsh?.client?.platform === 'web'],
  ['license declared', typeof manifest.license === 'string'],
]
for (const [label, ok] of checks) console.log(`${ok ? 'OK  ' : 'GAP '} ${label}`)

process.exit(failures === 0 ? 0 : 1)
