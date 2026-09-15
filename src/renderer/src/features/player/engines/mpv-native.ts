import type { MediaSource, PlaybackEngine, PlaybackEvent, PlaybackEventHandler } from './types'
import { normalizeMpvEvent } from './mpv-events'

export interface MpvNativeDeps {
  /** mpv 视频画面嵌入区域（替代 <video> 的可视位置） */
  slotRef: React.RefObject<HTMLDivElement | null>
  volumeRef: React.MutableRefObject<number>
  playbackRateRef: React.MutableRefObject<number>
}

/**
 * MpvNativePlaybackEngine：Win32 打孔嵌入的 mpv 引擎（旧架构）。
 * 持有嵌入几何同步、内建字幕禁用等 mpv 专属细节；
 * 事件经 normalizeMpvEvent 归一化为统一 PlaybackEvent。
 */
export class MpvNativePlaybackEngine implements PlaybackEngine {
  private readonly listeners = new Set<PlaybackEventHandler>()
  private readonly unsubscribeMpv: () => void
  private isLocal = false

  constructor(private readonly deps: MpvNativeDeps) {
    this.unsubscribeMpv = window.api.mpv.onEvent(this.onMpvEvent)
  }

  async load(source: MediaSource): Promise<void> {
    this.isLocal = source.isLocal
    const slot = this.deps.slotRef.current
    if (slot) {
      const rect = slot.getBoundingClientRect()
      const embedRes = await window.api.mpv.embed(rect.left, rect.top, rect.width, rect.height)
      if (!embedRes.success) {
        // 嵌入失败（Win32 不可用等）→ play 会以 mpv 独立窗口模式继续
        console.warn('[PlaybackEngine] mpv 嵌入失败，回退独立窗口模式:', embedRes.error)
      }
    }
    const playRes = await window.api.mpv.play(source.url)
    if (!playRes.success) {
      throw new Error(`mpv 播放失败: ${playRes.error}`)
    }
    // 新 mpv 进程默认音量 100/倍速 1.0，同步应用当前音量/倍速设置
    void window.api.mpv.setVolume(this.deps.volumeRef.current)
    void window.api.mpv.setSpeed(this.deps.playbackRateRef.current)
  }

  async play(): Promise<void> {
    await window.api.mpv.resume()
  }

  async pause(): Promise<void> {
    await window.api.mpv.pause()
  }

  async seek(seconds: number): Promise<void> {
    await window.api.mpv.seek(Math.max(0, seconds))
  }

  async setVolume(volume: number): Promise<void> {
    await window.api.mpv.setVolume(Math.max(0, Math.min(150, Math.round(volume))))
  }

  async setSpeed(speed: number): Promise<void> {
    await window.api.mpv.setSpeed(speed)
  }

  /** 音轨切换：mpv 内建控制由主进程负责，预留接口 */
  async selectAudioTrack(_id: string): Promise<void> {}

  /** 字幕轨道切换：应用使用 HTML 自绘字幕（parseVTT），引擎不消费 */
  async selectSubtitleTrack(_id: string): Promise<void> {}

  onEvent(callback: PlaybackEventHandler): () => void {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }

  async dispose(): Promise<void> {
    this.unsubscribeMpv()
    this.listeners.clear()
    void window.api.mpv.hide()
  }

  private onMpvEvent = (event: string, data: unknown): void => {
    const events = normalizeMpvEvent(event, data)
    // 服务器字幕由本应用 HTML 自绘：loaded 后关闭 mpv 内建字幕避免双字幕；
    // 本地文件保留 mpv 默认行为（外挂/内嵌 ASS 由 mpv 渲染）
    for (const evt of events) {
      if (evt.type === 'loaded' && !this.isLocal) {
        void window.api.mpv.disableSubtitle()
      }
      this.listeners.forEach(cb => { try { cb(evt) } catch { /* 单个监听器异常不中断 */ } })
    }
  }
}
