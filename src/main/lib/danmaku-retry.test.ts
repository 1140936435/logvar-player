import { describe, it, expect } from 'vitest'
import {
  DANMAKU_TIMEOUT_MS,
  DANMAKU_MAX_RETRIES,
  DANMAKU_HASH_TIMEOUT_MS,
  DANMAKU_RETRY_BASE_DELAY_MS,
  DANMAKU_RETRY_JITTER_MS,
  computeRetryDelayMs,
  isRetryableError,
  normalizeMirrorList
} from './danmaku-retry'

describe('danmaku-retry 超时/重试常量（策略锁定）', () => {
  it('单次超时放宽到 15s 并保留 1 次重试（原 5s / 固定 300ms 退避）', () => {
    expect(DANMAKU_TIMEOUT_MS).toBe(15000)
    expect(DANMAKU_MAX_RETRIES).toBe(1)
  })

  it('hash 快速通道使用更短的专用超时，不继承默认链路预算', () => {
    expect(DANMAKU_HASH_TIMEOUT_MS).toBe(10000)
    expect(DANMAKU_HASH_TIMEOUT_MS).toBeLessThan(DANMAKU_TIMEOUT_MS)
  })
})

describe('computeRetryDelayMs 指数退避', () => {
  const noJitter = (): number => 0

  it('按 600 → 1200 → 2400ms 指数增长', () => {
    expect(computeRetryDelayMs(1, noJitter)).toBe(600)
    expect(computeRetryDelayMs(2, noJitter)).toBe(1200)
    expect(computeRetryDelayMs(3, noJitter)).toBe(2400)
  })

  it('受 5000ms 上限约束，不会无限增长', () => {
    expect(computeRetryDelayMs(5, noJitter)).toBe(5000)
    expect(computeRetryDelayMs(20, noJitter)).toBe(5000)
  })

  it('叠加抖动且抖动不超过上限', () => {
    expect(computeRetryDelayMs(1, () => 1)).toBe(600 + DANMAKU_RETRY_JITTER_MS)
    const d = computeRetryDelayMs(3)
    expect(d).toBeGreaterThanOrEqual(2400)
    expect(d).toBeLessThanOrEqual(2400 + DANMAKU_RETRY_JITTER_MS)
  })

  it('非法 attempt（0 / 负数）按首次退避处理，不产生非有限值', () => {
    expect(computeRetryDelayMs(0, noJitter)).toBe(DANMAKU_RETRY_BASE_DELAY_MS)
    expect(computeRetryDelayMs(-3, noJitter)).toBe(DANMAKU_RETRY_BASE_DELAY_MS)
  })
})

describe('isRetryableError', () => {
  it('超时 / 连接中断类错误可重试', () => {
    expect(isRetryableError(new Error('Request timeout after 15000ms'))).toBe(true)
    expect(isRetryableError(new Error('socket hang up'))).toBe(true)
    expect(isRetryableError(new Error('read ECONNRESET'))).toBe(true)
  })

  it('认证 / 业务错误不重试（重试无意义）', () => {
    expect(isRetryableError(new Error('DandanPlay API 需要认证 (HTTP 403)'))).toBe(false)
    expect(isRetryableError('HTTP 404 Not Found')).toBe(false)
  })
})

describe('normalizeMirrorList', () => {
  it('清洗数组：去空、去重、去尾斜杠、trim', () => {
    expect(normalizeMirrorList(['http://a.com/', ' http://a.com ', '', 'http://b.com']))
      .toEqual(['http://a.com', 'http://b.com'])
  })

  it('兼容换行 / 逗号分隔的字符串写法', () => {
    expect(normalizeMirrorList('http://a.com\nhttp://b.com, http://c.com/'))
      .toEqual(['http://a.com', 'http://b.com', 'http://c.com'])
  })

  it('空值 / 非法类型 → 空列表（不臆造任何默认备用源）', () => {
    expect(normalizeMirrorList(undefined)).toEqual([])
    expect(normalizeMirrorList(null)).toEqual([])
    expect(normalizeMirrorList(123)).toEqual([])
    expect(normalizeMirrorList([])).toEqual([])
  })
})
