import * as http from 'http'
import * as https from 'https'
import * as crypto from 'crypto'

export interface StreamProxyTarget {
  /** 上游真实地址（含 scheme/host/path/query），由调用方解析，代理本身不持有服务器状态 */
  url: string
  /** 注入到上游请求的凭据 token（X-Emby-Token） */
  token: string
}

/**
 * 解析 serverId → 上游目标；返回 null 表示该服务器不可用（未登录/已删除）。
 * 由 ServerManager 提供，代理本身不接触服务器状态与凭据来源。
 */
export type StreamTargetResolver = (serverId: string) => StreamProxyTarget | null

export interface StreamProxyLogger {
  info(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export interface StreamProxyOptions {
  /** opaque session 有效期（毫秒），默认 6 小时；<=0 表示不失效 */
  sessionTtlMs?: number
  /** session 最大数量；超限时先清扫过期，再逐出最旧 session，防止长期托盘运行无限累积 */
  maxSessions?: number
  /** 上游连接/传输不活动超时（毫秒），默认 60 秒；<=0 表示不设超时 */
  upstreamTimeoutMs?: number
  /** 过期 session 定时清扫间隔（毫秒），默认 5 分钟 */
  sweepIntervalMs?: number
  logger?: StreamProxyLogger
}

interface StreamSession {
  serverId: string
  path: string
  createdAt: number
}

const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_MAX_SESSIONS = 500
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * 播放流代理：对渲染端只暴露「不透明 session URL」，真实服务器地址与凭据全部留在主进程。
 * 会话只能由主进程创建，URL 中不含 serverId / token，渲染端无法自造指向任意服务器的地址。
 * mpv（独立/画布）与 html5 各引擎都只是普通 http 客户端，因此统一走本代理。
 */
export class StreamProxyService {
  private server: http.Server | null = null
  private port = 0
  /** 启动 Promise（幂等）：await 后端口一定已就绪，避免 createSession 拿到 port=0 */
  private startPromise: Promise<void> | null = null
  private readonly sessions = new Map<string, StreamSession>()
  private readonly sessionTtlMs: number
  private readonly maxSessions: number
  private readonly upstreamTimeoutMs: number
  private readonly sweepIntervalMs: number
  private sweepTimer: NodeJS.Timeout | null = null
  private readonly log: StreamProxyLogger

  constructor(
    private readonly resolveTarget: StreamTargetResolver,
    options: StreamProxyOptions = {}
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    this.log = options.logger ?? console
  }

  /**
   * 启动回环代理（幂等、可 await）。Promise resolve 时端口一定已就绪，
   * 调用方（主进程启动 / createSession 前）await 后可安全签发 session。
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res))
      this.server = server
      server.on('error', (err) => {
        this.log.error('[stream-proxy] server error:', err)
        this.startPromise = null
        this.server = null
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          this.log.info(`[stream-proxy] listening on 127.0.0.1:${this.port}`)
        }
        resolve()
      })
    })
    // 定时主动清扫过期 session：TTL 原本只在 session 被访问时才判断，
    // 长期挂托盘的播放器会把失效 session 一直攒着
    if (this.sessionTtlMs > 0 && this.sweepIntervalMs > 0 && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweepExpiredSessions(), this.sweepIntervalMs)
      this.sweepTimer.unref()
    }
    return this.startPromise
  }

  /** 删除已过期的 session，返回删除数量 */
  sweepExpiredSessions(): number {
    if (this.sessionTtlMs <= 0) return 0
    const now = Date.now()
    let removed = 0
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > this.sessionTtlMs) {
        this.sessions.delete(id)
        removed++
      }
    }
    if (removed > 0) this.log.info(`[stream-proxy] swept ${removed} expired sessions`)
    return removed
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.sessions.clear()
    this.server?.close()
    this.server = null
    this.port = 0
    this.startPromise = null
  }

