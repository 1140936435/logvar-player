import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMediaTimeBus } from './mediaTimeBus'

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

beforeEach(() => {
  resetRaf()
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    rafCallbacks.push(cb)
    return ++rafCounter
  })
  vi.stubGlobal('cancelAnimationFrame', () => { rafCallbacks = [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MediaTimeBus.attachVideo', () => {
  it('attach 已播放的 video：立即自举 currentTime/isPlaying/buffered，启动 RAF 推进，并 notify 观察者', () => {
    const bus = createMediaTimeBus()
    const video = createMockVideo({ currentTime: 42, duration: 120, paused: false, ended: false })
    const seen: Array<{ time: number; isPlaying: boolean }> = []
    bus.subscribe((time, state) => seen.push({ time, isPlaying: state.isPlaying }))

    bus.attachVideo(video as unknown as HTMLVideoElement)

    // 自举：subscribe 之后 attach 也能立刻拿到当前时间（不等到下一个 rAF/事件）。
    // start() 会同步跑 loop 首帧，因此首个回调即 bootstrap 值 42（可能随后紧跟同值帧）
    expect(bus.getCurrentTime()).toBe(42)
    expect(bus.getState().isPlaying).toBe(true)
    expect(bus.getState().duration).toBe(120)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]).toEqual({ time: 42, isPlaying: true })

    // 已播放 → RAF 循环立即启动（loop 注册），时间从 video.currentTime 推进
    expect(rafCallbacks.length).toBe(1)
    video.currentTime = 42.25
    runRafFrame()
    expect(bus.getCurrentTime()).toBe(42.25)
    expect(seen.at(-1)?.time).toBe(42.25)
    expect(seen.at(-1)?.isPlaying).toBe(true)

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
