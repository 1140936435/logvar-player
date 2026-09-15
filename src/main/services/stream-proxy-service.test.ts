import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { once } from 'events'
import http from 'http'
import crypto from 'crypto'
import { StreamProxyService, parseSessionRequestUrl, parseSessionUrl } from './stream-proxy-service'

/** 取一个随机空闲端口后立即释放，用于构造「端口上无服务监听」的上游地址 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close()
        reject(new Error('invalid free port'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

let UPSTREAM_URL = ''
let upstreamServer: http.Server | null = null

beforeAll(async () => {
  // 上游测试服务器：动态随机端口（不固定 9876），避免 CI EADDRINUSE
  upstreamServer = http.createServer((req, res) => {
    // 代理只转发 GET/HEAD（播放语义），GET 返回固定 payload 供断言；
    // 其余方法原样回环（仅用于手动验证）
    if (req.method === 'GET') {
      res.end('test data')
      return
    }
    req.pipe(res)
  })
  upstreamServer.listen(0, '127.0.0.1')
  await once(upstreamServer, 'listening')
  const addr = upstreamServer.address()
  if (!addr || typeof addr === 'string') throw new Error('bad upstream address')
  UPSTREAM_URL = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  // 真正 close，避免 Vitest 报 open handle
  upstreamServer?.closeAllConnections()
  await new Promise<void>((resolve) => upstreamServer!.close(() => resolve()))
  upstreamServer = null
})

// 测试专用桥接：源码中 port/server/sessions 为私有，这里用最小可见类型读取
type SessionMap = Map<string, { serverId: string; path: string; createdAt: number }>
const getPort = (s: StreamProxyService): number =>
  (s as unknown as { port: number }).port
const getServer = (s: StreamProxyService): http.Server | null =>
  (s as unknown as { server: http.Server | null }).server
const getSessions = (s: StreamProxyService): SessionMap =>
  (s as unknown as { sessions: SessionMap }).sessions

describe('StreamProxyService', () => {
  let svc: StreamProxyService
  let port: number

  beforeEach(async () => {
    // 模拟 resolveTarget：返回可控的测试上游（真实代理链路会据此回环）
    const mockResolve: StreamProxyService['resolveTarget'] = (serverId) => {
      expect(serverId).toBeTruthy()
      return { url: UPSTREAM_URL, token: 'test-token' }
    }
    svc = new StreamProxyService(mockResolve, {
      sessionTtlMs: 100, // 100ms TTL 方便测 sweep
      sweepIntervalMs: 50, // 50ms 每次主动清扫
      maxSessions: 2 // 方便测 session cap
    })
    await svc.start()
    port = getPort(svc)
    if (!port) {
      const server = getServer(svc)
      if (server) {
        await once(server, 'listening')
        port = getPort(svc)
      }
    }
  })

  afterEach(() => {
    svc.stop()
    upstreamServer?.closeAllConnections()
  })

  it('未启动时无法创建 session', () => {
    svc.stop()
    expect(() => svc.createSession('server', 'path'))
      .toThrow('not listening: await start() before createSession')
  })

  it('session 创建成功后回环 URL 可访问（真实代理）', async () => {
    const sessionUrl = svc.createSession('upstream-123', '/movie.mkv')
    expect(sessionUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/.*$/)
    // 代理按播放语义把请求转为 GET（携带 Range/UA 等头），上游返回 payload
    const resp = await fetch(sessionUrl)
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('test data')
  })

  it('session 404，不存在时回 404（非 403，不提示外泄）', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/s/invalid-id`, { redirect: 'manual' })
    expect(resp.status).toBe(404)
    await resp.text() // 确保结束
  })

  it('method 收紧：非 GET/HEAD 一律 405 并带 Allow 头，GET/HEAD 不受影响', async () => {
    const sessionUrl = svc.createSession('upstream-123', '/movie.mkv')
    // 其余 method 直接 405 拒绝（在代理层拦截，不转发上游）
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const) {
      const resp = await fetch(sessionUrl, { method, redirect: 'manual' })
      expect(resp.status).toBe(405)
      expect(resp.headers.get('allow')).toBe('GET, HEAD')
      await resp.text()
    }
    // GET / HEAD 仍正常代理
    const respGet = await fetch(sessionUrl)
    expect(respGet.status).toBe(200)
    expect(await respGet.text()).toBe('test data')
    const respHead = await fetch(sessionUrl, { method: 'HEAD' })
    expect(respHead.status).toBe(200)
    await respHead.text()
  })

  it('session path parser：请求行 path-only URL 统一解析（带 query/hash 拒绝，与 parseSessionUrl 口径一致）', () => {
    expect(parseSessionRequestUrl('/s/abc')).toBe('abc')
    // query / hash 一律拒绝（不再容错），消除与 parseSessionUrl 的口径差异
    expect(parseSessionRequestUrl('/s/abc?range=0-100')).toBeNull()
    expect(parseSessionRequestUrl('/s/abc#frag')).toBeNull()
    expect(parseSessionRequestUrl('/other')).toBeNull()
    expect(parseSessionRequestUrl('/s/')).toBeNull()
    expect(parseSessionRequestUrl('/s/a/b')).toBeNull()
    expect(parseSessionRequestUrl('')).toBeNull()
  })

  it('session path parser：完整 URL 约束统一收敛（scheme/host/port/query/hash/子路径）', async () => {
    const sessionUrl = svc.createSession('upstream-123', '/video.mp4')
    const id = sessionUrl.split('/s/')[1]
    expect(parseSessionUrl(sessionUrl, port)).toBe(id)
    // 安全收紧：HTTPS / 错误端口 / 非 127.0.0.1 / query / hash / 额外路径段均拒绝
    expect(parseSessionUrl(sessionUrl.replace('http:', 'https:'), port)).toBeNull()
    expect(parseSessionUrl(sessionUrl.replace(`:${port}`, ':9999'), port)).toBeNull()
    expect(parseSessionUrl(sessionUrl.replace('127.0.0.1', 'localhost'), port)).toBeNull()
    expect(parseSessionUrl(`${sessionUrl}?foo=bar`, port)).toBeNull()
    expect(parseSessionUrl(`${sessionUrl}#frag`, port)).toBeNull()
    expect(parseSessionUrl(`${sessionUrl}/extra`, port)).toBeNull()
  })

  it('sessionTtlMs > 0 时，过期的 session 在访问时自动删除', async () => {
    // 创建 session 并等待过期
    const sessionUrl = svc.createSession('upstream-123', '/test')
    const id = sessionUrl.split('/s/')[1]
    expect(getSessions(svc).size).toBe(1)

    // 等待过期
    await new Promise(r => setTimeout(r, 150))

    // 访问过期 session 会被清除并 404
    const resp = await fetch(sessionUrl, { redirect: 'manual' })
    expect(resp.status).toBe(404)
    expect(getSessions(svc).size).toBe(0)
  })

  it('sessionTtlMs <= 0 时，session 永不过期', async () => {
    // beforeEach 的实例 TTL=100ms，这里必须用独立的无 TTL 实例验证语义
    const noTtlSvc = new StreamProxyService(
      () => ({ url: UPSTREAM_URL, token: 'test-token' }),
      { sessionTtlMs: 0, sweepIntervalMs: 50 }
    )
    await noTtlSvc.start()
    try {
      const sessionUrl = noTtlSvc.createSession('upstream-123', '/test')
      // 等待多次 sweep 循环（50ms × 4 = 200ms）
      await new Promise(r => setTimeout(r, 200))
      expect(getSessions(noTtlSvc).size).toBe(1)
      // 仍可访问
      const resp = await fetch(sessionUrl)
      expect(resp.status).toBe(200)
    } finally {
      noTtlSvc.stop()
    }
  })

  it('maxSessions 达限时，先清扫过期，再逐出最旧的 session', async () => {
    // 创建 3 个 session（但配置只保留 2 个）
    const s1 = svc.createSession('s', '/a')
    const s2 = svc.createSession('s', '/b')
    // 确保 s1 是最旧（s2 最新）
    await new Promise(r => setTimeout(r, 10))
    const s3 = svc.createSession('s', '/c')

    // 模拟 expire sweep：s1 已过期，s2/s3 有效，s1 被清除，容量达到上限
    expect(getSessions(svc).size).toBe(2)

    // 访问 s1 时应该报 404（已被淘汰）
    const resp1 = await fetch(s1.split('/s/')[0] + '/s/invalid', { redirect: 'manual' })
    expect(resp1.status).toBe(404)
    // s2/s3 仍可用
    const resp2 = await fetch(s2)
    expect(resp2.status).toBe(200)
    const resp3 = await fetch(s3)
    expect(resp3.status).toBe(200)
  })

  it('upstreamTimeoutMs > 0 时，坏上游连接超时并报错', async () => {
    // 动态取一个无服务监听的端口，避免固定端口造成 EADDRINUSE
    const deadPort = await getFreePort()
    // 超短超时，确保可测
    const fastTimeoutSvc = new StreamProxyService(
      () => ({ url: `http://127.0.0.1:${deadPort}/delay`, token: '' }),
      { upstreamTimeoutMs: 100, sessionTtlMs: 0 }
    )
    await fastTimeoutSvc.start()
    const sessionUrl = fastTimeoutSvc.createSession('s', '/test')
    const resp = await fetch(sessionUrl)
    expect(resp.status).toBe(502)
    fastTimeoutSvc.stop()
  })

  it('sweepExpiredSessions 返回删除数量', () => {
    svc.createSession('s', '/a')
    svc.createSession('s', '/b')
    expect(getSessions(svc).size).toBe(2)

    // 模拟过期
    getSessions(svc).forEach(v => {
      v.createdAt = Date.now() - 200
    })

    expect(svc.sweepExpiredSessions()).toBe(2)
    expect(getSessions(svc).size).toBe(0)
  })

  it('sweepExpiredSessions 不影响有效 session', () => {
    svc.createSession('s', '/a')
    // 让另一个 session 成为最近
    const sessionUrl = svc.createSession('s', '/b')
    const id = sessionUrl.split('/s/')[1]

    // 模拟全过期，但最后添加的不变
    getSessions(svc).forEach(v => {
      if (v.path === '/a') {
        v.createdAt = Date.now() - 200
      } else {
        v.createdAt = Date.now() - 50
      }
    })

    expect(svc.sweepExpiredSessions()).toBe(1)
    expect(getSessions(svc).size).toBe(1)
    expect(getSessions(svc).get(id)).toBeTruthy()
  })

  it('ownsSessionUrl 正确判断合法 session URL', () => {
    const s1 = svc.createSession('test', '/video.mp4')
    expect(svc.ownsSessionUrl(s1)).toBe(true)
    // 非 session 路径
    expect(svc.ownsSessionUrl(`http://127.0.0.1:${port}/test`)).toBe(false)
  })

  it('安全收紧：HTTPS / 错误端口 / 非 127.0.0.1 均返回 false', () => {
    const s1 = svc.createSession('test', '/video.mp4')
    // HTTPS URL → false
    expect(svc.ownsSessionUrl(s1.replace('http:', 'https:'))).toBe(false)
    // 错误端口 → false
    expect(svc.ownsSessionUrl(s1.replace(`:${port}`, ':9999'))).toBe(false)
    // 非 127.0.0.1 → false
    expect(svc.ownsSessionUrl(s1.replace('127.0.0.1', 'localhost'))).toBe(false)
    expect(svc.ownsSessionUrl(s1.replace('127.0.0.1', '10.0.0.1'))).toBe(false)
    expect(svc.ownsSessionUrl(s1.replace('127.0.0.1', '0.0.0.0'))).toBe(false)
  })

  it('安全收紧：/s/id/extra、query/hash、随机不存在的 id 均返回 false', () => {
    const s1 = svc.createSession('test', '/video.mp4')
    // /s/id/extra → false（额外路径段）
    expect(svc.ownsSessionUrl(`${s1}/extra`)).toBe(false)
    // query / hash → false
    expect(svc.ownsSessionUrl(`${s1}?foo=bar`)).toBe(false)
    expect(svc.ownsSessionUrl(`${s1}#frag`)).toBe(false)
    // 随机不存在 session ID → false
    const randomId = crypto.randomUUID()
    expect(svc.ownsSessionUrl(s1.replace(/\/s\/[^/]+/, `/s/${randomId}`))).toBe(false)
  })

  it('安全收紧：已过期 session 返回 false', async () => {
    const sessionUrl = svc.createSession('test', '/video.mp4')
    expect(svc.ownsSessionUrl(sessionUrl)).toBe(true)
    // TTL=100ms，等待过期
    await new Promise(r => setTimeout(r, 150))
    expect(svc.ownsSessionUrl(sessionUrl)).toBe(false)
  })

  it('上游返回错误状态码时按透传状态码返回，不卡死连接', async () => {
    // 动态端口的临时上游，返回 404
    const brokenUpstream = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end('Not Found')
    })
    brokenUpstream.listen(0, '127.0.0.1')
    await once(brokenUpstream, 'listening')
    const addr = brokenUpstream.address()
    if (!addr || typeof addr === 'string') {
      brokenUpstream.close()
      throw new Error('bad broken upstream address')
    }

    const fastTimeoutSvc = new StreamProxyService(
      () => ({ url: `http://127.0.0.1:${addr.port}/test`, token: '' }),
      { upstreamTimeoutMs: 100, sessionTtlMs: 0 }
    )
    await fastTimeoutSvc.start()
    try {
      const sessionUrl = fastTimeoutSvc.createSession('s', '/test')
      const resp = await fetch(sessionUrl, { redirect: 'manual' })
      expect(resp.status).toBe(404)
      await resp.text() // 确保结束
    } finally {
      brokenUpstream.closeAllConnections()
      await new Promise<void>((resolve) => brokenUpstream.close(() => resolve()))
      fastTimeoutSvc.stop()
    }
  })
}, { timeout: 10000 })
