import { useCallback, useEffect, useRef, useState } from 'react'
import type { DanmakuComment, DanmakuSearchResult, DanmakuSearchResponse, JellyfinItem, DanmakuMatchMeta, DanmakuMatchCandidate } from '../../../../shared/types'
import { DanmakuEngine } from '../../utils/danmakuEngine'
import { danmakuRequestManager } from '../../utils/danmakuRequestManager'
import { extractSeriesNameFromFilename } from '../../player'

/**
 * 弹幕层（从 pages/Player.tsx 拆出）：
 * - DanmakuEngine 初始化与持久化设置加载
 * - 弹幕加载 effect（V2 多级匹配 / 本地文件 / 延迟触发）
 * - 搜索 / 候选绑定 / 本地 XML / 开关与设置变更 handlers
 * 弹幕渲染走 canvas + RAF（由 usePlaybackEngine 的 timeBus RAF 订阅驱动），不带动 React 重绘。
 */
export function usePlayerDanmaku(options: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  itemId: string
  itemName: string
  localFile: string
  baseUrl: string
  seriesName: string
  seriesId: string
  seasonId: string
  episodeList: JellyfinItem[]
  currentEpisodeIndex: number
  episodeFetchDone: boolean
  showStatus: (msg: string) => void
  closeAllPopups: () => void
}) {
  const {
    canvasRef, itemId, itemName, localFile, baseUrl, seriesName, seriesId, seasonId,
    episodeList, currentEpisodeIndex, episodeFetchDone, showStatus, closeAllPopups
  } = options

  const [danmakuEnabled, setDanmakuEnabled] = useState(true)
  // R-S2: ref 镜像，时间总线 effect 内读 ref，避免开关弹幕销毁重建整条 timeBus
  const danmakuEnabledRef = useRef(danmakuEnabled)
  danmakuEnabledRef.current = danmakuEnabled
  const [danmakuLoading, setDanmakuLoading] = useState(false)
  const [currentDanmakuCount, setCurrentDanmakuCount] = useState(0)
  const [danmakuCountVisible, setDanmakuCountVisible] = useState(false)
  const [danmakuError, setDanmakuError] = useState('')
  // 弹幕热力图：存储当前集弹幕数据（与 loadComments 同步设置，切集时清空）
  const [danmakuComments, setDanmakuComments] = useState<DanmakuComment[]>([])
  // V2 多级匹配：低置信度/失败时展示候选列表供手动绑定
  const [matchCandidates, setMatchCandidates] = useState<DanmakuMatchCandidate[]>([])
  const [matchLogs, setMatchLogs] = useState<string[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<DanmakuSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [danmakuOpacity, setDanmakuOpacity] = useState(1.0)
  const [danmakuFontSize, setDanmakuFontSize] = useState(24)
  const [danmakuSpeed, setDanmakuSpeed] = useState(120)
  const [danmakuMaxCount, setDanmakuMaxCount] = useState(300)
  const [danmakuOffset, setDanmakuOffset] = useState(0)
  const danmakuOffsetRef = useRef(0)

  // 弹幕显示区域边界（百分比，0-100）
  const [danmakuTopBoundary, setDanmakuTopBoundary] = useState(0)
  const [danmakuBottomBoundary, setDanmakuBottomBoundary] = useState(100)

  const engineRef = useRef<DanmakuEngine | null>(null)

  // M4: itemId 镜像 ref —— 手动选择弹幕（ignoreEpoch）在 await 返回后用它判断
  // 是否已切集，防止旧集选择结果污染新集
  const itemIdRef = useRef(itemId)
  itemIdRef.current = itemId

  // 弹幕引擎初始化：canvas 挂载后创建，加载持久化设置，监听窗口 resize
  useEffect(() => {
    if (!canvasRef.current) return
    engineRef.current = new DanmakuEngine(canvasRef.current)
    engineRef.current.resize()

    const loadSettings = async (): Promise<void> => {
      try {
        const enabled = await window.api.store.get('danmakuEnabled')
        if (enabled !== null) setDanmakuEnabled(!!enabled)
        const opacityRaw = await window.api.store.get('danmakuOpacity')
        if (opacityRaw !== null) { const v = Number(opacityRaw); setDanmakuOpacity(v); engineRef.current?.setOpacity(v) }
        const fontSize = await window.api.store.get('danmakuFontSize')
        if (fontSize !== null) { setDanmakuFontSize(Number(fontSize)); engineRef.current?.setFontSize(Number(fontSize)) }
        let speed = await window.api.store.get('danmakuSpeed')
        if (speed === null) {
          const legacySpeed = await window.api.store.get('danmakuScrollSpeed')
          if (legacySpeed === 'slow') speed = 90
          else if (legacySpeed === 'fast') speed = 180
          else if (legacySpeed === 'medium') speed = 120
        }
        if (speed !== null) { setDanmakuSpeed(Number(speed)); engineRef.current?.setSpeed(Number(speed)) }
        const maxCount = await window.api.store.get('danmakuMaxCount')
        if (maxCount !== null) { setDanmakuMaxCount(Number(maxCount)); engineRef.current?.setMaxActiveComments(Number(maxCount)) }
        const offset = await window.api.store.get('danmakuOffset')
        if (offset !== null) { const v = Number(offset); setDanmakuOffset(v); danmakuOffsetRef.current = v; engineRef.current?.setTimeOffset(v) }
        // 修复 TS-4: 闭包 bug - 使用局部变量暂存加载的边界值，避免引用过期的 React state
        // 修复前：setBoundary(v, danmakuBottomBoundary) 中 danmakuBottomBoundary 是闭包中的过期值（默认100）
        let loadedTop = danmakuTopBoundary
        let loadedBottom = danmakuBottomBoundary
        const savedTopBoundary = await window.api.store.get('danmakuTopBoundary')
        if (savedTopBoundary !== null) { loadedTop = Number(savedTopBoundary); setDanmakuTopBoundary(loadedTop) }
        const savedBottomBoundary = await window.api.store.get('danmakuBottomBoundary')
        if (savedBottomBoundary !== null) { loadedBottom = Number(savedBottomBoundary); setDanmakuBottomBoundary(loadedBottom) }
        // 两个值都加载完成后统一调用一次 setBoundary，确保参数正确
        engineRef.current?.setBoundary(loadedTop, loadedBottom)
      } catch (err) {
        // 修复 ARCH-2: 补全错误日志，避免吞掉配置加载失败问题
        console.error('[Player:loadSettings] 配置加载失败:', err instanceof Error ? err.message : String(err))
      }
    }
    void loadSettings()

    const handleResize = (): void => engineRef.current?.resize()
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      engineRef.current?.destroy()
      // L5: destroy 后置 null，防止 StrictMode 双挂载时旧实例被误用
      engineRef.current = null
    }
  // 修复点 1.4: 禁止把 useRef.current 放进 useEffect 依赖数组（mutable，不会触发重渲染，只会造成每次渲染都重新初始化）
  }, [canvasRef])

  // 弹幕加载 effect：剧集元数据就绪后延迟触发（本地文件 100ms / 服务器 500ms）
  useEffect(() => {
    if (!localFile && !seriesName && (!itemName || itemName === '未知视频')) return

    // 修复串集：剧集列表未加载完（currentEpisodeIndex=-1）时延迟加载，等元数据就绪
    // 否则 meta 缺失 IndexNumber/ParentIndexNumber，cacheKey 退化成 S0E0 命中错误缓存
    // 修复 R-S3/M5: 仅以 episodeFetchDone 为准（fetchEpisodes 中 setEpisodeList/
    // setCurrentEpisodeIndex/setEpisodeFetchDone 同一同步块批量提交，不存在中间态），
    // 避免 episodeList 先提交而 fetchDone 未提交时首集双重加载弹幕
    if (!localFile && !episodeFetchDone) return

    // 切集强制销毁上一集弹幕状态：cancel 挂起请求 + 清空引擎 + 清候选
    danmakuRequestManager.cancel()
    engineRef.current?.clear()
    setCurrentDanmakuCount(0)
    setDanmakuLoading(true)
    setDanmakuError('')
    setMatchCandidates([])
    setMatchLogs([])
    setDanmakuComments([])

    // ===== 构建结构化元数据（V2 多级匹配核心） =====
    const currentEp: JellyfinItem | null = (currentEpisodeIndex >= 0 && episodeList[currentEpisodeIndex]) ? episodeList[currentEpisodeIndex] : null
    const meta: DanmakuMatchMeta = {
      mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
      itemId,
      seriesId: seriesId || (currentEp?.SeriesId as string | undefined) || undefined,
      seasonId: seasonId || (currentEp?.SeasonId as string | undefined) || undefined,
      seriesName: seriesName || (currentEp?.SeriesName as string | undefined) || undefined,
      seasonName: currentEp?.SeasonName,
      indexNumber: currentEp?.IndexNumber,
      parentIndexNumber: currentEp?.ParentIndexNumber,
      productionYear: currentEp?.ProductionYear,
      fileName: localFile ? (localFile.split(/[/\\]/).pop() || localFile) : (currentEp?.Name || itemName),
      filePath: localFile || undefined,
      title: itemName
    }

    const loadDanmaku = async (): Promise<void> => {
      const log = (msg: string) => {
        console.log(`[Player:danmakuEffect] ${msg}`)
        window.api.log?.send?.('info', 'renderer', `[Player:danmakuEffect] ${msg}`)
      }
      try {
        const result = await danmakuRequestManager.loadDanmaku(meta, localFile || undefined)
        if (result === null) return // 已取消（切集），不更新 UI
        if (result.logs && result.logs.length) setMatchLogs(result.logs)
        if (result.ok && result.comments) {
          engineRef.current?.loadComments(result.comments)
          setDanmakuComments(result.comments)
          setCurrentDanmakuCount(result.count ?? 0)
          if ((result.count ?? 0) > 0) {
            setDanmakuCountVisible(true)
            setTimeout(() => setDanmakuCountVisible(false), 3000)
            // 低置信度但已加载：附带候选供用户确认修正
            if (result.candidates && result.candidates.length) {
              setMatchCandidates(result.candidates)
              setDanmakuError(`已加载弹幕（置信度较低），可点击候选修正`)
            }
          } else {
            setDanmakuError('该集暂无弹幕，可尝试手动搜索')
          }
        } else {
          // 未命中精准资源
          if (result.candidates && result.candidates.length) {
            setMatchCandidates(result.candidates)
            setDanmakuError('自动匹配置信度低，请从候选列表选择正确弹幕')
          } else {
            setDanmakuError('未找到匹配弹幕，可尝试手动搜索')
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[Player:danmakuEffect] ❌ 弹幕加载异常:`, err)
        setDanmakuError('弹幕加载失败，请手动搜索')
      } finally {
        setDanmakuLoading(false)
      }
    }

    const delayMs = localFile ? 100 : 500
    const timer = setTimeout(() => { void loadDanmaku() }, delayMs)
    return () => {
      clearTimeout(timer)
      danmakuRequestManager.cancel()
    }
  }, [itemId, itemName, localFile, seriesName, currentEpisodeIndex, episodeList, episodeFetchDone, baseUrl, seriesId, seasonId])

  const handleDanmakuToggle = (): void => {
    const next = !danmakuEnabled; setDanmakuEnabled(next)
    window.api.store.set('danmakuEnabled', next)
    next ? engineRef.current?.enable() : engineRef.current?.disable()
  }

  const handleOpacityChange = (value: number): void => { setDanmakuOpacity(value); engineRef.current?.setOpacity(value); window.api.store.set('danmakuOpacity', value) }
  const handleFontSizeChange = (value: number): void => { setDanmakuFontSize(value); engineRef.current?.setFontSize(value); window.api.store.set('danmakuFontSize', value) }
  const handleSpeedChange = (value: number): void => { setDanmakuSpeed(value); engineRef.current?.setSpeed(value); window.api.store.set('danmakuSpeed', value) }

  const handleDensityChange = (value: number): void => {
    setDanmakuMaxCount(value)
    engineRef.current?.setMaxActiveComments(value)
    window.api.store.set('danmakuMaxCount', value)
  }

  const handleOffsetChange = (value: number): void => {
    setDanmakuOffset(value)
    danmakuOffsetRef.current = value
    engineRef.current?.setTimeOffset(value)
    window.api.store.set('danmakuOffset', value)
  }

  const handleTopBoundaryChange = (value: number): void => {
    setDanmakuTopBoundary(value)
    engineRef.current?.setBoundary(value, danmakuBottomBoundary)
    window.api.store.set('danmakuTopBoundary', value)
  }

  const handleBottomBoundaryChange = (value: number): void => {
    setDanmakuBottomBoundary(value)
    engineRef.current?.setBoundary(danmakuTopBoundary, value)
    window.api.store.set('danmakuBottomBoundary', value)
  }

  const handleDanmakuSearch = async (keyword?: string): Promise<void> => {
    const kw = (typeof keyword === 'string' ? keyword : searchKeyword).trim()
    if (!kw) return
    setSearchLoading(true); setSearchResults([])
    try {
      const result = await danmakuRequestManager.search(kw)
      if (result.success && result.data) {
        const data = result.data as DanmakuSearchResponse
        const eps: DanmakuSearchResult[] = []
        for (const anime of (data.animes || [])) {
          for (const ep of (anime.episodes || [])) {
            eps.push({ ...ep, animeTitle: anime.animeTitle, source: ep.source || 'dandanplay' })
          }
        }
        setSearchResults(eps)
        if (eps.length === 0) {
          setDanmakuError('未找到匹配弹幕，可尝试其他关键词')
        }
      } else {
        const errMsg = result.error || '搜索失败'
        setDanmakuError(errMsg.includes('App-ID') ? errMsg : '搜索弹幕失败')
        showStatus(errMsg.includes('App-ID') ? '请在设置中配置弹幕 API 认证' : '搜索弹幕失败')
      }
    } catch { showStatus('搜索弹幕失败') }
    setSearchLoading(false)
  }

  // 打开弹幕搜索并自动填入影片名
  const handleOpenDanmakuSearch = (): void => {
    const searchTitle = seriesName || (localFile ? extractSeriesNameFromFilename(localFile.split(/[/\\]/).pop() || itemName) || itemName : itemName)
    setSearchKeyword(searchTitle)
    closeAllPopups()
    setSearchOpen(true)
    void handleDanmakuSearch(searchTitle)
  }

  const handleDanmakuSelect = async (ep: DanmakuSearchResult): Promise<void> => {
    closeAllPopups(); setSearchResults([]); setDanmakuLoading(true); setDanmakuError('')
    // M4: 快照当前 itemId，await 返回后比对 —— 已切集则丢弃，防串集
    const contextItemId = itemIdRef.current
    try {
      // ignoreEpoch: 用户手动选择的结果不允许被无关 cancel() 静默丢弃
      const result = await danmakuRequestManager.getComments(String(ep.episodeId), ep.source, false, undefined, true)
      if (itemIdRef.current !== contextItemId) {
        console.log(`[Player:handleDanmakuSelect] 已切换视频，丢弃过期选择结果`)
        return
      }
      if (result) {
        engineRef.current?.loadComments(result.comments); setDanmakuComments(result.comments); setCurrentDanmakuCount(result.count); setDanmakuCountVisible(true); setTimeout(() => setDanmakuCountVisible(false), 3000)
        // 手动搜索选择 → 持久化绑定，下次播放该集直接复用精准ID（走 manual 层）
        await danmakuRequestManager.bindEpisode({
          mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
          itemId,
          episodeId: ep.episodeId,
          animeTitle: ep.animeTitle,
          episodeTitle: ep.episodeTitle,
          source: ep.source || 'dandanplay'
        }, {
          mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
          itemId,
          seriesName,
          indexNumber: episodeList[currentEpisodeIndex]?.IndexNumber,
          parentIndexNumber: episodeList[currentEpisodeIndex]?.ParentIndexNumber,
          filePath: localFile
        }).catch(() => {})
      } else { setDanmakuError('获取弹幕失败') }
    } catch { setDanmakuError('获取弹幕失败') }
    finally { setDanmakuLoading(false) }
  }

  // V2: 从候选列表手动选择弹幕源 → 持久化绑定 + 立即加载（下次该集走 manual 层精准命中）
  const handleSelectCandidate = async (c: DanmakuMatchCandidate): Promise<void> => {
    setDanmakuLoading(true); setDanmakuError(''); setMatchCandidates([])
    try {
      // 1. 持久化绑定（manual 层，下次直接复用）+ 清除该集匹配缓存
      await danmakuRequestManager.bindEpisode({
        mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
        itemId,
        episodeId: c.episodeId,
        animeId: c.animeId,
        animeTitle: c.animeTitle,
        episodeTitle: c.episodeTitle,
        source: c.source
      }, {
        mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
        itemId,
        seriesName,
        indexNumber: episodeList[currentEpisodeIndex]?.IndexNumber,
        parentIndexNumber: episodeList[currentEpisodeIndex]?.ParentIndexNumber,
        filePath: localFile
      })
      // 2. 立即加载该弹幕源
      const result = await danmakuRequestManager.loadByBind(
        {
          mediaSourceId: localFile ? 'local' : (baseUrl || 'jellyfin'),
          itemId,
          seriesName, indexNumber: episodeList[currentEpisodeIndex]?.IndexNumber,
          parentIndexNumber: episodeList[currentEpisodeIndex]?.ParentIndexNumber,
          filePath: localFile
        },
        c.episodeId,
        c.source
      )
      if (result && result.ok && result.comments) {
        engineRef.current?.loadComments(result.comments)
        setDanmakuComments(result.comments)
        setCurrentDanmakuCount(result.count ?? 0)
        setDanmakuCountVisible(true)
        setTimeout(() => setDanmakuCountVisible(false), 3000)
        showStatus(`已绑定弹幕源: ${c.animeTitle} - ${c.episodeTitle}`)
      } else {
        setDanmakuError('获取弹幕失败，请重试或选择其他候选')
      }
    } catch (err) {
      console.error(`[Player:handleSelectCandidate] 异常:`, err)
      setDanmakuError('绑定弹幕失败')
    }
    setDanmakuLoading(false)
  }

  const handleLoadLocalXml = async (): Promise<void> => {
    if (!localFile) { showStatus('仅本地文件支持加载 XML 弹幕'); return }
    closeAllPopups(); setDanmakuLoading(true); setDanmakuError('')
    try {
      const xmlResult = await window.api.danmaku.findLocalXml(localFile)
      if (xmlResult.success && xmlResult.data) {
        const data = xmlResult.data as { count: number; comments: DanmakuComment[]; source?: string }
        engineRef.current?.loadComments(data.comments); setDanmakuComments(data.comments); setCurrentDanmakuCount(data.count); setDanmakuCountVisible(true); setTimeout(() => setDanmakuCountVisible(false), 3000); showStatus(`已加载本地弹幕: ${data.source || ''}`)
      } else {
        setDanmakuError(xmlResult.error || '未找到本地弹幕 XML')
      }
    } catch (err) {
      console.error(`[Player:handleLoadLocalXml] 本地 XML 加载异常:`, err)
      setDanmakuError(`本地 XML 加载失败: ${String(err)}`)
    }
    setDanmakuLoading(false)
  }

  return {
    danmakuEnabled, setDanmakuEnabled,
    danmakuEnabledRef,
    danmakuLoading,
    currentDanmakuCount, setCurrentDanmakuCount,
    danmakuCountVisible, setDanmakuCountVisible,
    danmakuError, setDanmakuError,
    danmakuComments,
    matchCandidates, setMatchCandidates,
    matchLogs,
    searchOpen, setSearchOpen,
    searchKeyword, setSearchKeyword,
    searchResults, setSearchResults,
    searchLoading,
    settingsOpen, setSettingsOpen,
    danmakuOpacity, setDanmakuOpacity,
    danmakuFontSize, setDanmakuFontSize,
    danmakuSpeed, setDanmakuSpeed,
    danmakuMaxCount, setDanmakuMaxCount,
    danmakuOffset, setDanmakuOffset,
    danmakuOffsetRef,
    danmakuTopBoundary, setDanmakuTopBoundary,
    danmakuBottomBoundary, setDanmakuBottomBoundary,
    engineRef,
    itemIdRef,
    handleDanmakuToggle,
    handleOpacityChange,
    handleFontSizeChange,
    handleSpeedChange,
    handleDensityChange,
    handleOffsetChange,
    handleTopBoundaryChange,
    handleBottomBoundaryChange,
    handleDanmakuSearch,
    handleOpenDanmakuSearch,
    handleDanmakuSelect,
    handleSelectCandidate,
    handleLoadLocalXml
  }
}
