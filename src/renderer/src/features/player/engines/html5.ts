import type { MediaSource, PlaybackEngine, PlaybackEvent, PlaybackEventHandler } from './types'

/**
 * Html5PlaybackEngine：内置 <video> 引擎。
 * 事件归一化：DOM 事件 + rAF 帧时钟 → 统一 PlaybackEvent。
 * - 'frame' 每帧发射（弹幕引擎 / 竖屏模糊背景消费）
 * - 'time' 节流发射（约 5Hz，驱动 store 节流更新，不带动整页重绘）
 */
export class Html5PlaybackEngine implements PlaybackEngine {
  private readonly video: HTMLVideoElement | null
  private readonly listeners = new Set<PlaybackEventHandler>()
  private rafId = 0
  private disposed = false
  private lastTimeEmit = 0
  private frameCount = 0

  constructor(private readonly videoRef: React.RefObject<HTMLVideoElement | null>) {
    this.video = videoRef.current
    if (!this.video) return
    this.video.addEventListener('loadedmetadata', this.onLoadedMetadata)
    this.video.addEventListener('waiting', this.onWaiting)
    this.video.addEventListener('canplay', this.onCanPlay)
    this.video.addEventListener('error', this.onError)
    this.video.addEventListener('volumechange', this.onVolumeChange)
    this.video.addEventListener('ratechange', this.onRateChange)
    this.video.addEventListener('play', this.onPlay)
    this.video.addEventListener('pause', this.onPause)
    this.video.addEventListener('seeked', this.onSeeked)
    this.rafId = requestAnimationFrame(this.onFrame)
  }

  async load(source: MediaSource): Promise<void> {
    const video = this.video
    if (!video) return
    const oldTracks = video.querySelectorAll('track')
    oldTracks.forEach(t => t.remove())
    video.src = source.url
    video.load()
  }

  async play(): Promise<void> {
    try {
      await this.video?.play()
    } catch { /* 用户手势外的 play 拒绝，忽略 */ }
  }

  async pause(): Promise<void> {
    this.video?.pause()
  }

  async seek(seconds: number): Promise<void> {
    if (this.video) this.video.currentTime = Math.max(0, seconds)
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.video) return
    const v = Math.max(0, Math.min(150, Math.round(volume)))
    this.video.volume = v / 100
    this.video.muted = v === 0
  }

  async setSpeed(speed: number): Promise<void> {
    if (this.video) this.video.playbackRate = speed
  }

  /** 静音切换：muted 变化触发 volumechange → 归一化 volume 事件回 UI */
  toggleMute(): void {
    const video = this.video
    if (!video) return
    video.muted = !video.muted
    this.emit({ type: 'volume', volume: video.muted ? 0 : Math.round(video.volume * 100) })
  }

  /** 音轨切换：<video> 无通用 audioTracks 控制，预留接口 */
  async selectAudioTrack(_id: string): Promise<void> {}

  /** 字幕轨道切换：应用使用 HTML 自绘字幕（parseVTT），引擎不消费 <track> */
  async selectSubtitleTrack(_id: string): Promise<void> {}

  onEvent(callback: PlaybackEventHandler): () => void {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    cancelAnimationFrame(this.rafId)
    const video = this.video
    if (video) {
      video.removeEventListener('loadedmetadata', this.onLoadedMetadata)
      video.removeEventListener('waiting', this.onWaiting)
      video.removeEventListener('canplay', this.onCanPlay)
      video.removeEventListener('error', this.onError)
      video.removeEventListener('volumechange', this.onVolumeChange)
      video.removeEventListener('ratechange', this.onRateChange)
      video.removeEventListener('play', this.onPlay)
      video.removeEventListener('pause', this.onPause)
      video.removeEventListener('seeked', this.onSeeked)
      video.src = ''
      video.load()
    }
    this.listeners.clear()
  }

  private emit(event: PlaybackEvent): void {
    if (this.disposed) return
    this.listeners.forEach(cb => { try { cb(event) } catch { /* 单个监听器异常不中断 */ } })
  }

  private onFrame = (): void => {
    if (this.disposed) return
    const video = this.video
    if (video) {
      const t = video.currentTime || 0
      this.frameCount++
      this.emit({ type: 'frame', currentTime: t, playbackRate: video.playbackRate || 1 })
      // 节流 time 事件（约 5Hz），store 订阅端负责写入，避免 60fps 重渲染
      const now = performance.now()
      if (now - this.lastTimeEmit >= 200) {
        this.lastTimeEmit = now
        let buffered = 0
        // 语义与 mediaTimeBus 一致：buffered 为缓冲末端秒数（非 0-1 比例）
        if (video.buffered.length > 0) {
          buffered = video.buffered.end(video.buffered.length - 1)
        }
        this.emit({ type: 'time', currentTime: t, buffered })
      }
    }
    this.rafId = requestAnimationFrame(this.onFrame)
  }

  private onLoadedMetadata = (): void => {
    const video = this.video
    if (!video) return
    this.emit({ type: 'duration', duration: video.duration || 0 })
    this.emit({ type: 'loaded', active: false })
  }

  private onWaiting = (): void => this.emit({ type: 'waiting' })
  private onCanPlay = (): void => this.emit({ type: 'canplay' })
  private onPlay = (): void => this.emit({ type: 'play' })
  private onPause = (): void => this.emit({ type: 'pause' })

  private onSeeked = (): void => {
    const video = this.video
    if (video) this.emit({ type: 'seeked', currentTime: video.currentTime || 0 })
  }

  private onVolumeChange = (): void => {
    const video = this.video
    if (video) this.emit({ type: 'volume', volume: Math.round(video.volume * 100) })
  }

  private onRateChange = (): void => {
    const video = this.video
    if (video) this.emit({ type: 'speed', speed: video.playbackRate })
  }

  private onError = (): void => {
    const video = this.video
    const message = (() => {
      switch (video?.error?.code) {
        case 1: return '视频加载中止'
        case 2: return '网络错误'
        case 3: return '视频解码失败'
        case 4: return '视频源不可用'
        default: return '视频加载失败'
      }
    })()
    this.emit({ type: 'error', message })
  }
}
