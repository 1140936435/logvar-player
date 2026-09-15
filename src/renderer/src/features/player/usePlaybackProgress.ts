import { useCallback, useEffect, useRef } from 'react'
import { usePlayerStore, usePlayerStoreRaw } from '../../utils/playerStore'

/**
 * 播放进度与基础状态（从 pages/Player.tsx 拆出）：
 * - 按字段订阅 store（shallow）：currentTime 高频更新不触发本组件/PlayerPage 重渲染，
 *   currentTime 仅经 ref 镜像供播放历史保存使用；低频字段（duration/isPlaying/volume 等）变化才重渲染
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

  // 低频控制字段订阅（浅比较）：200ms 的 currentTime 通知不会命中这些字段变化 → PlayerPage 不重渲染
  const [playerState, playerActions] = usePlayerStore(
    (s) => ({
      duration: s.duration,
      playbackRate: s.playbackRate,
      isPlaying: s.isPlaying,
      volume: s.volume,
      buffered: s.buffered,
      loading: s.loading,
      error: s.error
    }),
    true
  )
  const { duration, playbackRate, isPlaying, volume, buffered, loading, error } = playerState

  // currentTime 只写 ref 不驱动 React 渲染：供播放历史定时保存读取最新进度
  const store = usePlayerStoreRaw()
  const currentTimeRef = useRef(store.getState().currentTime)
  useEffect(() => store.subscribe((state) => { currentTimeRef.current = state.currentTime }), [store])

  const volumeRef = useRef(100)
  const playbackRateRef = useRef(1)
  volumeRef.current = volume
  playbackRateRef.current = playbackRate
  const preMuteVolumeRef = useRef(100)

  const savePlayHistory = useCallback(async () => {
    if (!itemId && !localFile) return
    if (duration <= 0) return
    const t = currentTimeRef.current
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
    currentTimeRef, duration, playbackRate, isPlaying, volume, buffered, loading, error,
    volumeRef, playbackRateRef, preMuteVolumeRef, playerActions
  }
}
