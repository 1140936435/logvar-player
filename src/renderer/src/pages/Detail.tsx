import { useParams, useNavigate, Link } from 'react-router-dom'
import { useState, useEffect, useCallback, type ReactElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft, Play, Loader2, Star, Clock, Film, Tv,
  ChevronRight, Users, Info, ExternalLink
} from 'lucide-react'

/* ==================== 类型 ==================== */

interface PersonInfo {
  Name: string
  Id?: string
  Role?: string
  Type?: string
  ImageTags?: { Primary?: string }
  PrimaryImageTag?: string
}

interface EpisodeInfo {
  Id: string
  Name: string
  IndexNumber?: number
  ParentIndexNumber?: number
  Overview?: string
  CommunityRating?: number
  ImageTags?: { Primary?: string }
  MediaSources?: unknown[]
}

interface SeasonInfo {
  Id: string
  Name: string
  IndexNumber?: number
  ChildCount?: number
}

interface DetailData {
  Id: string
  Name: string
  OriginalTitle?: string
  Type: string
  ProductionYear?: number
  Overview?: string
  Genres?: string[]
  People?: PersonInfo[]
  CommunityRating?: number
  VoteCount?: number
  OfficialRating?: string
  RunTimeTicks?: number
  ImageTags?: { Primary?: string; Backdrop?: string }
  CollectionType?: string
  ChildCount?: number
  // Series specific
  Seasons?: SeasonInfo[]
  // Episode specific
  SeriesName?: string
  SeriesId?: string
  IndexNumber?: number
  ParentIndexNumber?: number
}



