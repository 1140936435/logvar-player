import type { PlaybackEvent } from './types'

/**
 * mpv 家族（打孔嵌入 / libmpv canvas）IPC 字符串事件 → 统一 PlaybackEvent。
 * 语义对齐原 usePlaybackEngine 的 onMpvEvent 处理逻辑，保证行为不变。
 */
export function normalizeMpvEvent(event: string, data: unknown): PlaybackEvent[] {
  switch (event) {
    case 'time': {
      const t = Number(data)
      if (!Number.isFinite(t)) return []
      return [{ type: 'time', currentTime: t }]
    }
    case 'duration': {
      const d = Number(data)
      if (!Number.isFinite(d) || d <= 0) return []
      return [{ type: 'duration', duration: d }]
    }
    case 'pause':
      return data === true
        ? [{ type: 'pause' }]
        : [{ type: 'play' }]
    case 'volume': {
      const v = Math.round(Number(data))
      if (!Number.isFinite(v)) return []
      return [{ type: 'volume', volume: v }]
    }
    case 'speed': {
      const s = Number(data)
      if (!Number.isFinite(s)) return []
      return [{ type: 'speed', speed: s }]
    }
    case 'file-loaded':
      // 主进程揭示渲染窗口（打孔）或 canvas 出画；应用自绘字幕接管
      return [{ type: 'loaded', active: true }]
    case 'start':
      // 清 loading/error、置播放态（不揭示窗口，由 file-loaded 负责）
      return [{ type: 'loaded', active: false }]
    case 'stop':
    case 'idle':
      return [{ type: 'inactive' }]
    case 'error': {
      const detail = data instanceof Error
        ? data.message
        : typeof data === 'string'
          ? data
          : (data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
              ? (data as { message: string }).message
              : '')
      return [{ type: 'error', message: detail || 'mpv 播放错误，请查看日志或在设置中切换回内置播放器' }]
    }
    case 'quit':
      // mpv 进程退出：渲染窗口已销毁，立即恢复黑底防打孔透出桌面
      return [{ type: 'inactive' }]
    default:
      return []
  }
}
