import { useCallback, useEffect, useRef } from 'react'
import { usePlayerStore } from '../../utils/playerStore'

/**
 * 播放进度与基础状态（从 pages/Player.tsx 拆出）：
 * - 直接暴露 store 节流后的播放状态（约 200ms 更新一次，timeupdate 不带动整页重绘）
 * - 音量/倍速 ref 镜像（startPlayback / 控制分发读取最新值，不重建回调）
 * - 播放历史定时保存（30s 周期 + 卸载兜底）
 */
export function usePlaybackProgress(options: {
  itemId: string
  localFile: string
  itemName: string
  baseUrl: string
  seriesName: string
}) {
  const { itemId, localFile, itemName, baseUrl, seriesName } = options

  const [playerState, playerActions] = usePlayerStore()
  const { currentTime, duration, playbackRate, isPlaying, volume, buffered, loading, error } = playerState

  const volumeRef = useRef(100)
  const playbackRateRef = useRef(1)
  volumeRef.current = volume
  playbackRateRef.current = playbackRate
  const preMuteVolumeRef = useRef(100)

  // 用 ref 持有最新播放进度，避免 savePlayHistory 随 currentTime 变化而重建，
  // 否则 30s 周期保存的 interval 会每 ~200ms 被销毁/重建，退化为高频写盘
  const playHistoryTimeRef = useRef(currentTime)
  playHistoryTimeRef.current = currentTime

  const savePlayHistory = useCallback(async () => {
    if (!itemId && !localFile) return
    if (duration <= 0) return
    const t = playHistoryTimeRef.current
    if (t < 5) return
    try {
      // 海报 URL 由主进程按服务器配置派生（协议链接，不含凭据），Renderer 只传 itemId + baseUrl
      const historyName = seriesName && !itemName.startsWith(seriesName)
        ? `${seriesName} - ${itemName}` : itemName
      await window.api.history.save({
        itemId: itemId || `local:${localFile}`,
        name: historyName, duration, position: t,
        watchedAt: Date.now(), localFile: localFile || undefined,
        baseUrl: localFile ? undefined : baseUrl,
        seriesName: seriesName || undefined
      })
    } catch (err) { console.error('保存播放历史失败:', err) }
  }, [itemId, localFile, itemName, duration, baseUrl, seriesName])

  useEffect(() => {
    if (duration <= 0) return
    const interval = setInterval(savePlayHistory, 30000)
    return () => {
      clearInterval(interval)
      savePlayHistory()
    }
  }, [savePlayHistory])

  return {
    currentTime, duration, playbackRate, isPlaying, volume, buffered, loading, error,
    volumeRef, playbackRateRef, preMuteVolumeRef, playerActions
  }
}
