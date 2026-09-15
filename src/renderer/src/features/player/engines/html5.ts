import type { MediaSource, PlaybackEngine, PlaybackEvent, PlaybackEventHandler } from './types'

/**
 * Html5PlaybackEngine：内置 <video> 引擎。
 * 事件归一化：DOM 事件 + rAF 帧时钟 → 统一 PlaybackEvent。
 * - 'frame' 每帧发射（弹幕引擎 / 竖屏模糊背景消费）
 * - 'time' 节流发射（约 5Hz，驱动 store 节流更新，不带动整页重绘）
 *
 * 修复点：
 * - 不缓存 null ref：constructor 时 ref 未挂载也合法，load() 时再解析真实 DOM ref 并延迟绑定事件/rAF
 * - setVolume 按 DOM 0~100 语义 clamp（写 volume=1.0 上限），杜绝 150 → 1.5 越界
 * - muted 时归一化 volume 事件恒为 0（volumechange 与 toggleMute 双路对齐）
 * - load() 后自动 play（浏览器手势策略由 play() 内部 catch 忽略拒绝）
 */
export class Html5PlaybackEngine implements PlaybackEngine {
  private readonly listeners = new Set<PlaybackEventHandler>()
  private rafId = 0
  private disposed = false
  private lastTimeEmit = 0
  private frameCount = 0
  /** 已绑定事件/rAF 的真实 <video> 元素（ref 挂载后第一次访问时绑定） */
  private boundVideo: HTMLVideoElement | null = null

  constructor(private readonly videoRef: React.RefObject<HTMLVideoElement | null>) {
    const video = this.videoRef.current
    if (video) this.bind(video)
  }

  /** 解析当前真实 <video>；首次访问且未绑定时补绑定（ref 延迟挂载场景） */
  private getVideo(): HTMLVideoElement | null {
    if (this.disposed) return null
    const video = this.videoRef.current
    if (video && this.boundVideo !== video) this.bind(video)
    return video
  }

  private bind(video: HTMLVideoElement): void {
    if (this.boundVideo === video) return
    this.boundVideo = video
    video.addEventListener('loadedmetadata', this.onLoadedMetadata)
    video.addEventListener('waiting', this.onWaiting)
    video.addEventListener('canplay', this.onCanPlay)
    video.addEventListener('error', this.onError)
    video.addEventListener('volumechange', this.onVolumeChange)
    video.addEventListener('ratechange', this.onRateChange)
    video.addEventListener('play', this.onPlay)
    video.addEventListener('pause', this.onPause)
    video.addEventListener('seeked', this.onSeeked)
    this.rafId = requestAnimationFrame(this.onFrame)
  }

  async load(source: MediaSource): Promise<void> {
    if (this.disposed) return
    const video = this.getVideo()
    if (!video) return
    const oldTracks = video.querySelectorAll('track')
    oldTracks.forEach(t => t.remove())
    video.src = source.url
    video.load()
    // HTML5 引擎 loaded 后自播放（原 Player 行为）：浏览器 autoplay 策略拒绝时静默忽略
    void this.play()
  }

  async play(): Promise<void> {
    try {
      await this.getVideo()?.play()
    } catch { /* 用户手势外的 play 拒绝，忽略 */ }
  }

  async pause(): Promise<void> {
    this.getVideo()?.pause()
  }

  async seek(seconds: number): Promise<void> {
    const video = this.getVideo()
    if (video) video.currentTime = Math.max(0, seconds)
  }

  async setVolume(volume: number): Promise<void> {
    const video = this.getVideo()
    if (!video) return
    // DOM <video> 音量语义为 0~100（volume 属性 0~1），与 mpv 的 150 上限不同，此处 clamp 到 100
    const v = Math.max(0, Math.min(100, Math.round(volume)))
    video.volume = v / 100
    video.muted = v === 0
  }

  async setSpeed(speed: number): Promise<void> {
    const video = this.getVideo()
    if (video) video.playbackRate = speed
  }

  /** 静音切换：muted 变化触发 volumechange → 归一化 volume 事件回 UI */
  toggleMute(): void {
    const video = this.getVideo()
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
    const video = this.boundVideo
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
    this.boundVideo = null
    this.listeners.clear()
  }

  private emit(event: PlaybackEvent): void {
    if (this.disposed) return
    this.listeners.forEach(cb => { try { cb(event) } catch { /* 单个监听器异常不中断 */ } })
  }

  private onFrame = (): void => {
    if (this.disposed) return
    const video = this.getVideo()
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
    const video = this.getVideo()
    if (!video) return
    this.emit({ type: 'duration', duration: video.duration || 0 })
    this.emit({ type: 'loaded', active: false })
  }

  private onWaiting = (): void => this.emit({ type: 'waiting' })
  private onCanPlay = (): void => this.emit({ type: 'canplay' })
  private onPlay = (): void => this.emit({ type: 'play' })
  private onPause = (): void => this.emit({ type: 'pause' })

  private onSeeked = (): void => {
    const video = this.getVideo()
    if (video) this.emit({ type: 'seeked', currentTime: video.currentTime || 0 })
  }

  private onVolumeChange = (): void => {
    const video = this.getVideo()
    if (video) this.emit({ type: 'volume', volume: video.muted ? 0 : Math.round(video.volume * 100) })
  }

  private onRateChange = (): void => {
    const video = this.getVideo()
    if (video) this.emit({ type: 'speed', speed: video.playbackRate })
  }

  private onError = (): void => {
    const video = this.getVideo()
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
