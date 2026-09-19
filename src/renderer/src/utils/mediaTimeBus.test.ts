import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMediaTimeBus, extrapolateVideoTime } from './mediaTimeBus'

/**
 * 可控 <video> mock：记录属性并提供事件注册/触发，对齐 DOM EventTarget 最小子集。
 * 与 html5.test.ts 同模式：无 jsdom，RAF 由手动驱动。
 */
interface MockVideo {
  duration: number
  currentTime: number
  playbackRate: number
  paused: boolean
  ended: boolean
  buffered: { length: number; end(i: number): number }
  addEventListener: (name: string, cb: () => void) => void
  removeEventListener: (name: string, cb: () => void) => void
  dispatch: (name: string) => void
}

function createMockVideo(init: Partial<MockVideo> = {}): MockVideo {
  const listeners = new Map<string, Set<() => void>>()
  const video: MockVideo = {
    duration: 100,
    currentTime: 0,
    playbackRate: 1,
    paused: true,
    ended: false,
    buffered: { length: 0, end: () => 0 },
    addEventListener: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(cb)
    },
    removeEventListener: (name, cb) => {
      listeners.get(name)?.delete(cb)
    },
    dispatch: (name) => {
      const cbs = listeners.get(name)
      if (cbs) cbs.forEach((cb) => cb())
    },
    ...init
  }
  return video
}

/** stub rAF：手动驱动帧回调（video 模式下 loop 每帧重新注册） */
let rafCallbacks: Array<() => void> = []
let rafCounter = 0
function runRafFrame(): void {
  const cb = rafCallbacks.shift()
  if (cb) cb()
}
function resetRaf(): void {
  rafCallbacks = []
  rafCounter = 0
}

/** 可控时钟：stub performance.now，逐帧/事件推进 nowMs 以精确断言节流窗口（150ms） */
let nowMs = 0
function advanceNow(ms: number): void {
  nowMs += ms
}

beforeEach(() => {
  resetRaf()
  nowMs = 0
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    rafCallbacks.push(cb)
    return ++rafCounter
  })
  vi.stubGlobal('cancelAnimationFrame', () => { rafCallbacks = [] })
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MediaTimeBus.attachVideo 自举（不受节流影响）', () => {
  it('attach 已播放的 video：立即 notify bootstrap 值，启动 RAF 推进，且 loop 首帧不重复普通通知', () => {
    const bus = createMediaTimeBus()
    const video = createMockVideo({ currentTime: 42, duration: 120, paused: false, ended: false })
    const seen: Array<{ time: number; isPlaying: boolean }> = []
    bus.subscribe((time, state) => seen.push({ time, isPlaying: state.isPlaying }))

    bus.attachVideo(video as unknown as HTMLVideoElement)

    // 自举：subscribe 之后 attach 也能立刻拿到当前时间，不等到下一个 rAF/事件。
    // start() 仅调度下一帧（不同步跑 loop），attach 后无同步 loop 帧，
    // 普通通知仅 bootstrap 一条（attach 自举是唯一立即通知来源）
    expect(bus.getCurrentTime()).toBe(42)
    expect(bus.getState().isPlaying).toBe(true)
    expect(bus.getState().duration).toBe(120)
    expect(seen).toEqual([{ time: 42, isPlaying: true }])

    // 已播放 → RAF 循环已调度（下一帧才开始 loop，当前无同步帧执行）
    expect(rafCallbacks.length).toBe(1)

    bus.destroy()
  })

  it('attach 暂停/结束的 video：isPlaying=false、不启动 RAF，但同样立即 notify 自举', () => {
    const bus = createMediaTimeBus()
    const video = createMockVideo({ currentTime: 12.5, paused: true, ended: false })
    const seen: Array<{ time: number; isPlaying: boolean }> = []
    bus.subscribe((time, state) => seen.push({ time, isPlaying: state.isPlaying }))

    bus.attachVideo(video as unknown as HTMLVideoElement)

    expect(bus.getCurrentTime()).toBe(12.5)
    expect(bus.getState().isPlaying).toBe(false)
    expect(seen).toEqual([{ time: 12.5, isPlaying: false }])
    // 暂停态：不应启动 RAF 循环
    expect(rafCallbacks.length).toBe(0)

    bus.destroy()
  })

  it('attach 已结束（ended）的 video：视为非播放态，不启动 RAF', () => {
    const bus = createMediaTimeBus()
    const video = createMockVideo({ currentTime: 100, paused: false, ended: true })

    bus.attachVideo(video as unknown as HTMLVideoElement)

    expect(bus.getState().isPlaying).toBe(false)
    expect(rafCallbacks.length).toBe(0)
    bus.destroy()
  })
})

