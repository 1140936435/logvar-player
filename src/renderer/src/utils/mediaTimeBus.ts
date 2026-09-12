type TimeObserver = (time: number, state: MediaTimeState) => void

// 性能优化：RAF 观察者每帧调用但不经过 React state，专门用于弹幕引擎等高频场景
type RAFObserver = (time: number, playbackRate: number) => void

interface MediaTimeState {
  currentTime: number
  duration: number
  playbackRate: number
  isPlaying: boolean
  buffered: number
}

export class MediaTimeBus {
  private videoElement: HTMLVideoElement | null = null
  private observers: Set<TimeObserver> = new Set()
  // 性能优化：RAF 观察者集合，每帧调用，不经过 React state
  private rafObservers: Set<RAFObserver> = new Set()
  private animationFrameId: number | null = null
  private isSeeking: boolean = false

  // 手动时钟模式（mpv 引擎）：不绑定 <video>，由外部事件同步锚点，
  // RAF 循环按 wall-clock + 播放速率外推，保证弹幕动画平滑
  private manualMode: boolean = false
  private manualWallTime: number = 0

  private state: MediaTimeState = {
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    isPlaying: false,
    buffered: 0
  }

  attachVideo(video: HTMLVideoElement): void {
    this.manualMode = false
    this.videoElement = video
    this.state.duration = video.duration || 0
    this.state.currentTime = video.currentTime || 0
    this.state.playbackRate = video.playbackRate || 1
    this.setupVideoListeners()
  }

  /** 手动模式：用于 mpv 等无 <video> 元素的播放引擎 */
  attachManual(): void {
    this.cleanupVideoListeners()
    this.videoElement = null
    this.manualMode = true
    this.state = {
      currentTime: 0,
      duration: 0,
      playbackRate: 1,
      isPlaying: false,
      buffered: 0
    }
    this.manualWallTime = performance.now()
  }

  /** 手动模式下由引擎事件（time-pos/pause/speed/duration）同步状态 */
  syncFromEngine(patch: {
    currentTime?: number
    duration?: number
    isPlaying?: boolean
    playbackRate?: number
    buffered?: number
  }): void {
    this.manualWallTime = performance.now()
    if (patch.currentTime !== undefined && Number.isFinite(patch.currentTime)) {
      this.state.currentTime = patch.currentTime
    }
    if (patch.duration !== undefined && Number.isFinite(patch.duration)) {
      this.state.duration = patch.duration
    }
    if (patch.playbackRate !== undefined && Number.isFinite(patch.playbackRate)) {
      this.state.playbackRate = patch.playbackRate
    }
    if (patch.buffered !== undefined) {
      this.state.buffered = patch.buffered
    }
    if (patch.isPlaying !== undefined) {
      this.state.isPlaying = patch.isPlaying
      // 暂停时停止 RAF 循环（弹幕冻结）；播放时恢复
      if (patch.isPlaying) this.start()
      else this.stop()
    }
    this.notify()
  }

  detachVideo(): void {
    this.cleanupVideoListeners()
    this.videoElement = null
    this.manualMode = false
    this.stop()
  }

  private setupVideoListeners(): void {
    if (!this.videoElement) return
    const video = this.videoElement
    video.addEventListener('play', this.onPlay)
    // 修复：waiting 不再绑 onPause。waiting 时 video.paused 仍为 false，
    // 若设 isPlaying=false，网络恢复后不触发 play 事件，按钮卡在暂停。
    // 卡顿的 loading 状态由 Player.tsx 的 onWaiting 单独管理。
    video.addEventListener('playing', this.onPlay)
    video.addEventListener('pause', this.onPause)
    video.addEventListener('ended', this.onPause)
    video.addEventListener('seeking', this.onSeeking)
    video.addEventListener('seeked', this.onSeeked)
    video.addEventListener('progress', this.onProgress)
    video.addEventListener('ratechange', this.onRateChange)
  }

  private cleanupVideoListeners(): void {
    if (!this.videoElement) return
    const video = this.videoElement
    video.removeEventListener('play', this.onPlay)
    video.removeEventListener('playing', this.onPlay)
    video.removeEventListener('pause', this.onPause)
    video.removeEventListener('ended', this.onPause)
    video.removeEventListener('seeking', this.onSeeking)
    video.removeEventListener('seeked', this.onSeeked)
    video.removeEventListener('progress', this.onProgress)
    video.removeEventListener('ratechange', this.onRateChange)
  }

