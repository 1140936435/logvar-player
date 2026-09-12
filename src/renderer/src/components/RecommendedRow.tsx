/**
 * 智能推荐横向滚动栏组件
 * 支持：懒加载、分页、右键菜单（不感兴趣）、推荐理由展示
 */

import { useRef, useState, memo, useCallback, type ReactElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Sparkles, ChevronLeft, ChevronRight, Film, TvMinimal,
  Loader2, ThumbsDown, X, Heart, Star
} from 'lucide-react'
import type { RecommendationItem } from '../../../shared/types'
import { LazyImage } from './LazyImage'
import { getPosterUrl as buildPosterUrl } from '../utils/posterUrl'

interface RecommendedRowProps {
  items: RecommendationItem[]
  hasMore: boolean
  isLoading: boolean
  isColdStart: boolean
  /** 服务器 ID：serverId 格式协议 URL（精确匹配服务器，无 host 冲突） */
  serverId?: string
  serverType: 'jellyfin' | 'emby'
  connectedServer?: string
  onItemClick: (item: RecommendationItem) => void
  onLoadMore: () => void
  onAddDislike: (item: RecommendationItem, reason: string) => void
  onRefresh: () => void
}

// 推荐原因标签映射
const REASON_LABELS: Record<string, string> = {
  '新入库影片': '最新',
  '偏好题材': '同题材',
  '偏好导演': '同导演',
  '偏好演员': '同演员',
  '已观看': '已观看'
}

