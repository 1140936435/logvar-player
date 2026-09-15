import type { EngineMode } from './types'

/**
 * 引擎选择纯函数（从 usePlaybackEngine 提取，便于单测）：
 * 显式偏好 > 默认。默认在 libmpv 画布引擎可用时优先，其次打孔 mpv，最后 HTML5；
 * 任一环节不可用自动降级。pref='html5' 时无条件尊重用户偏好，即使 mpv/canvas 可用也不抢跑。
 */
export function resolveEngineMode(
  pref: string | undefined,
  mpvAvail: boolean,
  canvasAvail: boolean
): EngineMode {
  if (pref === 'html5') return 'html5'
  if (pref === 'mpv-canvas') {
    return canvasAvail ? 'mpv-canvas' : mpvAvail ? 'mpv' : 'html5'
  }
  if (pref === 'mpv') {
    return mpvAvail ? 'mpv' : canvasAvail ? 'mpv-canvas' : 'html5'
  }
  return canvasAvail ? 'mpv-canvas' : mpvAvail ? 'mpv' : 'html5'
}