/* ==================== 工具函数 ==================== */

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}小时${m}分钟`
  return `${m}分钟`
}

function formatDuration(ticks?: number): string {
  if (!ticks) return '-'
  return formatTime(Number(ticks) / 10000000)
}



/* ==================== Detail 主组件 ==================== */

function Detail(): ReactElement {
  const { itemId } = useParams<{ itemId: string }>()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<DetailData | null>(null)
  // 剧集相关
  const [seasons, setSeasons] = useState<SeasonInfo[]>([])
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([])
  const [selectedSeason, setSelectedSeason] = useState<string>('')
  const [episodesLoading, setEpisodesLoading] = useState(false)
  const [expandedEpisode, setExpandedEpisode] = useState<string | null>(null)

  const [baseUrl, setBaseUrl] = useState('http://localhost:8096')

  // 加载详情
  useEffect(() => {
    if (!itemId) return
    setLoading(true)
    setError('')

    // 先读取服务器地址
    window.api.store.get('jellyfin').then((saved: any) => {
      if (saved?.url) setBaseUrl(saved.url.replace(/\/+$/, ''))
    }).catch(() => {})

    window.api.jellyfin.getItemDetails(itemId).then((result) => {
      if (result.success && result.data) {
        const data = result.data as DetailData
        setDetail(data)
        setLoading(false)

        // 如果是剧集类型，加载季列表
        if (data.Type === 'Series' || data.CollectionType === 'tvshows') {
          loadSeasons(data.Id)
        }
      } else {
        setError(result.error || '获取详情失败')
        setLoading(false)
      }
    }).catch((err) => {
      setError(String(err))
      setLoading(false)
    })
  }, [itemId])

  // 加载季列表
  const loadSeasons = useCallback(async (seriesId: string) => {
    try {
      const result = await window.api.jellyfin.getEpisodes(seriesId)
      if (result.success && result.data) {
        const data = result.data as { seasons?: SeasonInfo[]; episodes?: EpisodeInfo[] }
        if (data.seasons && data.seasons.length > 0) {
          setSeasons(data.seasons)
          // 选中第一个季
          const firstSeasonId = data.seasons[0].Id
          setSelectedSeason(firstSeasonId)
          loadEpisodes(seriesId, firstSeasonId)
        } else if (data.episodes) {
          // 没有 Season 结构，直接展示所有集
          setEpisodes(data.episodes)
        }
      }
    } catch (err) {
      console.error('loadSeasons failed:', err)
    }
  }, [])

  // 加载剧集列表
  const loadEpisodes = useCallback(async (seriesId: string, seasonId: string) => {
    setEpisodesLoading(true)
    try {
      const result = await window.api.jellyfin.getEpisodes(seriesId, seasonId)
      if (result.success && result.data) {
        const data = result.data as { Items?: EpisodeInfo[] }
        setEpisodes(data.Items || [])
      }
    } catch (err) {
      console.error('loadEpisodes failed:', err)
    }
    setEpisodesLoading(false)
  }, [])

  // 切换季
  const handleSeasonChange = (seasonId: string): void => {
    setSelectedSeason(seasonId)
    if (detail?.Id) {
      loadEpisodes(detail.Id, seasonId)
    }
  }

  // 播放
  const handlePlay = (epId?: string, epName?: string): void => {
    window.api.store.get('jellyfin').then((saved: any) => {
      const serverUrl = saved?.url || baseUrl
      // 如果是电视剧且没有指定集数，用已加载的第一集 ID
      let targetId = epId || ''
      let targetName = epName || detail?.Name || '未知视频'
      if (!targetId && isSeries && episodes.length > 0) {
        targetId = episodes[0].Id
        targetName = `EP${String(episodes[0].IndexNumber || 1).padStart(2, '0')} - ${episodes[0].Name}`
      }
      if (!targetId) {
        targetId = itemId || ''
      }
      const seriesName = detail?.SeriesName || detail?.Name || ''
      navigate(`/player?itemId=${encodeURIComponent(targetId)}&name=${encodeURIComponent(targetName)}&base=${encodeURIComponent(serverUrl)}&seriesName=${encodeURIComponent(seriesName)}`)
    })
  }

  const getPosterUrl = (): string | null => {
    if (!detail?.ImageTags?.Primary || !itemId) return null
    return `${baseUrl}/Items/${itemId}/Images/Primary?maxHeight=600&tag=${detail.ImageTags.Primary}&quality=90`
  }

  const getBackdropUrl = (): string | null => {
    if (!detail?.ImageTags?.Backdrop || !itemId) return null
    return `${baseUrl}/Items/${itemId}/Images/Backdrop?maxHeight=800&tag=${detail.ImageTags.Backdrop}&quality=85`
  }

  const getPersonAvatar = (person: PersonInfo): string | null => {
    const tag = person.ImageTags?.Primary || person.PrimaryImageTag
    if (person.Id) {
      return tag
        ? `${baseUrl}/Items/${person.Id}/Images/Primary?maxHeight=100&tag=${tag}`
        : `${baseUrl}/Items/${person.Id}/Images/Primary?maxHeight=100`
    }
    return tag
      ? `${baseUrl}/Persons/${encodeURIComponent(person.Name)}/Images/Primary?maxHeight=100&tag=${tag}`
      : `${baseUrl}/Persons/${encodeURIComponent(person.Name)}/Images/Primary?maxHeight=100`
  }

  const getEpisodeThumbUrl = (ep: EpisodeInfo): string | null => {
    if (!ep.ImageTags?.Primary) return null
    return `${baseUrl}/Items/${ep.Id}/Images/Primary?maxHeight=200&tag=${ep.ImageTags.Primary}&quality=85`
  }

  const isSeries = detail?.Type === 'Series' || detail?.CollectionType === 'tvshows'
  const isMovie = detail?.Type === 'Movie'

  // ==================== 加载状态 ====================

  if (loading) {
    return (
      <div className="w-full flex justify-center">
        <div className="max-w-4xl px-6 py-20 w-full flex items-center justify-center">
          <Loader2 size={24} className="text-[var(--accent)] animate-spin" />
          <span className="text-[15px] text-[var(--text-tertiary)] ml-3">加载中...</span>
        </div>
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div className="w-full flex justify-center">
        <div className="max-w-4xl px-6 py-20 w-full text-center">
          <p className="text-[15px] text-[var(--text-tertiary)] mb-4">{error || '未找到内容'}</p>
          <Link to="/" className="ios-btn ios-btn-primary no-underline">
            <ArrowLeft size={15} />
            返回媒体库
          </Link>
        </div>
      </div>
    )
  }

  // ==================== 主渲染 ====================

  const posterUrl = getPosterUrl()
  const backdropUrl = getBackdropUrl()
  const actors = (detail.People || []).filter(p => p.Type === 'Actor').slice(0, 12)
  const directors = (detail.People || []).filter(p => p.Type === 'Director')
  const genres = detail.Genres || []

  return (
    <div className="w-full flex justify-center">
      <div className="max-w-5xl px-4 sm:px-6 py-6 w-full">

        {/* 返回按钮 */}
        <motion.div
          className="mb-6"
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
        >
          <Link to="/" className="flex items-center gap-1.5 text-[13px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors no-underline ios-btn ios-btn-ghost !px-2 !h-8">
            <ArrowLeft size={14} />
            返回
          </Link>
        </motion.div>

        {/* 顶部：海报 + 信息 */}
        <motion.div
          className="flex flex-col sm:flex-row gap-5 sm:gap-7 mb-10"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          {/* 海报 */}
          <div className="shrink-0 w-full sm:w-auto">
            <div className="w-[200px] sm:w-[200px] lg:w-[220px] mx-auto sm:mx-0">
              <div className="aspect-[2/3] rounded-[var(--radius-xl)] overflow-hidden bg-[var(--bg-elevated)] border border-[var(--separator)] shadow-lg">
                {posterUrl ? (
                  <img
                    src={posterUrl}
                    alt={detail.Name}
                    className="w-full h-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    {isSeries ? <Tv size={40} className="text-[var(--text-quaternary)]" /> : <Film size={40} className="text-[var(--text-quaternary)]" />}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 信息区域 */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* 标题 */}
            <h1 className="text-[24px] font-bold text-[var(--text-primary)] leading-tight mb-1 truncate">
              {detail.Name}
            </h1>
            {detail.OriginalTitle && detail.OriginalTitle !== detail.Name && (
              <p className="text-[14px] text-[var(--text-tertiary)] mb-3 truncate">{detail.OriginalTitle}</p>
            )}

            {/* 元信息行 */}
            <div className="flex items-center flex-wrap gap-2 mb-4">
              {detail.ProductionYear && (
                <span className="text-[13px] text-[var(--text-secondary)]">{detail.ProductionYear}</span>
              )}
              {genres.length > 0 && (
                <>
                  <span className="text-[var(--text-quaternary)]">·</span>
                  <span className="text-[13px] text-[var(--text-secondary)]">{genres.join(' / ')}</span>
                </>
              )}
              {isMovie && (
                <>
                  <span className="text-[var(--text-quaternary)]">·</span>
                  <span className="text-[13px] text-[var(--text-secondary)] flex items-center gap-1">
                    <Clock size={12} />
                    {formatDuration(detail.RunTimeTicks)}
                  </span>
                </>
              )}
              {isSeries && detail.ChildCount != null && (
                <>
                  <span className="text-[var(--text-quaternary)]">·</span>
                  <span className="text-[13px] text-[var(--text-secondary)]">{detail.ChildCount} 集</span>
                </>
              )}
            </div>

            {/* 评分区域 */}
            <div className="flex items-center gap-4 mb-5">
              {/* 社区评分 */}
              {detail.CommunityRating != null && detail.CommunityRating > 0 && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-bg)]">
                  <Star size={14} className="text-[var(--accent)]" fill="var(--accent)" />
                  <span className="text-[14px] font-semibold text-[var(--accent)]">{detail.CommunityRating.toFixed(1)}</span>
                  {detail.VoteCount != null && (
                    <span className="text-[11px] text-[var(--text-tertiary)] ml-0.5">({detail.VoteCount})</span>
                  )}
                </div>
              )}

              {detail.OfficialRating && (
                <span className="text-[11px] text-[var(--text-tertiary)] px-2 py-0.5 rounded border border-[var(--separator)]">
                  {detail.OfficialRating}
                </span>
              )}
            </div>

            {/* 操作按钮 */}
            <div className="flex items-center gap-3 mb-5">
              <motion.button
                onClick={() => handlePlay()}
                className="ios-btn ios-btn-primary !h-10 !px-6 !text-[14px] !font-semibold"
                whileTap={{ scale: 0.96 }}
              >
                <Play size={16} fill="currentColor" className="mr-1" />
                {isSeries ? '播放 S01E01' : '播放'}
              </motion.button>
            </div>

            {/* 简介 */}
            {detail.Overview && (
              <div className="mb-4">
                <h3 className="text-[13px] font-semibold text-[var(--text-primary)] mb-2 flex items-center gap-1.5">
                  <Info size={13} className="text-[var(--accent)]" />
                  简介
                </h3>
                <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed whitespace-pre-line">
                  {detail.Overview}
                </p>
              </div>
            )}
          </div>
        </motion.div>

        {/* 演员 */}
        {actors.length > 0 && (
          <motion.section
            className="mb-10"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-1.5">
              <Users size={14} className="text-[var(--accent)]" />
              演员
            </h3>
            <div className="flex gap-4 overflow-x-auto pb-2 -mx-2 px-2">
              {actors.map((person, idx) => (
                <div key={idx} className="flex-shrink-0 w-[80px] text-center">
                  <div className="w-[72px] h-[72px] mx-auto rounded-full overflow-hidden bg-[var(--bg-elevated)] border border-[var(--separator)] mb-2">
                    {getPersonAvatar(person) ? (
                      <img
                        src={getPersonAvatar(person)!}
                        alt={person.Name}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[var(--text-quaternary)] text-[20px] font-medium">
                        {person.Name.charAt(0)}
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] text-[var(--text-primary)] font-medium truncate" title={person.Name}>{person.Name}</p>
                  {person.Role && (
                    <p className="text-[10px] text-[var(--text-tertiary)] truncate mt-0.5" title={person.Role}>{person.Role}</p>
                  )}
                </div>
              ))}
            </div>
          </motion.section>
        )}

        {/* 导演 */}
        {directors.length > 0 && (
          <motion.section
            className="mb-10"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)] mb-3">导演</h3>
            <div className="flex gap-2 flex-wrap">
              {directors.map((d, idx) => (
                <span key={idx} className="text-[13px] text-[var(--text-secondary)] px-3 py-1 rounded-[var(--radius-md)] bg-[var(--bg-elevated)] border border-[var(--separator)]">
                  {d.Name}
                </span>
              ))}
            </div>
          </motion.section>
        )}

        {/* 剧集列表 */}
        {isSeries && (
          <motion.section
            className="mb-10"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-1.5">
              <Tv size={14} className="text-[var(--accent)]" />
              剧集
            </h3>

            {/* 季选择器 */}
            {seasons.length > 1 && (
              <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
                {seasons.map((season) => (
                  <motion.button
                    key={season.Id}
                    onClick={() => handleSeasonChange(season.Id)}
                    className={`flex-shrink-0 px-4 py-2 rounded-[var(--radius-md)] text-[13px] font-medium transition-all ${
                      selectedSeason === season.Id
                        ? 'bg-[var(--accent)] text-white shadow-sm'
                        : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-[var(--separator)] hover:bg-[var(--bg-hover)]'
                    }`}
                    whileTap={{ scale: 0.96 }}
                  >
                    {season.Name}
                    {season.ChildCount != null && (
                      <span className="ml-1.5 opacity-60">({season.ChildCount})</span>
                    )}
                  </motion.button>
                ))}
              </div>
            )}

            {/* 剧集列表 */}
            {episodesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={18} className="text-[var(--accent)] animate-spin" />
              </div>
            ) : episodes.length === 0 ? (
              <p className="text-[13px] text-[var(--text-quaternary)] py-8 text-center">暂无剧集</p>
            ) : (
              <div className="space-y-2">
                {episodes.map((ep) => (
                  <motion.div
                    key={ep.Id}
                    className={`rounded-[var(--radius-lg)] border transition-all cursor-pointer ${
                      expandedEpisode === ep.Id
                        ? 'bg-[var(--accent-bg)]/50 border-[var(--accent)]/30'
                        : 'bg-[var(--bg-elevated)] border-[var(--separator)] hover:bg-[var(--bg-hover)]'
                    }`}
                    onClick={() => setExpandedEpisode(expandedEpisode === ep.Id ? null : ep.Id)}
                    whileTap={{ scale: 0.99 }}
                  >
                    <div className="flex items-center gap-3 px-4 py-3">
                      {/* 集数缩略图 */}
                      <div className="shrink-0 w-[80px] h-[48px] rounded-[var(--radius-sm)] overflow-hidden bg-[var(--bg-input)]">
                        {getEpisodeThumbUrl(ep) ? (
                          <img
                            src={getEpisodeThumbUrl(ep)!}
                            alt={ep.Name}
                            className="w-full h-full object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[var(--text-quaternary)]">
                            <Film size={16} />
                          </div>
                        )}
                      </div>

                      {/* 集信息 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-mono text-[var(--accent)] font-semibold">
                            E{String(ep.IndexNumber || 0).padStart(2, '0')}
                          </span>
                          <span className="text-[13px] text-[var(--text-primary)] font-medium truncate">{ep.Name}</span>
                        </div>
                        {ep.CommunityRating != null && ep.CommunityRating > 0 && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <Star size={10} className="text-[var(--warning)]" fill="var(--warning)" />
                            <span className="text-[11px] text-[var(--text-tertiary)]">{ep.CommunityRating.toFixed(1)}</span>
                          </div>
                        )}
                      </div>

                      {/* 播放按钮 */}
                      <motion.button
                        onClick={(e) => {
                          e.stopPropagation()
                          handlePlay(ep.Id, `EP${String(ep.IndexNumber || 0).padStart(2, '0')} - ${ep.Name}`)
                        }}
                        className="shrink-0 w-8 h-8 rounded-full bg-[var(--accent)] flex items-center justify-center hover:brightness-110 transition-all"
                        whileTap={{ scale: 0.9 }}
                        title="播放"
                      >
                        <Play size={13} fill="white" className="text-white ml-0.5" />
                      </motion.button>
                    </div>

                    {/* 展开的简介 */}
                    <AnimatePresence>
                      {expandedEpisode === ep.Id && ep.Overview && (
                        <motion.div
                          className="px-4 pb-3 border-t border-[var(--separator)]"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                        >
                          <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed pt-3 whitespace-pre-line">
                            {ep.Overview}
                          </p>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.section>
        )}
      </div>
    </div>
  )
}

export default Detail
