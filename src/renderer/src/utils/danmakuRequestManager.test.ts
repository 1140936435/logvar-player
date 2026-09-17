import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MockInstance } from 'vitest'
import { DanmakuRequestManager } from './danmakuRequestManager'
import type { DanmakuMatchMeta } from '../../../shared/types'

type MockFn = ReturnType<typeof vi.fn>

interface DanmakuApiMock {
  matchEpisode: MockFn
  getComments: MockFn
  findLocalXml: MockFn
  prefetchSeries: MockFn
  search: MockFn
  bindEpisode: MockFn
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface MatchApiResponse {
  success: boolean
  data?: { episodeId: number; animeId?: number; animeTitle?: string; source?: string; matchLevel?: string; confidence?: number }
}

function matchResponse(episodeId: number): MatchApiResponse {
  return {
    success: true,
    data: { episodeId, animeId: 88, animeTitle: '田耕纪', source: 'dandanplay', matchLevel: 'hash', confidence: 1 }
  }
}

function makeMeta(overrides: Record<string, unknown> = {}): DanmakuMatchMeta {
  return {
    mediaSourceId: 'jellyfin-main',
    itemId: 'item-1',
    seriesName: '田耕纪',
    parentIndexNumber: 1,
    indexNumber: 1,
    filePath: 'H:/media/田耕纪/S01E01.mkv',
    ...overrides
  } as unknown as DanmakuMatchMeta
}

let api: DanmakuApiMock
let logSpy: MockInstance
let errorSpy: MockInstance

beforeEach(() => {
  api = {
    matchEpisode: vi.fn(),
    getComments: vi.fn(),
    findLocalXml: vi.fn().mockResolvedValue({ success: false }),
    prefetchSeries: vi.fn().mockResolvedValue({ success: true }),
    search: vi.fn(),
    bindEpisode: vi.fn().mockResolvedValue({ success: true })
  }
  vi.stubGlobal('window', { api: { danmaku: api, log: { send: vi.fn() } } })
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function loggedLines(spy: MockInstance): string[] {
  return spy.mock.calls.map((c) => String(c[0]))
}

describe('DanmakuRequestManager 单飞去重（并发去重）', () => {
  it('同一集并发匹配只打一次主进程请求，两个调用方拿到同一结果', async () => {
    const d = deferred<MatchApiResponse>()
    api.matchEpisode.mockReturnValue(d.promise)
    const mgr = new DanmakuRequestManager()
    const meta = makeMeta()

    const p1 = mgr.matchEpisode(meta)
    const p2 = mgr.matchEpisode(meta)
    expect(api.matchEpisode).toHaveBeenCalledTimes(1)

    d.resolve(matchResponse(123))
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.result?.episodeId).toBe(123)
    expect(r2.result?.episodeId).toBe(123)
    expect(api.matchEpisode).toHaveBeenCalledTimes(1)
    expect(loggedLines(logSpy).some((m) => m.includes('单飞去重'))).toBe(true)
  })

  it('不同集号不会被单飞误合并（各自发起请求）', async () => {
    const d1 = deferred<MatchApiResponse>()
    const d2 = deferred<MatchApiResponse>()
    api.matchEpisode.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise)
    const mgr = new DanmakuRequestManager()

    const p1 = mgr.matchEpisode(makeMeta({ indexNumber: 1 }))
    const p2 = mgr.matchEpisode(makeMeta({ indexNumber: 2 }))
    expect(api.matchEpisode).toHaveBeenCalledTimes(2)

    d1.resolve(matchResponse(11))
    d2.resolve(matchResponse(22))
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.result?.episodeId).toBe(11)
    expect(r2.result?.episodeId).toBe(22)
  })

  it('同集第二次匹配命中内存缓存，不再请求主进程', async () => {
    api.matchEpisode.mockResolvedValue(matchResponse(123))
    const mgr = new DanmakuRequestManager()
    const meta = makeMeta()

    const r1 = await mgr.matchEpisode(meta)
    const r2 = await mgr.matchEpisode(meta)

    expect(r1.result?.episodeId).toBe(123)
    expect(r2.result?.episodeId).toBe(123)
    expect(api.matchEpisode).toHaveBeenCalledTimes(1)
  })

  it('同集弹幕内容并发请求只打一次（getComments 单飞）', async () => {
    const d = deferred<{ success: boolean; data?: { count: number; comments: unknown[] } }>()
    api.getComments.mockReturnValue(d.promise)
    const mgr = new DanmakuRequestManager()

    const p1 = mgr.getComments('123', 'dandanplay')
    const p2 = mgr.getComments('123', 'dandanplay')
    expect(api.getComments).toHaveBeenCalledTimes(1)

    d.resolve({ success: true, data: { count: 2, comments: [{ p: '1,2,3,4,5', m: 'hi' }, { p: '2,2,3,4,5', m: 'yo' }] } })
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1?.count).toBe(2)
    expect(r2?.count).toBe(2)
    expect(api.getComments).toHaveBeenCalledTimes(1)
  })
})

describe('DanmakuRequestManager 超时策略（不再因短超时丢结果）', () => {
  it('匹配请求超时阈值放宽到 45s：20s 时仍等待，45s 才判定失败且只记录一次', async () => {
    vi.useFakeTimers()
    api.matchEpisode.mockReturnValue(new Promise(() => { /* 永不返回，模拟服务端极慢 */ }))
    const mgr = new DanmakuRequestManager()

    const pending = mgr.matchEpisode(makeMeta())
    let settled = false
    void pending.then(() => { settled = true })

    // 旧策略（15s）在这一步就已经超时并把结果丢掉
    await vi.advanceTimersByTimeAsync(20000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(25001)
    const r = await pending

    expect(settled).toBe(true)
    expect(r.result).toBeNull()
    const timeoutLogs = loggedLines(errorSpy).filter((m) => m.includes('超时阈值: 45000ms'))
    expect(timeoutLogs).toHaveLength(1)
  })

  it('弹幕内容请求超时阈值放宽到 40s（覆盖主进程 15s×2 + 退避）', async () => {
    vi.useFakeTimers()
    api.getComments.mockReturnValue(new Promise(() => { /* 永不返回 */ }))
    const mgr = new DanmakuRequestManager()

    const pending = mgr.getComments('999')
    let settled = false
    void pending.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(30000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(10001)
    const r = await pending

    expect(r).toBeNull()
    expect(loggedLines(errorSpy).some((m) => m.includes('超时阈值: 40000ms'))).toBe(true)
  })
})
