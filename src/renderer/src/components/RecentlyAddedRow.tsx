/**
 * 最近入库横向海报滚动栏组件
 * 支持鼠标拖拽、左右箭头翻页、海报懒加载
 */

import { useRef, useState, useEffect, useCallback, memo, type ReactElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronLeft, ChevronRight, Sparkles, Film, TvMinimal } from 'lucide-react'
import type { RecentlyAddedItem } from '../../../shared/types'
import { formatAddedTimeAgo } from '../utils/recentlyAdded'
import { LazyImage } from './LazyImage'
import { getPosterUrl as buildPosterUrl, getOptimalPosterHeight } from '../utils/posterUrl'

interface RecentlyAddedRowProps {
  items: RecentlyAddedItem[]
  onItemClick: (item: RecentlyAddedItem) => void
  /** 服务器 ID：serverId 格式协议 URL（精确匹配服务器，无 host 冲突） */
  serverId?: string
  baseUrl: string
  scrollSpeed?: number
  savedScrollPosition?: number
  onScrollPositionChange?: (position: number) => void
  doubanPosters?: Record<string, string>
  /** 服务器类型：'jellyfin' | 'emby'，默认 jellyfin */
  serverType?: 'jellyfin' | 'emby'
}

// 单张海报卡片（使用 LazyImage 懒加载）
const PosterCard = memo(function PosterCard({
  item,
  posterUrl,
  onClick,
  index
}: {
  item: RecentlyAddedItem
  posterUrl: string | null
  onClick: () => void
  index: number
}): ReactElement {
  const isMovie = item.type === 'Movie'
  const typeLabel = isMovie ? '电影' : '剧集'

  const fallbackIcon = (
    <div className="w-full h-full flex items-center justify-center bg-[var(--bg-elevated)]">
      {isMovie ? (
        <Film size={32} className="text-[var(--text-quaternary)]" />
      ) : (
        <TvMinimal size={32} className="text-[var(--text-quaternary)]" />
      )}
    </div>
  )

  return (
    <motion.div
      onClick={onClick}
      className="flex-shrink-0 group cursor-pointer relative w-[140px] sm:w-[160px] lg:w-[180px]"
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25, delay: Math.min(index * 0.03, 0.3) }}
      style={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <div
        className="aspect-[2/3] rounded-[var(--radius-lg)] overflow-hidden relative bg-[var(--bg-elevated)] border border-[var(--separator)] shadow-[0_4px_12px_rgba(0,0,0,0.15)] group-hover:shadow-[0_8px_24px_rgba(0,0,0,0.25)] transition-shadow duration-300"
      >
        <LazyImage
          src={posterUrl}
          alt={item.name}
          className="w-full h-full relative"
          fallback={fallbackIcon}
        />

        {/* Hover 播放图标 */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 backdrop-blur-[2px]">
          <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/30">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white" className="ml-0.5">
              <polygon points="6,3 20,12 6,21" />
            </svg>
          </div>
        </div>

        {/* 类型角标 */}
        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-[var(--accent)]/90 text-white backdrop-blur-sm z-10">
          {typeLabel}
        </div>
      </div>

      {/* 底部信息 */}
      <div className="mt-2 px-0.5">
        <p className="text-[12px] text-[var(--text-primary)] font-medium truncate" title={item.name}>
          {item.name}
        </p>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="text-[10px] text-[var(--text-tertiary)]">
            {item.productionYear || '—'}
          </span>
          <span className="text-[var(--text-quaternary)]">·</span>
          <span className="text-[10px] text-[var(--accent)]">
            {formatAddedTimeAgo(item.addedAt)}
          </span>
        </div>
      </div>
    </motion.div>
  )
})