describe('MediaTimeBus 普通 observer 节流（约 5~10Hz）', () => {
  it('loop 每帧只喂 RAF observer；普通 observer 至少间隔 150ms 才收到一次', () => {
    const bus = createMediaTimeBus()
    const video = createMockVideo({ currentTime: 0, paused: false })
    const seen: Array<number> = []
    bus.subscribe((time) => seen.push(time))
    const rafSeen: Array<number> = []
    bus.subscribeRAF((time) => rafSeen.push(time))

    bus.attachVideo(video as unknown as HTMLVideoElement)
    // attach 自举 1 条（不受节流）；start() 仅调度下一帧，RAF 首帧尚未运行（无同步帧）
    expect(seen).toEqual([0])
    expect(rafSeen).toEqual([])

    // 帧1：+200ms → RAF 首帧执行，普通 observer 收到（200 - 0 >= 150）
    advanceNow(200)
    video.currentTime = 0.5
    runRafFrame()
    expect(rafSeen).toEqual([0.5])
    expect(seen).toEqual([0, 0.5])

    // 帧2：+50ms（距上次 200ms 通知仅 50ms）→ 普通 observer 跳过，RAF 每帧仍收到
    advanceNow(50)
    video.currentTime = 0.6
    runRafFrame()
    expect(rafSeen).toEqual([0.5, 0.6])
    expect(seen).toEqual([0, 0.5])

    // 帧3：再 +100ms（距上次通知共 150ms）→ 普通 observer 收到
    advanceNow(100)
    video.currentTime = 0.7
    runRafFrame()
    expect(rafSeen).toEqual([0.5, 0.6, 0.7])
    expect(seen).toEqual([0, 0.5, 0.7])

    bus.destroy()
  })

  it('subscribeRAF 是唯一每帧高频通道：连续驱动多帧每帧都通知', () => {
    const bus = createMediaTimeBus()
    const video = createMockVideo({ currentTime: 10, paused: false })
    const rafSeen: Array<number> = []
    bus.subscribeRAF((time) => rafSeen.push(time))
    // 不订阅普通 observer，验证 RAF 通道独立每帧触发

    bus.attachVideo(video as unknown as HTMLVideoElement)
    // start() 不同步 loop：attach 后无同步帧，RAF 首帧从手动驱动开始
    expect(rafSeen).toEqual([])

    for (let i = 1; i <= 3; i++) {
      advanceNow(16)
      video.currentTime = 10 + i * 0.2
      runRafFrame()
    }
    expect(rafSeen).toEqual([10.2, 10.4, 10.6])

    bus.destroy()
  })

  it('事件驱动通知（seeked 等）不受节流限制，窗口内仍立即通知', () => {
    const bus = createMediaTimeBus()
    const video = createMockVideo({ currentTime: 30, paused: false })
    const seen: Array<number> = []
    bus.subscribe((time) => seen.push(time))

    bus.attachVideo(video as unknown as HTMLVideoElement)
    expect(seen).toEqual([30])

    // 距上次通知仅 50ms（< 150ms）：loop 不通知普通 observer，但 seeked 事件必须立即通知
    advanceNow(50)
    video.currentTime = 5
    video.dispatch('seeked')
    expect(seen).toEqual([30, 5])

    // 事件驱动的 notify 同时刷新节流窗口：随后 loop 首帧不再重复通知同值
    runRafFrame()
    expect(seen).toEqual([30, 5])

    bus.destroy()
  })
})

