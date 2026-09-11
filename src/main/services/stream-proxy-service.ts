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
  logger?: StreamProxyLogger
}

interface StreamSession {
  serverId: string
  path: string
  createdAt: number
}

const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000

/**
 * 播放流代理：对渲染端只暴露「不透明 session URL」，真实服务器地址与凭据全部留在主进程。
 * 会话只能由主进程创建，URL 中不含 serverId / token，渲染端无法自造指向任意服务器的地址。
 * mpv（独立/画布）与 html5 各引擎都只是普通 http 客户端，因此统一走本代理。
 */
export class StreamProxyService {
  private server: http.Server | null = null
  private port = 0
  private readonly sessions = new Map<string, StreamSession>()
  private readonly sessionTtlMs: number
  private readonly log: StreamProxyLogger

  constructor(
    private readonly resolveTarget: StreamTargetResolver,
    options: StreamProxyOptions = {}
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.log = options.logger ?? console
  }

  /** 启动回环代理（幂等） */
  start(): void {
    if (this.server) return
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.on('error', (err) => this.log.error('[stream-proxy] server error:', err))
    this.server.listen(0, '127.0.0.1', () => {
      const addr = this.server?.address()
      if (addr && typeof addr === 'object') {
        this.port = addr.port
        this.log.info(`[stream-proxy] listening on 127.0.0.1:${this.port}`)
      }
    })
  }

  stop(): void {
    this.sessions.clear()
    this.server?.close()
    this.server = null
    this.port = 0
  }

  /** 为指定服务器的某个内网路径创建不透明会话，返回可交给渲染端的回环 URL */
  createSession(serverId: string, path: string): string {
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
    proxyReq.on('error', (err) => {
      this.log.error('[stream-proxy] upstream error:', err)
      fail(502, 'Bad Gateway')
    })
    res.on('close', () => proxyReq.destroy())
    proxyReq.end()
  }
}
