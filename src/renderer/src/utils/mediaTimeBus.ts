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

/**
 * HTML5 路径视频时间平滑（纯函数，便于单测）。
 *
 * 背景：<video>.currentTime 只在媒体帧被呈现时才跳变（24fps ≈ 41.7ms 一跳、30fps ≈ 33.3ms 一跳、
 * 60fps ≈ 16.7ms 一跳），而 rAF 恒为约 16.7ms 一帧。若弹幕位移直接取自原始 currentTime，
 * 24/30fps 片源下会出现"每 2~3 帧才前进一次"的阶梯推进 —— 肉眼即规律性一顿一顿（掉帧感）。
 *
 * 策略：以最后一次原始采样为锚点，用 wall-clock 差值 × 播放倍速线性外推；
 * 一旦原始采样前进（新帧呈现）或回退（seek）立刻重新锚定，保证与视频时间轴不失同步。
 *
 * 约束：
 * - 非播放态（暂停/结束）不外推，与视频冻结行为一致；
 * - 外推量封顶 maxExtrapolationMs（默认 80ms，约两个 24fps 帧间隔），采样长时间停滞时不无限超前；
 * - 封顶后锚点同步前移，输出时间停在封顶值而非持续增长。
 */
export function extrapolateVideoTime(params: {
  rawTime: number
  nowMs: number
  anchorTime: number
  anchorAtMs: number
  playbackRate: number
  isPlaying: boolean
  maxExtrapolationMs?: number
}): { time: number; anchorTime: number; anchorAtMs: number } {
  const { rawTime, nowMs, isPlaying } = params
  const maxMs = params.maxExtrapolationMs ?? 80
  // 非播放态，或采样值相对锚点发生变化（新帧呈现 / seek 回退）→ 重新锚定，不做任何平滑滤波
  if (!isPlaying || rawTime !== params.anchorTime) {
    return { time: rawTime, anchorTime: rawTime, anchorAtMs: nowMs }
  }
  const elapsedMs = Math.max(0, Math.min(nowMs - params.anchorAtMs, maxMs))
  const rate = Number.isFinite(params.playbackRate) && params.playbackRate > 0 ? params.playbackRate : 1
  return {
    time: params.anchorTime + (elapsedMs / 1000) * rate,
    anchorTime: params.anchorTime,
    anchorAtMs: nowMs - elapsedMs
  }
}

export class MediaTimeBus {
  private videoElement: HTMLVideoElement | null = null
  private observers: Set<TimeObserver> = new Set()
  // 性能优化：RAF 观察者集合，每帧调用，不经过 React state
  private rafObservers: Set<RAFObserver> = new Set()
  private animationFrameId: number | null = null
  private isSeeking: boolean = false

  // 普通 observer 通知节流：最近一次 notify 时间戳（ms）。
  // 时间推进通知降至约 5~10Hz（100~200ms 间隔），高频（逐帧）通道只保留 subscribeRAF。
  private lastNotifyTime = 0
  private readonly notifyThrottleMs = 150

  // 手动时钟模式（mpv 引擎）：不绑定 <video>，由外部事件同步锚点，
  // RAF 循环按 wall-clock + 播放速率外推，保证弹幕动画平滑
  private manualMode: boolean = false
  private manualWallTime: number = 0

  // HTML5 模式视频时间锚点：video.currentTime 只在媒体帧呈现时跳变（24fps ≈ 41.7ms 一跳），
  // 直接用原始值驱动弹幕位移会呈现规律性一顿一顿；这里记录最后一次采样值与采样时刻，
  // 在两次采样之间用 wall-clock 外推平滑（见 extrapolateVideoTime）
  private videoAnchorTime = 0
  private videoAnchorAtMs = 0

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
    this.state.buffered = video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0
    // 平滑外推锚点：以 attach 时刻的采样为起点，避免首帧误用上一个 video 的陈旧锚点
    this.videoAnchorTime = this.state.currentTime
    this.videoAnchorAtMs = performance.now()
    this.setupVideoListeners()
    // P1-2: attach 前已播放 / 已有 currentTime 的 video 立即自举，不等到下一个 rAF/事件：
    // - isPlaying 自举：play 事件在 attach 之前已触发过，若不回填 true 则 RAF 永不启动、进度停滞
    // - 已播放则立即启动 RAF 循环推进时间；否则显式停住（等价 detach 后状态）
    // - notify 立即推送当前 currentTime，避免进度显示从 0/旧值跳变
    this.state.isPlaying = !video.paused && !video.ended
    if (this.state.isPlaying) this.start()
    else this.stop()
    this.notify()
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

  /**
   * 立即通知所有普通 observer（事件驱动 / attach 自举 / 手动 sync 使用）。
   * 调用即刷新节流窗口，避免紧随的 loop 首帧重复通知同值。
   */
  private notify(): void {
    this.lastNotifyTime = performance.now()
    this.observers.forEach((observer) => {
      observer(this.state.currentTime, { ...this.state })
    })
  }

  /** loop 内节流通知：距上次 notify 超过阈值才通知普通 observer（约 5~10Hz）；RAF observer 不受限 */
  private notifyThrottled(): void {
    const now = performance.now()
    if (now - this.lastNotifyTime >= this.notifyThrottleMs) {
      this.lastNotifyTime = now
      this.notify()
    }
  }

  // 只设置 RAF 调度，下一帧才进入 loop：attach/事件驱动的立即通知唯一来自 notify()，
  // 避免 start() 同步执行 loop 首帧导致 bootstrap 值在极端时序下重复普通通知
  private start(): void {
    if (this.animationFrameId !== null) return
    this.animationFrameId = requestAnimationFrame(this.loop)
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
      // 普通观察者（UI 更新）节流：约 5~10Hz，避免每帧 notify 推高渲染
      this.notifyThrottled()

      this.animationFrameId = requestAnimationFrame(this.loop)
      return
    }

    if (!this.videoElement || this.isSeeking) {
      this.animationFrameId = requestAnimationFrame(this.loop)
      return
    }

    const video = this.videoElement
    const rawTime = video.currentTime
    this.state.currentTime = rawTime
    this.state.playbackRate = video.playbackRate || 1

    if (video.buffered.length > 0) {
      this.state.buffered = video.buffered.end(video.buffered.length - 1)
    }

    // 弹幕/逐帧动画用平滑时间：原始 currentTime 是媒体帧粒度的阶梯
    //（24fps ≈ 41.7ms 一跳），直接驱动位移会呈现规律性一顿一顿。
    // 普通观察者（UI 进度）继续使用原始精确值，仅 RAF 通道做 wall-clock 外推。
    const smoothed = extrapolateVideoTime({
      rawTime,
      nowMs: performance.now(),
      anchorTime: this.videoAnchorTime,
      anchorAtMs: this.videoAnchorAtMs,
      playbackRate: this.state.playbackRate,
      isPlaying: this.state.isPlaying
    })
    this.videoAnchorTime = smoothed.anchorTime
    this.videoAnchorAtMs = smoothed.anchorAtMs

    // 每帧调用 RAF 观察者（弹幕引擎需要平滑更新，不经过 React state）
    this.rafObservers.forEach((observer) => {
      observer(smoothed.time, this.state.playbackRate)
    })

    // 常规观察者（UI 更新）节流：约 5~10Hz，避免每帧 notify 推高渲染
    this.notifyThrottled()

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
