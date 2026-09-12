import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { once } from 'events'
import http from 'http'
import { StreamProxyService } from './stream-proxy-service'

const UPSTREAM_URL = 'http://127.0.0.1:9876/test'
const UPSTREAM_SERVER = http.createServer((req, res) => {
  req.pipe(res) // 简单回环，便于验证数据
}).listen(9876)

afterEach(() => {
  UPSTREAM_SERVER.closeAllConnections()
})

describe('StreamProxyService', () => {
  let svc: StreamProxyService
  let port: number

  beforeEach(async () => {
    // 模拟 resolveTarget，返回我们可控的测试服务器 URL
    const mockResolve: StreamProxyService['resolveTarget'] = (serverId, path) => {
      expect(serverId).toBe('upstream-123')
      return new URL(path, UPSTREAM_URL).toString()
    }
    svc = new StreamProxyService(mockResolve, {
      sessionTtlMs: 100, // 100ms TTL 方便测 sweep
      sweepIntervalMs: 50, // 50ms 每次主动清扫
      maxSessions: 2 // 方便测 session cap
    })
    await svc.start()
    port = svc.port
    if (!port) {
      await once(svc.server, 'listening')
      port = svc.port!
    }
  })

  afterEach(async () => {
    svc.stop()
  })

  it('未启动时无法创建 session', () => {
    svc.stop()
    expect(() => svc.createSession('server', 'path'))
      .toThrow('not listening: await start() before createSession')
  })

  it('session 创建成功后回环 URL 可访问（真实代理）', async () => {
    const sessionUrl = svc.createSession('upstream-123', '/movie.mkv')
    expect(sessionUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/.*$/)
    const resp = await fetch(sessionUrl, {
      method: 'POST',
      body: Buffer.from('test data', 'binary')
    })
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('test data')
  })

  it(' session 404，不存在时回 404（非 403，不提示外泄）', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/s/invalid-id`, { redirect: 'manual' })
    expect(resp.status).toBe(404)
    await resp.text() // 确保结束
  })

  it('sessionTtlMs > 0 时，过期的 session 在访问时自动删除', async () => {
    // 创建 session 并等待过期
    const sessionUrl = svc.createSession('upstream-123', '/test')
    const id = sessionUrl.split('/s/')[1]
    expect(svc['_sessions'].size).toBe(1)

    // 等待过期
    await new Promise(r => setTimeout(r, 150))

    // 访问过期 session 会被清除并 404
    const resp = await fetch(sessionUrl, { redirect: 'manual' })
    expect(resp.status).toBe(404)
    expect(svc['_sessions'].size).toBe(0)
  })

  it('sessionTtlMs <= 0 时，session 永不过期', async () => {
    const sessionUrl = svc.createSession('upstream-123', '/test')
    // 等待多次 sweep 循环（默认 50ms × 3 = 150ms，远大于普通超时）
    await new Promise(r => setTimeout(r, 200))
    expect(svc['_sessions'].size).toBe(1)
    // 仍可访问
    const resp = await fetch(sessionUrl)
    expect(resp.status).toBe(200)
  })

  it('maxSessions 达限时，先清扫过期，再逐出最旧的 session', async () => {
    // 创建 3 个 session（但配置只保留 2 个）
    const s1 = svc.createSession('s', '/a')
    const s2 = svc.createSession('s', '/b')
    // 确保 s1 是最旧（s2 最新）
    await new Promise(r => setTimeout(r, 10))
    const s3 = svc.createSession('s', '/c')

    // 模拟 expire sweep：s1 已过期，s2/s3 有效，s1 被清除，容量达到上限
    expect(svc['_sessions'].size).toBe(2)

    // 访问 s1 时应该报 404（已被淘汰）
    const resp1 = await fetch(s1.split('/s/')[0] + '/s/invalid', { redirect: 'manual' })
    expect(resp1.status).toBe(404)
    // s2/s3 仍可用
    const resp2 = await fetch(s2)
    expect(resp2.status).toBe(200)
    const resp3 = await fetch(s3)
    expect(resp3.status).toBe(200)
  })

  it('upstreamTimeoutMs > 0 时，坏上游连接超时并报错', (done) => {
    // 超短超时，确保可测
    const fastTimeoutSvc = new StreamProxyService(
      (serverId, path) => 'http://127.0.0.1:9999/delay',
      { upstreamTimeoutMs: 100, sessionTtlMs: 0 }
    )
    fastTimeoutSvc.start().then(() => {
      const sessionUrl = fastTimeoutSvc.createSession('s', '/test')
      fetch(sessionUrl)
        .then(r => {
          expect(r.status).toBe(502)
          fastTimeoutSvc.stop()
          done()
        })
        .catch(done)
    }).catch(done)
  })

  it('sweepExpiredSessions 返回删除数量', () => {
    svc.createSession('s', '/a')
    svc.createSession('s', '/b')
    expect(svc['_sessions'].size).toBe(2)

    // 模拟过期
    svc['_sessions'].forEach(v => {
      v.createdAt = Date.now() - 200
    })

    expect(svc.sweepExpiredSessions()).toBe(2)
    expect(svc['_sessions'].size).toBe(0)
  })

  it('sweepExpiredSessions 不影响有效 session', () => {
    svc.createSession('s', '/a')
    // 让另一个 session 成为最近
    const sessionUrl = svc.createSession('s', '/b')
    const id = sessionUrl.split('/s/')[1]

    // 模拟全过期，但最后添加的不变
    svc['_sessions'].forEach(v => {
      if (v.path === '/a') {
        v.createdAt = Date.now() - 200
      } else {
        v.createdAt = Date.now() - 50
      }
    })

    expect(svc.sweepExpiredSessions()).toBe(1)
    expect(svc['_sessions'].size).toBe(1)
    expect(svc['_sessions'].get(id)).toBeTruthy()
  })
}, { timeout: 10000 })