// 单张推荐卡片（玻璃态设计）
const RecommendationCard = memo(function RecommendationCard({
  item,
  posterUrl,
  onClick,
  onDislike,
  index
}: {
  item: RecommendationItem
  posterUrl: string | null
  onClick: () => void
  onDislike: (reason: string) => void
  index: number
}): ReactElement {
  const [showMenu, setShowMenu] = useState(false)
  const [isLiked, setIsLiked] = useState(false)

  const isMovie = item.type === 'Movie'
  const typeLabel = isMovie ? '电影' : '剧集'

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setShowMenu(true)
  }, [])

  const handleCloseMenu = useCallback(() => {
    setShowMenu(false)
  }, [])

  const handleDislike = useCallback((reason: string) => {
    onDislike(reason)
    setShowMenu(false)
  }, [onDislike])

  const fallbackIcon = (
    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[var(--bg-elevated)] to-[var(--bg-hover)]">
      {isMovie ? (
        <Film size={28} className="text-[var(--text-quaternary)]" />
      ) : (
        <TvMinimal size={28} className="text-[var(--text-quaternary)]" />
      )}
    </div>
  )

  // 显示推荐原因（取第一个非"已观看"的原因）
  const displayReason = item.reasons.find(r => r !== '已观看')

  return (
    <motion.div
      className="flex-shrink-0 group relative w-[160px] sm:w-[180px] lg:w-[200px]"
      whileHover={{ y: -6 }}
      whileTap={{ scale: 0.97 }}
      transition={{ 
        type: 'spring', 
        stiffness: 400, 
        damping: 25, 
        delay: Math.min(index * 0.04, 0.3) 
      }}
      style={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onContextMenu={handleContextMenu}
    >
      {/* 海报容器 - 玻璃态 */}
      <div className="aspect-[2/3] rounded-2xl overflow-hidden relative bg-[var(--bg-elevated)] border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.2)] group-hover:shadow-[0_16px_48px_rgba(0,0,0,0.35)] transition-shadow duration-300 backdrop-blur-xl">
        {/* 海报图片 */}
        <LazyImage
          src={posterUrl}
          alt={item.name}
          className="w-full h-full relative"
          fallback={fallbackIcon}
        />

        {/* 玻璃态覆盖层 */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent pointer-events-none" />

        {/* Hover 播放界面 */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 backdrop-blur-[3px]">
          <motion.div
            className="w-14 h-14 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/40 shadow-lg"
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white" className="ml-1">
              <polygon points="6,3 20,12 6,21" />
            </svg>
          </motion.div>
        </div>

        {/* 类型标签 */}
        <div className="absolute top-2 left-2">
          <div className={`px-2 py-0.5 rounded-md text-[10px] font-medium backdrop-blur-md border ${
            isMovie 
              ? 'bg-blue-500/20 text-blue-300 border-blue-400/30' 
              : 'bg-purple-500/20 text-purple-300 border-purple-400/30'
          }`}>
            {typeLabel}
          </div>
        </div>

        {/* 推荐标签 */}
        {displayReason && (
          <div className="absolute top-2 right-2">
            <div className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-gradient-to-r from-yellow-500/30 to-orange-500/30 text-yellow-200 border border-yellow-400/30 backdrop-blur-md flex items-center gap-1">
              <Sparkles size={10} />
              {displayReason}
            </div>
          </div>
        )}

        {/* 评分 */}
        {item.score > 0 && (
          <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-1 rounded-lg bg-black/50 backdrop-blur-md">
            <Star size={12} className="text-yellow-400" />
            <span className="text-[11px] font-medium text-yellow-200">
              {(item.score * 10).toFixed(1)}
            </span>
          </div>
        )}

        {/* 不感兴趣按钮（hover显示） */}
        <button
          className="absolute bottom-2 right-2 w-8 h-8 rounded-full bg-black/50 backdrop-blur-md border border-white/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/50 hover:border-red-400/50"
          onClick={(e) => {
            e.stopPropagation()
            onDislike('不感兴趣')
          }}
          title="不感兴趣"
        >
          <ThumbsDown size={14} className="text-white" />
        </button>

        {/* 右键菜单 */}
        <AnimatePresence>
          {showMenu && (
            <>
              <motion.div
                className="fixed inset-0 z-50"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={handleCloseMenu}
              />
              <motion.div
                className="absolute right-2 bottom-12 z-50 min-w-[140px] rounded-xl overflow-hidden border border-white/15 bg-[var(--bg-popover)] backdrop-blur-xl shadow-2xl"
                initial={{ opacity: 0, scale: 0.9, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 10 }}
                transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              >
                <div className="p-2">
                  <div className="px-3 py-1.5 text-[11px] text-[var(--text-tertiary)]">
                    减少推荐此类内容
                  </div>
                  {item.genres?.slice(0, 3).map((genre) => (
                    <button
                      key={genre}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                      onClick={() => handleDislike(`genre:${genre}`)}
                    >
                      <ThumbsDown size={14} className="text-[var(--text-quaternary)]" />
                      不喜欢「{genre}」
                    </button>
                  ))}
                  <div className="my-1 border-t border-white/10" />
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    onClick={() => handleDislike('item')}
                  >
                    <X size={14} className="text-red-400" />
                    不再推荐此影片
                  </button>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* 标题 */}
      <div className="mt-2 px-1">
        <h3 className="text-[13px] font-medium text-[var(--text-primary)] truncate leading-tight">
          {item.name}
        </h3>
        {item.productionYear && (
          <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
            {item.productionYear}
          </p>
        )}
      </div>
    </motion.div>
  )
})

// 主组件
export function RecommendedRow({
  items,
  hasMore,
  isLoading,
  isColdStart,
  serverId,
  serverType,
  connectedServer,
  onItemClick,
  onLoadMore,
  onAddDislike,
  onRefresh
}: RecommendedRowProps): ReactElement | null {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showLeftArrow, setShowLeftArrow] = useState(false)
  const [showRightArrow, setShowRightArrow] = useState(true)

  const baseUrl = connectedServer || 'http://localhost:8096'

  const updateArrowVisibility = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current
    setShowLeftArrow(scrollLeft > 10)
    setShowRightArrow(scrollLeft < scrollWidth - clientWidth - 10)
  }, [])

  const scroll = useCallback((direction: 'left' | 'right') => {
    if (!scrollRef.current) return
    const scrollAmount = 400
    scrollRef.current.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth'
    })
  }, [])

  const getPosterForItem = useCallback((item: RecommendationItem): string | null => {
    if (!item.posterUrl) return null
    return buildPosterUrl({
      serverId,
      baseUrl,
      serverType,
      itemId: item.itemId,
      imageTag: item.posterUrl,
      maxHeight: 400
    })
  }, [serverId, serverType, baseUrl])

  if (isLoading && items.length === 0) {
    return (
      <section className="mb-12">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles size={16} className="text-[var(--accent)]" />
          <h2 className="section-title">智能推荐</h2>
        </div>
        <div className="flex items-center justify-center py-12 gap-3">
          <Loader2 size={18} className="text-[var(--accent)] animate-spin" />
          <span className="text-[13px] text-[var(--text-tertiary)]">
            {isColdStart ? '正在为您准备最新入库...' : '正在分析您的观影偏好...'}
          </span>
        </div>
      </section>
    )
  }

  if (items.length === 0) {
    return null
  }

  return (
    <section className="mb-12">
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-title flex items-center gap-2">
          <div className="relative">
            <Sparkles size={16} className="text-[var(--accent)]" />
            <motion.div
              className="absolute inset-0 text-[var(--accent)]"
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              <Sparkles size={16} />
            </motion.div>
          </div>
          {isColdStart ? '最新入库' : '为您推荐'}
          {!isColdStart && items.length > 0 && (
            <span className="text-[12px] font-normal text-[var(--text-tertiary)] ml-1">
              ({items.length}+)
            </span>
          )}
        </h2>
        
        <button
          onClick={onRefresh}
          className="text-[12px] text-[var(--accent)] hover:text-[var(--accent-light)] transition-colors flex items-center gap-1 px-3 py-1 rounded-full hover:bg-[var(--bg-hover)]"
          title="刷新推荐"
        >
          <svg 
            width="12" 
            height="12" 
            viewBox="0 0 24 24" 
            fill="none" 
            stroke="currentColor" 
            strokeWidth="2" 
            strokeLinecap="round" 
            strokeLinejoin="round"
            className={isLoading ? 'animate-spin' : ''}
          >
            <path d="M21 2v6h-6" />
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M3 22v-6h6" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
          刷新
        </button>
      </div>

      {/* 滚动容器 */}
      <div className="relative group">
        {/* 左箭头 */}
        <AnimatePresence>
          {showLeftArrow && (
            <motion.button
              className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center border border-white/10 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
              onClick={() => scroll('left')}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <ChevronLeft size={20} className="text-white" />
            </motion.button>
          )}
        </AnimatePresence>

        {/* 项目列表 */}
        <div
          ref={scrollRef}
          className="flex gap-4 overflow-x-auto pb-4 -mx-2 px-2 scroll-smooth scrollbar-hide"
          onScroll={updateArrowVisibility}
        >
          {items.map((item, index) => (
            <RecommendationCard
              key={item.itemId}
              item={item}
              posterUrl={getPosterForItem(item)}
              onClick={() => onItemClick(item)}
              onDislike={(reason) => onAddDislike(item, reason)}
              index={index}
            />
          ))}

          {/* 加载更多 / 分页指示 */}
          {hasMore && (
            <motion.div
              className="flex-shrink-0 w-[120px] flex items-center justify-center"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <button
                className="w-24 h-32 rounded-2xl border-2 border-dashed border-white/20 bg-white/5 backdrop-blur-md flex flex-col items-center justify-center gap-2 text-[var(--text-tertiary)] hover:bg-white/10 hover:border-[var(--accent)]/50 hover:text-[var(--accent)] transition-colors"
                onClick={onLoadMore}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 size={20} className="animate-spin" />
                ) : (
                  <>
                    <ChevronRight size={20} />
                    <span className="text-[12px]">加载更多</span>
                  </>
                )}
              </button>
            </motion.div>
          )}
        </div>

        {/* 右箭头 */}
        <AnimatePresence>
          {showRightArrow && (
            <motion.button
              className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center border border-white/10 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
              onClick={() => scroll('right')}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
            >
              <ChevronRight size={20} className="text-white" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* 提示文字 */}
      {!isColdStart && items.length > 0 && (
        <p className="text-[11px] text-[var(--text-quaternary)] mt-2 flex items-center gap-1">
          <Sparkles size={10} />
          根据您的观影历史智能推荐 · 右键卡片可调整偏好
        </p>
      )}
    </section>
  )
}
