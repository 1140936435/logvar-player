import { describe, it, expect } from 'vitest'
import { isLoopbackHttpUrl } from './playback-url'

describe('isLoopbackHttpUrl', () => {
  it('回环 StreamProxy URL 放行', () => {
    expect(isLoopbackHttpUrl('http://127.0.0.1:52311/s/9b2f6f4e-1c1d-4c5e-8f6a-7b8c9d0e1f2a')).toBe(true)
    expect(isLoopbackHttpUrl('http://localhost:8096/s/x')).toBe(true)
    expect(isLoopbackHttpUrl('http://[::1]:8096/s/x')).toBe(true)
    expect(isLoopbackHttpUrl('https://127.0.0.1/s/x')).toBe(true)
    expect(isLoopbackHttpUrl('http://LOCALHOST/s/x')).toBe(true)
  })

  it('非回环 / 内网 / 外网 http(s) 拒绝', () => {
    expect(isLoopbackHttpUrl('http://192.168.1.10:8096/Videos/1/stream')).toBe(false)
    expect(isLoopbackHttpUrl('http://10.0.0.1/x')).toBe(false)
    expect(isLoopbackHttpUrl('https://api.dandanplay.net/x')).toBe(false)
    // 127.0.0.1 子串伪装（127.0.0.2 / 127.1.1.1 仍是回环段，但按白名单仅放行 127.0.0.1）
    expect(isLoopbackHttpUrl('http://127.0.0.2/s/x')).toBe(false)
    // 回环前缀伪装域名
    expect(isLoopbackHttpUrl('http://127.0.0.1.evil.com/s/x')).toBe(false)
    expect(isLoopbackHttpUrl('http://localhost.evil.com/s/x')).toBe(false)
  })

  it('非 http(s) scheme 与非法输入拒绝', () => {
    expect(isLoopbackHttpUrl('file:///C:/media/a.mkv')).toBe(false)
    expect(isLoopbackHttpUrl('ftp://127.0.0.1/x')).toBe(false)
    expect(isLoopbackHttpUrl('')).toBe(false)
    expect(isLoopbackHttpUrl('not a url')).toBe(false)
  })
})
