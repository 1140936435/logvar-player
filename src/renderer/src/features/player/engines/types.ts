/**
 * Renderer 层 PlaybackEngine 统一接口（P1「继续完善 PlaybackEngine」）。
 * 所有引擎实现共享此契约：控制方法 + 事件订阅 + 生命周期。
 * Player 组件只面向该接口编程，不再散落 engineMode / videoRef 分支。
 */

export type EngineMode = 'html5' | 'mpv' | 'mpv-canvas'

/** 播放源描述（由视频源解析层产出，交 engine.load 消费） */
export interface MediaSource {
  url: string
  /** 是否本地文件（mpv 家族据此决定是否关闭内建字幕） */
  isLocal: boolean
  /** 服务器字幕元数据（应用 HTML 自绘，引擎不直接消费） */
  subtitles?: SubtitleTrackMeta[]
  /** mpv-canvas 渲染参数（硬解 / HDR tone-mapping） */
  renderOptions?: { hardwareDecode: boolean; hdrToneMapping: boolean }
}

export interface SubtitleTrackMeta {
  index: number
  label: string
  language: string
  codec: string
  url: string
}

/**
 * 统一播放事件。事件源差异（mpv IPC 字符串事件 / <video> DOM 事件）在
 * 各引擎内部归一化为同一结构，usePlaybackEngine 只消费这里的语义。
 */
export type PlaybackEvent =
  | { type: 'time'; currentTime: number; buffered?: number }
  | { type: 'frame'; currentTime: number; playbackRate: number }
  | { type: 'duration'; duration: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'volume'; volume: number }
  | { type: 'speed'; speed: number }
  | { type: 'loaded'; active: boolean }
  | { type: 'waiting' }
  | { type: 'canplay' }
  | { type: 'seeked'; currentTime: number }
  | { type: 'error'; message: string }
  | { type: 'inactive' }

export type PlaybackEventHandler = (event: PlaybackEvent) => void

/** 统一播放引擎契约（对齐 REFACTOR_ROADMAP.md P1「继续完善 PlaybackEngine」） */
export interface PlaybackEngine {
  load(source: MediaSource): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(seconds: number): Promise<void>
  setVolume(volume: number): Promise<void>
  setSpeed(speed: number): Promise<void>
  selectAudioTrack(id: string): Promise<void>
  selectSubtitleTrack(id: string): Promise<void>
  onEvent(callback: PlaybackEventHandler): () => void
  dispose(): Promise<void>
  /** 可选扩展：静音切换（html5 实现；mpv 家族以音量 0 表示静音，由上层处理） */
  toggleMute?(): void
}