describe('extrapolateVideoTime（HTML5 视频时间平滑纯函数）', () => {
  const base = { playbackRate: 1, isPlaying: true }

  it('采样未变化且播放中：按 wall-clock × 倍速外推，帧间线性推进', () => {
    const a = extrapolateVideoTime({ ...base, rawTime: 10, nowMs: 1000, anchorTime: 10, anchorAtMs: 1000 })
    expect(a.time).toBeCloseTo(10, 6)

    const b = extrapolateVideoTime({ ...base, rawTime: 10, nowMs: 1016, anchorTime: a.anchorTime, anchorAtMs: a.anchorAtMs })
    expect(b.time).toBeCloseTo(10.016, 6)
    // 锚点保持不动（采样未前进），仅输出随 wall-clock 前进
    expect(b.anchorTime).toBe(10)
    expect(b.anchorAtMs).toBe(1000)

    const c = extrapolateVideoTime({ ...base, playbackRate: 2, rawTime: 10, nowMs: 1032, anchorTime: b.anchorTime, anchorAtMs: b.anchorAtMs })
    expect(c.time).toBeCloseTo(10.064, 6)
  })

  it('采样前进（媒体帧呈现）立即重锚到原始值，保证与视频时间轴不失同步', () => {
    const anchored = extrapolateVideoTime({ ...base, rawTime: 10, nowMs: 1000, anchorTime: 10, anchorAtMs: 1000 })
    const next = extrapolateVideoTime({
      ...base,
      rawTime: 10.0417, // 24fps：41.7ms 后新帧呈现
      nowMs: 1041.7,
      anchorTime: anchored.anchorTime,
      anchorAtMs: anchored.anchorAtMs
    })
    expect(next.time).toBe(10.0417)
    expect(next.anchorTime).toBe(10.0417)
    expect(next.anchorAtMs).toBe(1041.7)
  })

  it('采样回退（seek）立即重锚，不产生外推残留', () => {
    const next = extrapolateVideoTime({ ...base, rawTime: 3, nowMs: 2000, anchorTime: 120, anchorAtMs: 1500 })
    expect(next.time).toBe(3)
    expect(next.anchorTime).toBe(3)
  })

  it('非播放态（暂停/结束）不外推，与视频冻结行为一致', () => {
    const next = extrapolateVideoTime({ ...base, isPlaying: false, rawTime: 5, nowMs: 5000, anchorTime: 5, anchorAtMs: 1000 })
    expect(next.time).toBe(5)
    expect(next.anchorAtMs).toBe(5000)
  })

  it('外推量封顶（默认 80ms）：采样长期停滞后不无限超前', () => {
    const capped = extrapolateVideoTime({ ...base, rawTime: 7, nowMs: 5000, anchorTime: 7, anchorAtMs: 1000 })
    // 停滞 4000ms，仍只外推 80ms
    expect(capped.time).toBeCloseTo(7.08, 6)
    // 封顶后锚点同步前移：下一次调用不会在封顶值之上继续叠加
    const again = extrapolateVideoTime({ ...base, rawTime: 7, nowMs: 5016, anchorTime: capped.anchorTime, anchorAtMs: capped.anchorAtMs })
    expect(again.time).toBeCloseTo(7.08, 6)
  })

  it('非法播放倍速兜底为 1（不产生 NaN 时间）', () => {
    const next = extrapolateVideoTime({ ...base, playbackRate: Number.NaN, rawTime: 1, nowMs: 1100, anchorTime: 1, anchorAtMs: 1000 })
    expect(next.time).toBeCloseTo(1.08, 6)
  })
})

describe('HTML5 loop 用平滑时间驱动 RAF 通道（弹幕位移不再呈阶梯）', () => {
  it('24fps 采样阶梯下 RAF 每帧线性推进，新采样到来即对齐原始值', () => {
    const bus = createMediaTimeBus()
    const video = createMockVideo({ currentTime: 1.0, paused: false })
    const rafSeen: Array<number> = []
    const uiSeen: Array<number> = []
    bus.subscribeRAF((time) => rafSeen.push(time))
    bus.subscribe((time) => uiSeen.push(time))

    bus.attachVideo(video as unknown as HTMLVideoElement)

    // 帧1：+16.7ms，媒体帧尚未呈现（采样仍 1.0）→ 平滑外推
    advanceNow(16.7)
    runRafFrame()
    // 帧2：再 +16.7ms，采样仍 1.0 → 继续线性推进（旧实现此处会原地不动 = 阶梯停顿）
    advanceNow(16.7)
    runRafFrame()
    // 帧3：+8.3ms，24fps 新帧呈现（1.0417）→ 立即对齐原始值
    advanceNow(8.3)
    video.currentTime = 1.0417
    runRafFrame()

    expect(rafSeen).toHaveLength(3)
    expect(rafSeen[0]).toBeCloseTo(1.0167, 4)
    expect(rafSeen[1]).toBeCloseTo(1.0334, 4)
    expect(rafSeen[2]).toBe(1.0417)
    // 相邻帧严格前进：无"两帧不动再跳一下"的顿挫
    expect(rafSeen[1] - rafSeen[0]).toBeGreaterThan(0.015)
    expect(rafSeen[2] - rafSeen[1]).toBeGreaterThan(0.005)
    // 平滑通道与真实视频时间最大偏差不超过一个媒体帧间隔
    expect(Math.abs(rafSeen[1] - 1.0)).toBeLessThan(1 / 24)

    bus.destroy()
  })
})
