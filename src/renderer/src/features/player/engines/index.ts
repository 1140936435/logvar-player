import type { EngineMode, PlaybackEngine } from './types'
import { Html5PlaybackEngine } from './html5'
import { MpvNativePlaybackEngine, type MpvNativeDeps } from './mpv-native'
import { MpvCanvasPlaybackEngine, type MpvCanvasDeps } from './mpv-canvas'

export type { EngineMode, MediaSource, SubtitleTrackMeta, PlaybackEngine, PlaybackEvent, PlaybackEventHandler } from './types'
export { Html5PlaybackEngine } from './html5'
export { MpvNativePlaybackEngine } from './mpv-native'
export { MpvCanvasPlaybackEngine } from './mpv-canvas'

export interface EngineDeps extends MpvNativeDeps, MpvCanvasDeps {
  videoRef: React.RefObject<HTMLVideoElement | null>
}

/**
 * 引擎工厂：按已选定的 engineMode 创建统一 PlaybackEngine 实现。
 * usePlaybackEngine 只持有接口，不再感知各引擎实现细节。
 */
export function createPlaybackEngine(mode: EngineMode, deps: EngineDeps): PlaybackEngine {
  switch (mode) {
    case 'mpv':
      return new MpvNativePlaybackEngine(deps)
    case 'mpv-canvas':
      return new MpvCanvasPlaybackEngine(deps)
    case 'html5':
    default:
      return new Html5PlaybackEngine(deps.videoRef)
  }
}
