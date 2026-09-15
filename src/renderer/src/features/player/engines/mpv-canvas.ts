import type { MediaSource, PlaybackEngine, PlaybackEvent, PlaybackEventHandler } from './types'
import { normalizeMpvEvent } from './mpv-events'

export interface MpvCanvasDeps {
  /** 画布引擎渲染参数：硬解 / HDR tone-mapping */
  renderOptsRef: React.MutableRefObject<{ hardwareDecode: boolean; hdrToneMapping: boolean }>
  volumeRef: React.MutableRefObject<number>
  playbackRateRef: React.MutableRefObject<number>
}

/**
 * MpvCanvasPlaybackEngine：libmpv 实例渲染到 WebGL canvas（方案 C），无窗口嵌入。
 * 事件归一化与打孔引擎共用 normalizeMpvEvent；渲染参数 / 实例回收为引擎专属细节。
 */
export class MpvCanvasPlaybackEngine implements PlaybackEngine {
  private readonly listeners = new Set<PlaybackEventHandler>()
  private readonly unsubscribeMpv: () => void
  private isLocal = false

  constructor(private readonly deps: MpvCanvasDeps) {
    this.unsubscribeMpv = window.api.mpvRender.onEvent(this.onMpvEvent)
  }

  async load(source: MediaSource): Promise<void> {
    this.isLocal = source.isLocal
    const playRes = await window.api.mpvRender.play(source.url, this.deps.renderOptsRef.current)
    if (!playRes.success) {
      throw new Error(`mpv 播放失败: ${playRes.error}`)
    }
    // 新实例默认音量 100/倍速 1.0，同步应用当前设置
    void window.api.mpvRender.setVolume(this.deps.volumeRef.current)
    void window.api.mpvRender.setSpeed(this.deps.playbackRateRef.current)
  }

  async play(): Promise<void> {
    await window.api.mpvRender.resume()
  }

  async pause(): Promise<void> {
    await window.api.mpvRender.pause()
  }

  async seek(seconds: number): Promise<void> {
    await window.api.mpvRender.seek(Math.max(0, seconds))
  }

  async setVolume(volume: number): Promise<void> {
    await window.api.mpvRender.setVolume(Math.max(0, Math.min(150, Math.round(volume))))
  }

  async setSpeed(speed: number): Promise<void> {
    await window.api.mpvRender.setSpeed(speed)
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
    void window.api.mpvRender.destroy()
  }

  private onMpvEvent = (event: string, data: unknown): void => {
    const events = normalizeMpvEvent(event, data)
    // 与打孔引擎一致：服务器字幕走应用自绘，loaded 后关闭内建字幕
    for (const evt of events) {
      if (evt.type === 'loaded' && !this.isLocal) {
        void window.api.mpvRender.disableSubtitle()
      }
      this.listeners.forEach(cb => { try { cb(evt) } catch { /* 单个监听器异常不中断 */ } })
    }
  }
}