export function RecentlyAddedRow({
  items,
  onItemClick,
  serverId,
  baseUrl,
  scrollSpeed = 1,
  savedScrollPosition = 0,
  onScrollPositionChange,
  doubanPosters = {},
  serverType = 'jellyfin'
}: RecentlyAddedRowProps): ReactElement | null {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [showLeftArrow, setShowLeftArrow] = useState(false)
  const [showRightArrow, setShowRightArrow] = useState(true)

  // 拖拽状态
  const isDragging = useRef(false)
  const startX = useRef(0)
  const scrollLeft = useRef(0)
  const velocity = useRef(0)
  const lastX = useRef(0)
  const lastTime = useRef(0)
  const animationFrame = useRef<number | null>(null)

  const getPosterUrl = useCallback((item: RecentlyAddedItem): string | null => {
    return buildPosterUrl({
      serverId,
      baseUrl,
      serverType: serverType || 'jellyfin',
      itemId: item.itemId,
      imageTag: item.imageTag,
      doubanPosterPath: doubanPosters[item.itemId],
    })
  }, [serverId, baseUrl, serverType, doubanPosters])

  // 更新箭头显示状态
  const updateArrowVisibility = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    setShowLeftArrow(container.scrollLeft > 10)
    setShowRightArrow(
      container.scrollLeft < container.scrollWidth - container.clientWidth - 10
    )
  }, [])

  // 恢复滚动位置
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || savedScrollPosition <= 0) return
    requestAnimationFrame(() => {
      if (container) {
        container.scrollLeft = savedScrollPosition
        updateArrowVisibility()
      }
    })
  }, [savedScrollPosition, updateArrowVisibility])

  // 监听滚动
  const handleScroll = useCallback(() => {
    updateArrowVisibility()
    if (onScrollPositionChange && scrollContainerRef.current) {
      onScrollPositionChange(scrollContainerRef.current.scrollLeft)
    }
  }, [updateArrowVisibility, onScrollPositionChange])

  // 鼠标按下 - 开始拖拽
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (animationFrame.current) {
      cancelAnimationFrame(animationFrame.current)
      animationFrame.current = null
    }
    isDragging.current = true
    startX.current = e.pageX - (scrollContainerRef.current?.offsetLeft || 0)
    scrollLeft.current = scrollContainerRef.current?.scrollLeft || 0
    lastX.current = e.pageX
    lastTime.current = Date.now()
    velocity.current = 0
    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.cursor = 'grabbing'
      scrollContainerRef.current.style.userSelect = 'none'
    }
  }, [])

  // 鼠标移动 - 拖拽中
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return
    const x = e.pageX - (scrollContainerRef.current?.offsetLeft || 0)
    const walk = (x - startX.current) * scrollSpeed
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollLeft = scrollLeft.current - walk
    }
    // 计算速度
    const now = Date.now()
    const dt = now - lastTime.current
    if (dt > 0) {
      velocity.current = (e.pageX - lastX.current) / dt
    }
    lastX.current = e.pageX
    lastTime.current = now
  }, [scrollSpeed])

  // 鼠标松开 - 结束拖拽
  const handleMouseUp = useCallback(() => {
    if (!isDragging.current) return
    isDragging.current = false
    if (scrollContainerRef.current) {
      scrollContainerRef.current.style.cursor = ''
      scrollContainerRef.current.style.userSelect = ''
    }
    // 惯性滚动
    const container = scrollContainerRef.current
    if (container && Math.abs(velocity.current) > 0.1) {
      const animate = () => {
        if (!container) return
        velocity.current *= 0.95
        container.scrollLeft -= velocity.current * 10
        if (Math.abs(velocity.current) > 0.05) {
          animationFrame.current = requestAnimationFrame(animate)
        }
      }
      animationFrame.current = requestAnimationFrame(animate)
    }
  }, [])

  // 鼠标离开海报区域 - 如果正在拖拽，结束拖拽
  const handleMouseLeaveArea = useCallback(() => {
    if (isDragging.current) {
      handleMouseUp()
    }
  }, [handleMouseUp])

  // 左箭头
  const scrollLeftByPage = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const pageWidth = container.clientWidth * 0.8
    container.scrollBy({ left: -pageWidth, behavior: 'smooth' })
  }, [])

  // 右箭头
  const scrollRightByPage = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const pageWidth = container.clientWidth * 0.8
    container.scrollBy({ left: pageWidth, behavior: 'smooth' })
  }, [])

  // 初始化时检查箭头
  useEffect(() => {
    const timer = setTimeout(updateArrowVisibility, 100)
    return () => clearTimeout(timer)
  }, [items, updateArrowVisibility])

  // 没有数据时不显示
  if (items.length === 0) return null

  return (
    <section className="mb-10">
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="section-title flex items-center gap-2">
          <div className="w-7 h-7 rounded-[var(--radius-sm)] bg-[var(--accent-bg)] flex items-center justify-center">
            <Sparkles size={14} className="text-[var(--accent)]" />
          </div>
          最近入库
          <span className="text-[12px] font-normal text-[var(--text-tertiary)] ml-1">
            ({items.length} 部)
          </span>
        </h2>

        {/* 左右箭头按钮 */}
        <div className="flex items-center gap-1.5">
          <AnimatePresence>
            {showLeftArrow && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                onClick={scrollLeftByPage}
                className="w-8 h-8 rounded-full bg-[var(--bg-elevated)] border border-[var(--separator)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                whileTap={{ scale: 0.9 }}
              >
                <ChevronLeft size={16} />
              </motion.button>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {showRightArrow && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                onClick={scrollRightByPage}
                className="w-8 h-8 rounded-full bg-[var(--bg-elevated)] border border-[var(--separator)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                whileTap={{ scale: 0.9 }}
              >
                <ChevronRight size={16} />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* 横向滚动容器 */}
      <div className="relative">
        {/* 左渐变遮罩 */}
        <AnimatePresence>
          {showLeftArrow && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-[var(--bg-primary)] to-transparent pointer-events-none z-10"
            />
          )}
        </AnimatePresence>

        {/* 右渐变遮罩 */}
        <AnimatePresence>
          {showRightArrow && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-l from-[var(--bg-primary)] to-transparent pointer-events-none z-10"
            />
          )}
        </AnimatePresence>

        {/* 滚动容器 */}
        <div
          ref={scrollContainerRef}
          className="flex gap-3 sm:gap-4 overflow-x-auto pb-3 -mx-2 px-2 scrollbar-hide cursor-grab active:cursor-grabbing"
          onScroll={handleScroll}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeaveArea}
        >
          {items.map((item, index) => (
            <PosterCard
              key={item.itemId}
              item={item}
              posterUrl={getPosterUrl(item)}
              onClick={() => onItemClick(item)}
              index={index}
            />
          ))}
        </div>
      </div>
    </section>
  )
}
