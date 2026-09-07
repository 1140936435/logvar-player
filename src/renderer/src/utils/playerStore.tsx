import React, { createContext, useContext, useRef, useEffect, useMemo, useState } from 'react'

export interface PlayerStoreState {
  currentTime: number
  duration: number
  playbackRate: number
  isPlaying: boolean
  volume: number
  buffered: number
  error: string
  loading: boolean
}

interface PlayerStoreActions {
  setCurrentTime: (time: number) => void
  forceNotifyCurrentTime: () => void
  setDuration: (duration: number) => void
  setPlaybackRate: (rate: number) => void
  setIsPlaying: (playing: boolean) => void
  setVolume: (volume: number) => void
  setBuffered: (buffered: number) => void
  setError: (error: string) => void
  setLoading: (loading: boolean) => void
  reset: () => void
}

type Listener = (state: PlayerStoreState) => void

class PlayerStoreImpl {
  private state: PlayerStoreState = {
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    isPlaying: false,
    volume: 100,
    buffered: 0,
    error: '',
    loading: true
  }

  private listeners: Set<Listener> = new Set()

  // 性能优化：节流 currentTime 通知，避免 60fps React 重渲染
  private lastNotifyTime = 0
  private static CURRENT_TIME_NOTIFY_INTERVAL = 200 // ms，约 5fps 通知 UI 更新

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): PlayerStoreState {
    return { ...this.state }
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      listener({ ...this.state })
    })
  }

  // 性能优化：节流 notify，浮点时间每帧都不同导致原来每帧都触发 React 重渲染
  // 现在仅当时间变化 >= 200ms 或暂停时才通知 UI，弹幕引擎通过 RAF 订阅独立更新
  setCurrentTime(time: number): void {
    this.state.currentTime = time
    const now = Date.now()
    if (now - this.lastNotifyTime >= PlayerStoreImpl.CURRENT_TIME_NOTIFY_INTERVAL ||
        this.state.isPlaying !== true) {
      // 暂停时（如 seek 操作）需要立即通知 UI 更新
      this.lastNotifyTime = now
      this.notify()
    }
  }

  // seek 操作时强制立即通知 UI，确保进度条即时响应
  forceNotifyCurrentTime(): void {
    this.lastNotifyTime = Date.now()
    this.notify()
  }

  setDuration(duration: number): void {
    if (this.state.duration !== duration) {
      this.state.duration = duration
      this.notify()
    }
  }

  setPlaybackRate(rate: number): void {
    if (this.state.playbackRate !== rate) {
      this.state.playbackRate = rate
      this.notify()
    }
  }

  setIsPlaying(playing: boolean): void {
    if (this.state.isPlaying !== playing) {
      this.state.isPlaying = playing
      this.notify()
    }
  }

  setVolume(volume: number): void {
    if (this.state.volume !== volume) {
      this.state.volume = volume
      this.notify()
    }
  }

  setBuffered(buffered: number): void {
    if (this.state.buffered !== buffered) {
      this.state.buffered = buffered
      this.notify()
    }
  }

  setError(error: string): void {
    if (this.state.error !== error) {
      this.state.error = error
      this.notify()
    }
  }

  setLoading(loading: boolean): void {
    if (this.state.loading !== loading) {
      this.state.loading = loading
      this.notify()
    }
  }

  reset(): void {
    this.state = {
      currentTime: 0,
      duration: 0,
      playbackRate: 1,
      isPlaying: false,
      volume: 100,
      buffered: 0,
      error: '',
      loading: true
    }
    this.notify()
  }
}

const PlayerStoreContext = createContext<PlayerStoreImpl | null>(null)

export const PlayerStoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const storeRef = useRef<PlayerStoreImpl>(new PlayerStoreImpl())

  return (
    <PlayerStoreContext.Provider value={storeRef.current}>
      {children}
    </PlayerStoreContext.Provider>
  )
}

export function usePlayerStore(): [PlayerStoreState, PlayerStoreActions] {
  const store = useContext(PlayerStoreContext)
  if (!store) {
    throw new Error('usePlayerStore must be used within PlayerStoreProvider')
  }

  const [state, setState] = useState<PlayerStoreState>(store.getState())

  useEffect(() => {
    const unsubscribe = store.subscribe(setState)
    return unsubscribe
  }, [store])

  // 性能优化：actions 用 useMemo 缓存，空依赖 —— store 实例来自 Provider 的 useRef，
  // 全生命周期稳定不变。此前每次渲染重建 actions 对象导致依赖它的 effect 每 ~200ms 重跑。
  const actions: PlayerStoreActions = useMemo(() => ({
    setCurrentTime: (time: number) => store.setCurrentTime(time),
    forceNotifyCurrentTime: () => store.forceNotifyCurrentTime(),
    setDuration: (duration: number) => store.setDuration(duration),
    setPlaybackRate: (rate: number) => store.setPlaybackRate(rate),
    setIsPlaying: (playing: boolean) => store.setIsPlaying(playing),
    setVolume: (volume: number) => store.setVolume(volume),
    setBuffered: (buffered: number) => store.setBuffered(buffered),
    setError: (error: string) => store.setError(error),
    setLoading: (loading: boolean) => store.setLoading(loading),
    reset: () => store.reset()
  }), [])

  return [state, actions]
}

export function usePlayerTime(): number {
  const store = useContext(PlayerStoreContext)
  if (!store) {
    throw new Error('usePlayerTime must be used within PlayerStoreProvider')
  }

  const [time, setTime] = useState(store.getState().currentTime)

  useEffect(() => {
    const unsubscribe = store.subscribe((state) => {
      setTime(state.currentTime)
    })
    return unsubscribe
  }, [store])

  return time
}

export function usePlayerState(): PlayerStoreState {
  const store = useContext(PlayerStoreContext)
  if (!store) {
    throw new Error('usePlayerState must be used within PlayerStoreProvider')
  }

  const [state, setState] = useState<PlayerStoreState>(store.getState())

  useEffect(() => {
    const unsubscribe = store.subscribe(setState)
    return unsubscribe
  }, [store])

  return state
}