  /** 为指定服务器的某个内网路径创建不透明会话，返回可交给渲染端的回环 URL */
  createSession(serverId: string, path: string): string {
    // 未监听（port=0）时拒绝签发：否则会得到 http://127.0.0.1:0/s/... 这类不可用 URL
    if (!this.server || this.port === 0) {
      throw new Error('[stream-proxy] not listening: await start() before createSession')
    }
    // session 容量护栏：先清扫过期，仍满则逐出最旧，避免无限累积
    if (this.sessions.size >= this.maxSessions) {
      this.sweepExpiredSessions()
      while (this.sessions.size >= this.maxSessions) {
        const oldestId = this.sessions.keys().next().value
        if (oldestId === undefined) break
        this.sessions.delete(oldestId)
      }
    }
    const id = crypto.randomUUID()
    const suffix = path.startsWith('/') ? path : `/${path}`
    this.sessions.set(id, { serverId, path: suffix, createdAt: Date.now() })
    return `http://127.0.0.1:${this.port}/s/${id}`
  }

  /** 显式失效会话（如切换服务器 / 退出登录时） */
  invalidateSession(id: string): void {
    this.sessions.delete(id)
  }

  /** 使所有会话失效（如切换活跃服务器时，强制重新签发） */
  invalidateAll(): void {
    this.sessions.clear()
  }

  private takeSession(id: string): StreamSession | null {
    const s = this.sessions.get(id)
    if (!s) return null
    if (this.sessionTtlMs > 0 && Date.now() - s.createdAt > this.sessionTtlMs) {
      this.sessions.delete(id)
      return null
    }
    return s
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const fail = (code: number, msg: string): void => {
      if (!res.headersSent) res.writeHead(code)
      res.end(msg)
    }
    // 仅接受本机回环请求，防止被其他来源当作跳板
    const remote = req.socket.remoteAddress || ''
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      fail(403, 'Forbidden')
      return
    }
    const m = (req.url || '').match(/^\/s\/([^/?]+)/)
    if (!m) {
      fail(404, 'Not Found')
      return
    }
    const session = this.takeSession(m[1])
    if (!session) {
      fail(404, 'Session Not Found')
      return
    }
    const target = this.resolveTarget(session.serverId)
    if (!target) {
      fail(404, 'Server Not Found')
      return
    }
    let upstreamUrl: URL
    try {
      upstreamUrl = new URL(`${target.url.replace(/\/+$/, '')}${session.path}`)
    } catch {
      fail(400, 'Bad Target')
      return
    }
    const headers: Record<string, string> = { 'X-Emby-Token': target.token }
    if (req.headers.range) headers['Range'] = String(req.headers.range)
    if (req.headers['user-agent']) headers['User-Agent'] = String(req.headers['user-agent'])
    if (req.headers.accept) headers['Accept'] = String(req.headers.accept)
    const transport = upstreamUrl.protocol === 'https:' ? https : http
    const proxyReq = transport.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers
      },
      (upstream) => {
        const out: Record<string, string | string[]> = {}
        for (const key of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'etag', 'last-modified']) {
          const v = upstream.headers[key]
          if (v !== undefined) out[key] = v
        }
        res.writeHead(upstream.statusCode || 502, out)
        upstream.pipe(res)
      }
    )
    // 上游不活动超时：坏连接 / 无响应服务器不能一直占用 socket 与主进程资源
    if (this.upstreamTimeoutMs > 0) {
      proxyReq.setTimeout(this.upstreamTimeoutMs, () => {
        this.log.error('[stream-proxy] upstream timeout, destroying request')
        proxyReq.destroy(new Error('upstream timeout'))
      })
    }
    proxyReq.on('error', (err) => {
      this.log.error('[stream-proxy] upstream error:', err)
      fail(502, 'Bad Gateway')
    })
    res.on('close', () => proxyReq.destroy())
    proxyReq.end()
  }
}
