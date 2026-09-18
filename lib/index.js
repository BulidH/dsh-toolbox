/**
 * 工具箱 · 宿主半区
 *
 * 职责边界很小：把「工具箱里有哪些 Tab」这件事持久化到磁盘，并提供给客户端读取。
 * 页面本身由客户端半区内嵌（iframe），宿主不代理、不转发，因此这里没有任何
 * 出站请求逻辑，只有一个受限的连通性探测接口，用来在 Tab 打不开时给出明确原因
 * 而不是一片空白。
 *
 * 配置落盘位置：$DSH_HOME/toolbox/config.json
 * 与 Harness 其它用户数据同级，因此覆盖安装应用不会影响它。
 *
 * @module dsh-toolbox
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 客户端通过该前缀读写配置。 */
const API_PREFIX = '/toolbox'

/** 单次请求体上限，配置是小型 JSON，超过这个量说明调用方有问题。 */
const BODY_LIMIT_BYTES = 64 * 1024

/** 连通性探测超时。本机服务应当在毫秒级响应，超时即视为不可用。 */
const PROBE_TIMEOUT_MS = 2500

/**
 * 内置的默认 Tab。首次启动、配置尚未生成时使用；用户改过配置后不再回退到这里。
 * 这些只是初始值，随时可以在设置里改掉或删掉。
 */
const DEFAULT_TABS = [
  {
    id: 'workbuddy2api',
    label: 'WorkBuddy2API',
    icon: '🐱',
    url: 'http://127.0.0.1:7863/panel/#overview',
    enabled: true
  }
]

export const inject = ['webServer']

/** 解析 Harness home：显式环境变量优先，否则回落到 ~/.dsh（与官方 dsh-home-paths 一致）。 */
function resolveDshHome(env = process.env) {
  const raw = env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = raw.trim()
    if (value === '~') return homedir()
    if (value.startsWith('~/')) return join(homedir(), value.slice(2))
    return value
  }
  return join(homedir(), '.dsh')
}

function configPath(dshHome) {
  return join(dshHome, 'toolbox', 'config.json')
}

/** 只接受 http/https，且必须是可解析的绝对 URL。 */
function normalizeUrl(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return parsed.toString()
}

function normalizeId(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 64) return undefined
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined
}

/**
 * 把任意输入收敛成一份合法配置。无法修复的条目直接丢弃，而不是让整份配置失效 ——
 * 一个手写坏的 Tab 不应该让工具箱整体打不开。
 * @returns 规范化后的配置，以及被丢弃条目的原因，便于前端提示。
 */
function normalizeConfig(value) {
  const dropped = []
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const rawTabs = Array.isArray(source.tabs) ? source.tabs : DEFAULT_TABS
  const seen = new Set()
  const tabs = []

  for (const entry of rawTabs) {
    if (entry === null || typeof entry !== 'object') {
      dropped.push('条目不是对象')
      continue
    }
    const id = normalizeId(entry.id)
    const url = normalizeUrl(entry.url)
    if (id === undefined) {
      dropped.push(`缺少合法 id：${JSON.stringify(entry.id ?? null)}`)
      continue
    }
    if (url === undefined) {
      dropped.push(`${id} 的 url 不是合法的 http/https 地址`)
      continue
    }
    if (seen.has(id)) {
      dropped.push(`id 重复：${id}`)
      continue
    }
    seen.add(id)
    const label = typeof entry.label === 'string' && entry.label.trim() !== ''
      ? entry.label.trim().slice(0, 48)
      : id
    const icon = typeof entry.icon === 'string' ? entry.icon.trim().slice(0, 8) : ''
    tabs.push({ id, label, icon, url, enabled: entry.enabled !== false })
  }

  return { config: { tabs }, dropped }
}

async function readConfig(file) {
  try {
    return normalizeConfig(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    // 文件不存在或内容损坏：回到默认值。不覆盖磁盘，交给用户决定是否保存。
    return normalizeConfig({ tabs: DEFAULT_TABS })
  }
}

/** 原子写：先写临时文件再 rename，避免中途退出留下半份 JSON。 */
async function writeConfig(file, value) {
  await mkdir(join(file, '..'), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * 请求围栏：socket 必须来自回环，Host 头必须指向回环，且不允许跨站发起。
 *
 * 这些接口能改本机配置，且 Harness 可能通过隧道暴露到外网（本机就有一个
 * cloudflared 隧道），因此只靠端口绑定不足以防住经由隧道的访问 —— 隧道把
 * 远端请求转成回环连接，但 Host 头与 sec-fetch-site 会暴露真实来源。
 */
function isTrustedRequest(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 探测某个 URL 是否可达。只允许回环目标：这个接口的用途是诊断用户自己的本机
 * 工具，不应该变成一个可被用来扫描内网/外网的探针。
 */
async function probe(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: '地址无法解析' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '只支持 http/https' }
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    return { ok: false, reason: '只探测本机地址（127.0.0.1 / localhost）' }
  }
  try {
    const response = await fetch(parsed, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    return { ok: response.status < 500, status: response.status }
  } catch (error) {
    return { ok: false, reason: describeFetchFailure(error) }
  }
}

/**
 * 把 fetch 的失败翻译成用户能据此行动的原因。
 * Node 的 fetch 在连接层失败时只给一句 `fetch failed`，真正的原因埋在 cause 里，
 * 直接透出会让面板显示「fetch failed」这种无法排查的信息。
 */
function describeFetchFailure(error) {
  const code = error?.cause?.code ?? error?.code
  if (code === 'ECONNREFUSED') return '连接被拒绝：该端口没有服务在监听'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名无法解析'
  if (code === 'ECONNRESET') return '连接被重置'
  if (code === 'ECONNABORTED') return '连接被中止'
  if (error?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时'
  // cause 的 message 比顶层那句 `fetch failed` 具体得多（例如 `bad port`）。
  const detail = error?.cause?.message
  if (typeof detail === 'string' && detail !== '') return detail
  return error instanceof Error ? error.message : String(error)
}

/**
 * 注册工具箱的宿主路由。
 * @param ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx) {
  const file = configPath(resolveDshHome())

  const routes = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        if (req.method === 'GET') {
          const { config, dropped } = await readConfig(file)
          sendJson(res, 200, { ok: true, config, dropped, path: file })
          return
        }
        if (req.method !== 'PUT' && req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        let raw
        try {
          raw = await readBody(req)
        } catch {
          sendJson(res, 413, { ok: false, error: 'body-too-large' })
          return
        }
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid-json' })
          return
        }
        const { config, dropped } = normalizeConfig(parsed)
        await writeConfig(file, config)
        sendJson(res, 200, { ok: true, config, dropped, path: file })
      }
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/probe`,
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const target = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('url')
        if (target === null) {
          sendJson(res, 400, { ok: false, error: 'missing-url' })
          return
        }
        sendJson(res, 200, { ok: true, result: await probe(target) })
      }
    }
  ]

  ctx.effect(
    () => {
      const disposers = routes.map(route => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-toolbox: routes'
  )
}
