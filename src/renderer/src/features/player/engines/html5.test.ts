import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type React from 'react'
import type { PlaybackEvent } from './types'
import { Html5PlaybackEngine } from './html5'

/**
 * 可控 <video> mock：记录属性写入并提供事件注册/触发。
 * 事件系统对齐 DOM EventTarget 最小子集，足以驱动引擎归一化逻辑。
 */
interface MockVideo {
  src: string
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  playbackRate: number
  error: { code: number } | null
  buffered: { length: number; end(i: number): number }
  loadCalls: number
  playCalls: number
  pauseCalls: number
  querySelectorAll: (sel: string) => { remove(): void }[]
  addEventListener: (name: string, cb: () => void) => void
  removeEventListener: (name: string, cb: () => void) => void
  dispatch: (name: string) => void
  play: () => Promise<void>
  pause: () => void
  load: () => void
}

function createMockVideo(): MockVideo {
  const listeners = new Map<string, Set<() => void>>()
  const video: MockVideo = {
    src: '',
    currentTime: 0,
    duration: 100,
    volume: 1,
    muted: false,
    playbackRate: 1,
    error: null,
    buffered: { length: 0, end: () => 0 },
    loadCalls: 0,
    playCalls: 0,
    pauseCalls: 0,
    querySelectorAll: () => [{ remove() {} }],
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
    play: () => {
      video.playCalls++
      return Promise.resolve()
    },
    pause: () => {
      video.pauseCalls++
    },
    load: () => {
      video.loadCalls++
    }
  }
  return video
}

/** 收集引擎归一化事件 */
function collectEvents(engine: Html5PlaybackEngine): PlaybackEvent[] {
  const events: PlaybackEvent[] = []
  engine.onEvent((e) => events.push(e))
  return events
}

/** stub rAF：手动驱动帧回调 */
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Html5PlaybackEngine', () => {
  it('ref 为 null 时创建，随后 ref 挂载 → load() 仍能正常写入并绑定事件', async () => {
    const ref = { current: null } as React.RefObject<HTMLVideoElement | null>
    const engine = new Html5PlaybackEngine(ref)
    // 创建时 ref 为 null，不绑定事件
    expect(rafCallbacks.length).toBe(0)

    // 挂载后 load：应解析真实 ref 并补绑定
    const video = createMockVideo()
    ref.current = video as unknown as HTMLVideoElement
    await engine.load({ url: 'file:///movie.mp4', isLocal: true })

    expect(video.src).toBe('file:///movie.mp4')
    expect(video.loadCalls).toBe(1)
    // load 后自动 play（autoplay 语义）
    expect(video.playCalls).toBe(1)
    // 补绑定生效：事件能收到
    const events = collectEvents(engine)
    video.dispatch('loadedmetadata')
    expect(events.some((e) => e.type === 'loaded')).toBe(true)
  })

  it('load() 后播放状态符合统一 Engine 契约（loaded/duration/play/pause/seek/speed 事件 + 控制方法）', async () => {
    const video = createMockVideo()
    const ref = { current: video as unknown as HTMLVideoElement } as React.RefObject<HTMLVideoElement | null>
    const engine = new Html5PlaybackEngine(ref)
    const events = collectEvents(engine)

    await engine.load({ url: 'https://x/media.mp4', isLocal: false })
    expect(video.src).toBe('https://x/media.mp4')

    // loadedmetadata → duration + loaded
    video.dispatch('loadedmetadata')
    expect(events).toContainEqual({ type: 'duration', duration: 100 })
    expect(events).toContainEqual({ type: 'loaded', active: false })

    // play/pause 事件
    video.dispatch('play')
    expect(events).toContainEqual({ type: 'play' })
    video.dispatch('pause')
    expect(events).toContainEqual({ type: 'pause' })

    // 控制方法可调用
    await engine.play()
    expect(video.playCalls).toBeGreaterThan(0)
    await engine.pause()
    expect(video.pauseCalls).toBeGreaterThan(0)

    // seek + seeked 事件
    await engine.seek(42)
    expect(video.currentTime).toBe(42)
    video.dispatch('seeked')
    expect(events).toContainEqual({ type: 'seeked', currentTime: 42 })

    // speed + ratechange 事件
    await engine.setSpeed(1.5)
    expect(video.playbackRate).toBe(1.5)
    video.dispatch('ratechange')
    expect(events).toContainEqual({ type: 'speed', speed: 1.5 })
  })

  it('setVolume(150) 不越界：DOM volume 写 1.0（0~100 语义），不出现 1.5', async () => {
    const video = createMockVideo()
    const ref = { current: video as unknown as HTMLVideoElement } as React.RefObject<HTMLVideoElement | null>
    const engine = new Html5PlaybackEngine(ref)

    await engine.setVolume(150)
    expect(video.volume).toBe(1.0)
    expect(video.muted).toBe(false)

    await engine.setVolume(100)
    expect(video.volume).toBe(1.0)

    await engine.setVolume(50)
    expect(video.volume).toBe(0.5)

    await engine.setVolume(-10)
    expect(video.volume).toBe(0)
    expect(video.muted).toBe(true)
  })

  it('muted 时 volume=0 由 volumechange 统一保证，toggleMute 不再手动发 volume 事件', async () => {
    const video = createMockVideo()
    const ref = { current: video as unknown as HTMLVideoElement } as React.RefObject<HTMLVideoElement | null>
    const engine = new Html5PlaybackEngine(ref)
    const events = collectEvents(engine)

    // 浏览器置 muted=true 后触发 volumechange：事件必须报 0 而非 50
    video.volume = 0.5
    video.muted = true
    video.dispatch('volumechange')
    expect(events.filter((e) => e.type === 'volume').at(-1)).toEqual({ type: 'volume', volume: 0 })

    // toggleMute 取消静音：仅翻转 muted，不手动发 volume 事件（volumechange 负责）
    engine.toggleMute()
    expect(video.muted).toBe(false)
    expect(events.filter((e) => e.type === 'volume').length).toBe(1) // 仍只有上面那一条

    // DOM 随后触发 volumechange：恢复原音量 50
    video.dispatch('volumechange')
    expect(events.filter((e) => e.type === 'volume').at(-1)).toEqual({ type: 'volume', volume: 50 })

    // toggleMute 再次静音 → 同样不发事件；volumechange 触发后才发 0
    engine.toggleMute()
    expect(video.muted).toBe(true)
    expect(events.filter((e) => e.type === 'volume').length).toBe(2)
    video.dispatch('volumechange')
    expect(events.filter((e) => e.type === 'volume').at(-1)).toEqual({ type: 'volume', volume: 0 })
  })

  it('dispose 后停止事件发射并解绑 video 事件', async () => {
    const video = createMockVideo()
    const ref = { current: video as unknown as HTMLVideoElement } as React.RefObject<HTMLVideoElement | null>
    const engine = new Html5PlaybackEngine(ref)
    const events = collectEvents(engine)

    await engine.dispose()
    expect(rafCallbacks.length).toBe(0)
    video.dispatch('play')
    video.dispatch('loadedmetadata')
    expect(events.length).toBe(0)
  })
})
