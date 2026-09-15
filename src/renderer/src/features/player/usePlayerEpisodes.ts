import { useEffect, useRef, useState } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { cachedFetch } from '../../utils/apiCache'
import type { PlayerStoreActions } from '../../utils/playerStore'
import type { JellyfinItem } from '../../../../shared/types'
import type { FolderVideo } from '../../player'

/**
 * 剧集列表拉取与切集行为（从 pages/Player.tsx 拆出）。
 * - 本地文件 / 电影（无 seriesId）分支与 R-S3 放行标记原样保留
 * - handleSwitchEpisode 负责 URL 重写 + videoLoadKey 递增触发重载
 */
export function usePlayerEpisodes(options: {
  itemId: string | null
  localFile: string | null
  seriesId: string | null
  seasonId: string | null
  setVideoLoadKey: React.Dispatch<React.SetStateAction<number>>
  playerActions: PlayerStoreActions
  navigate: NavigateFunction
  searchParams: URLSearchParams
}) {
  const { itemId, localFile, seriesId, seasonId, setVideoLoadKey, playerActions, navigate, searchParams } = options

  const [episodeList, setEpisodeList] = useState<JellyfinItem[]>([])
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(-1)
  const [episodePopup, setEpisodePopup] = useState(false)
  // 修复 R-S3: 标记剧集拉取是否完成（含电影/本地文件无剧集场景），
  // 否则电影（无 seriesId/episodeList）永远命中 danmaku effect 的早退条件，弹幕无法加载
  const [episodeFetchDone, setEpisodeFetchDone] = useState(false)

  // 本地文件夹视频列表
  const [folderVideos, setFolderVideos] = useState<FolderVideo[]>([])

  // 获取剧集列表（电视剧）— Jellyfin 请求由主进程持凭据发起，Renderer 无需 token
  const episodeFetchedRef = useRef(false)
  useEffect(() => {
    // 本地文件不需要剧集列表
    if (localFile) {
      setEpisodeFetchDone(true)
      return
    }
    // 已经获取过则跳过
    if (episodeFetchedRef.current) return

    const fetchEpisodes = async (): Promise<void> => {
      if (seriesId) {
        // 条件 1: seriesId 直接可用
        try {
          const result = await cachedFetch(
            'jellyfin.getEpisodes',
            [seriesId, seasonId || undefined],
            () => window.api.jellyfin.getEpisodes(seriesId, seasonId || undefined),
            2 * 60 * 1000 // 2 分钟缓存
          )
          if (result.success && result.data) {
            const data = result.data as { Items?: JellyfinItem[]; episodes?: JellyfinItem[] }
            const episodes = data.Items || data.episodes || []
            setEpisodeList(episodes)
            const idx = episodes.findIndex(ep => (ep as any).Id === itemId || (ep as any).id === itemId)
            setCurrentEpisodeIndex(idx)
          }
        } catch (err) {
          console.error('[EpisodeList] Error:', err)
        }
      } else if (itemId) {
        // 条件 2: seriesId 为空，先获取详情（电影走此分支，无 SeriesId 时不拉剧集）
        try {
          const detailResult = await cachedFetch(
            'jellyfin.getItemDetails',
            [itemId],
            () => window.api.jellyfin.getItemDetails(itemId),
            2 * 60 * 1000
          )
          if (detailResult.success && detailResult.data) {
            const data = detailResult.data as { SeriesId?: string; SeasonId?: string }
            const fetchedSeriesId = data.SeriesId
            const fetchedSeasonId = data.SeasonId || seasonId
            if (fetchedSeriesId) {
              const epResult = await cachedFetch(
                'jellyfin.getEpisodes',
                [fetchedSeriesId, fetchedSeasonId || undefined],
                () => window.api.jellyfin.getEpisodes(fetchedSeriesId, fetchedSeasonId || undefined),
                2 * 60 * 1000
              )
              if (epResult.success && epResult.data) {
                const epData = epResult.data as { Items?: JellyfinItem[]; episodes?: JellyfinItem[] }
                const episodes = epData.Items || epData.episodes || []
                setEpisodeList(episodes)
                const idx = episodes.findIndex(ep => (ep as any).Id === itemId || (ep as any).id === itemId)
                setCurrentEpisodeIndex(idx)
              }
            }
          }
        } catch (err) {
          console.error('[EpisodeList] Error:', err)
        }
      }
      // 修复 R-S3: 无论是否取到剧集（电影无剧集），拉取流程结束即放行 danmaku effect
      setEpisodeFetchDone(true)
    }

    // 剧集/详情请求均走主进程认证，直接拉取即可
    episodeFetchedRef.current = true
    void fetchEpisodes()
  }, [seriesId, seasonId, itemId, localFile])

  // 切换剧集
  const handleSwitchEpisode = (newIndex: number): void => {
    console.log('[EpisodeSwitch] handleSwitchEpisode called with newIndex=%d, episodeList.length=%d, currentEpisodeIndex=%d', newIndex, episodeList.length, currentEpisodeIndex)

    const totalEpisodes = Math.max(episodeList.length, folderVideos.length)
    if (newIndex < 0 || newIndex >= totalEpisodes) {
      console.log('[EpisodeSwitch] Index out of range, returning')
      return
    }

    const newEp = episodeList[newIndex]
    console.log('[EpisodeSwitch] newEp=%o', newEp)
    // Jellyfin API 返回的是 Id (大写)，不是 id
    const episodeId = (newEp as any).Id || (newEp as any).id
    if (!episodeId) {
      console.log('[EpisodeSwitch] episodeId is empty, returning')
      return
    }

    console.log('[EpisodeSwitch] Switching to episode %d: %s', newIndex + 1, newEp.Name || episodeId)

    // 构建新的 URL
    const newParams = new URLSearchParams(searchParams)
    newParams.set('itemId', episodeId)
    if (newEp.Name) newParams.set('name', newEp.Name)

    // 跳转到新集
    navigate({ search: newParams.toString() }, { replace: true })

    // 递增 videoLoadKey 触发 useEffect 重新加载视频（navigate replace 不会卸载组件）
    setVideoLoadKey(prev => prev + 1)

    // 重置状态
    setCurrentEpisodeIndex(newIndex)
    playerActions.setCurrentTime(0)
    playerActions.setIsPlaying(false)
    playerActions.setError('')
    playerActions.setLoading(true)
  }

  return {
    episodeList,
    setEpisodeList,
    currentEpisodeIndex,
    setCurrentEpisodeIndex,
    episodePopup,
    setEpisodePopup,
    episodeFetchDone,
    folderVideos,
    handleSwitchEpisode
  }
}
