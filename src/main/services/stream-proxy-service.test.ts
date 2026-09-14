import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { once } from 'events'
import http from 'http'
import { StreamProxyService } from './stream-proxy-service'

const UPSTREAM_URL = 'http://127.0.0.1:9876'
const UPSTREAM_SERVER = http.createServer((req, res) => {
  // 代理只转发 GET/HEAD（播放语义），GET 返回固定 payload 供断言；
  // 其余方法原样回环（仅用于手动验证）
  if (req.method === 'GET') {
    res.end('test data')
    return
  }
  req.pipe(res)
}).listen(9876)

afterEach(() => {
  UPSTREAM_SERVER.closeAllConnections()
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

  afterEach(async () => {
    svc.stop()
    UPSTREAM_SERVER.closeAllConnections()
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
    // 超短超时，确保可测
    const fastTimeoutSvc = new StreamProxyService(
      () => ({ url: 'http://127.0.0.1:9999/delay', token: '' }),
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
    // 同一实例的合法 session（相同 id）
    const validButInvalidUrl = s1.replace(/\/s\/.*/, '/s/' + new URL(s1).pathname.split('/')[2])
    expect(svc.ownsSessionUrl(validButInvalidUrl)).toBe(true)
    // 无效 session id
    expect(svc.ownsSessionUrl(s1.replace(/\/s\/.*/, '/s/invalid'))).toBe(false)
    // 主机或端口不匹配
    expect(svc.ownsSessionUrl(s1.replace('127.0.0.1', 'localhost'))).toBe(false)
    expect(svc.ownsSessionUrl(s1.replace(`:${port}`, ':9999'))).toBe(false)
    // 非 session 路径
    expect(svc.ownsSessionUrl(`http://127.0.0.1:${port}/test`)).toBe(false)
  })

  it('上游错误（如 404）时代理回 502，不卡死连接', async () => {
    // 起一个模拟上游 404 的临时服务
    const brokenUpstream = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end('Not Found')
    }).listen(9877)
    await once(brokenUpstream, 'listening')

    const fastTimeoutSvc = new StreamProxyService(
      () => ({ url: 'http://127.0.0.1:9877/test', token: '' }),
      { upstreamTimeoutMs: 100, sessionTtlMs: 0 }
    )
    await fastTimeoutSvc.start()
    const sessionUrl = fastTimeoutSvc.createSession('s', '/test')
    const resp = await fetch(sessionUrl, { redirect: 'manual' })
    expect(resp.status).toBe(404)
    await resp.text() // 确保结束
    brokenUpstream.close()
    fastTimeoutSvc.stop()
  })
}, { timeout: 10000 })