  private onPlay = (): void => {
    this.state.isPlaying = true
    this.start()
    this.notify()
  }

  private onPause = (): void => {
    this.state.isPlaying = false
    this.stop()
    this.notify()
  }

  private onSeeking = (): void => {
    this.isSeeking = true
    this.stop()
  }

  private onSeeked = (): void => {
    this.isSeeking = false
    if (!this.videoElement) return
    this.state.currentTime = this.videoElement.currentTime
    if (!this.videoElement.paused) {
      this.state.isPlaying = true
      this.start()
    }
    this.notify()
  }

  private onProgress = (): void => {
    if (!this.videoElement) return
    const buffered = this.videoElement.buffered
    if (buffered.length > 0) {
      this.state.buffered = buffered.end(buffered.length - 1)
    }
    this.notify()
  }

  private onRateChange = (): void => {
    if (!this.videoElement) return
    this.state.playbackRate = this.videoElement.playbackRate || 1
    this.notify()
  }

  subscribe(observer: TimeObserver): () => void {
    this.observers.add(observer)
    return () => this.observers.delete(observer)
  }

  // 性能优化：RAF 订阅，每帧调用，不经过 React state，用于弹幕引擎等高频场景
  subscribeRAF(observer: RAFObserver): () => void {
    this.rafObservers.add(observer)
    return () => this.rafObservers.delete(observer)
  }

  private notify(): void {
    this.observers.forEach((observer) => {
      observer(this.state.currentTime, { ...this.state })
    })
  }

  private start(): void {
    if (this.animationFrameId !== null) return
    this.loop()
  }

  private stop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
  }

  // 性能优化：loop 中 RAF 观察者每帧调用（弹幕引擎需要平滑动画），
  // 常规观察者通过 store 层节流（约 200ms 通知一次 UI 更新）
  private loop = (): void => {
    // 手动模式（mpv）：不依赖 <video>，用 wall-clock 外推播放进度
    if (this.manualMode) {
      const now = performance.now()
      // tab 隐藏时 rAF 暂停，恢复后首帧 dt 可能达几十秒，
      // 钳制到 0.25s 防止 currentTime 单帧暴增（真实进度由 mpv time 事件重锚）
      const dt = Math.min((now - this.manualWallTime) / 1000, 0.25)
      this.manualWallTime = now
      if (this.state.isPlaying) {
        this.state.currentTime += dt * this.state.playbackRate
      }

      // 每帧调用 RAF 观察者（弹幕引擎需要平滑更新）
      this.rafObservers.forEach((observer) => {
        observer(this.state.currentTime, this.state.playbackRate)
      })
      this.notify()

      this.animationFrameId = requestAnimationFrame(this.loop)
      return
    }

    if (!this.videoElement || this.isSeeking) {
      this.animationFrameId = requestAnimationFrame(this.loop)
      return
    }

    const video = this.videoElement
    this.state.currentTime = video.currentTime
    this.state.playbackRate = video.playbackRate || 1

    if (video.buffered.length > 0) {
      this.state.buffered = video.buffered.end(video.buffered.length - 1)
    }

    // 每帧调用 RAF 观察者（弹幕引擎需要平滑更新，不经过 React state）
    this.rafObservers.forEach((observer) => {
      observer(this.state.currentTime, this.state.playbackRate)
    })

    // 常规观察者（UI 更新，由 store 层节流）
    this.notify()

    this.animationFrameId = requestAnimationFrame(this.loop)
  }

  updateDuration(duration: number): void {
    this.state.duration = duration
    this.notify()
  }

  getState(): MediaTimeState {
    return { ...this.state }
  }

  getCurrentTime(): number {
    return this.state.currentTime
  }

  getPlaybackRate(): number {
    return this.state.playbackRate
  }

  isPlaying(): boolean {
    return this.state.isPlaying
  }

  destroy(): void {
    this.stop()
    this.detachVideo()
    this.observers.clear()
    this.rafObservers.clear()
  }
}

export const createMediaTimeBus = (): MediaTimeBus => {
  return new MediaTimeBus()
}
