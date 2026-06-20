import { useState, useEffect, useCallback, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Clock, Trash2, X, Loader2, Video, Search,
  ChevronRight, ArrowLeft, Play
} from 'lucide-react'
import { formatTime, formatTimeAgo } from '../utils/time'

/* ==================== 类型 ==================== */

interface PlayHistoryItem {
  itemId: string
  name: string
  duration: number
  position: number
  posterUrl: string
  watchedAt: number
  localFile?: string
  baseUrl?: string
  seriesName?: string
  seriesId?: string
  seasonId?: string
}

/* ==================== 子组件 ==================== */

const HistoryCard = function HistoryCard({ item, onClick, onDelete }: {
  item: PlayHistoryItem
  onClick: () => void
  onDelete: (e: React.MouseEvent) => void
}): ReactElement {
  const progressPercent = item.duration > 0 ? (item.position / item.duration) * 100 : 0

  return (
    <motion.div
      onClick={onClick}
      className="group cursor-pointer relative"
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      <div className="aspect-video rounded-[var(--radius-lg)] overflow-hidden relative bg-[var(--bg-elevated)] border border-[var(--separator)]">
        {item.posterUrl ? (
          <img
            src={item.posterUrl}
            alt={item.name}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Video size={28} className="text-[var(--text-quaternary)]" />
          </div>
        )}

        {/* 播放进度条 */}
        <div className="absolute bottom-0 inset-x-0 h-[3px] bg-[var(--separator)]">
          <div
            className="h-full bg-[var(--accent)] transition-all"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Hover 播放图标 */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
          <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
            <Play size={18} fill="white" className="text-white ml-0.5" />
          </div>
        </div>

        {/* 时间标签 */}
        <div className="absolute bottom-1 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-white/80 font-mono">
          {formatTime(item.position)} / {formatTime(item.duration)}
        </div>

        {/* 删除按钮 */}
        <button
          onClick={onDelete}
          className="absolute top-1.5 right-1.5 w-7 h-7 rounded-md bg-black/50 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--error)]/50"
        >
          <X size={12} className="text-white/70" />
        </button>
      </div>

      <div className="mt-2">
        <p className="text-[13px] text-[var(--text-primary)] font-medium truncate" title={item.name}>{item.name}</p>
        <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{formatTimeAgo(item.watchedAt)}</p>
      </div>
    </motion.div>
  )
}

/* ==================== History 主组件 ==================== */

function History(): ReactElement {
  const navigate = useNavigate()
  const [historyItems, setHistoryItems] = useState<PlayHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  const loadHistory = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.history.list()
      if (result.success && result.data) {
        setHistoryItems(result.data as PlayHistoryItem[])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  const filteredItems = searchQuery.trim()
    ? historyItems.filter(item =>
        item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (item.seriesName && item.seriesName.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : historyItems

  const handlePlay = (item: PlayHistoryItem): void => {
    if (item.localFile) {
      navigate(`/player?file=${encodeURIComponent(item.localFile)}&name=${encodeURIComponent(item.name)}&position=${item.position}`)
    } else {
      const base = item.baseUrl || 'http://localhost:8096'
      navigate(`/player?itemId=${encodeURIComponent(item.itemId)}&name=${encodeURIComponent(item.name)}&base=${encodeURIComponent(base)}&seriesName=${encodeURIComponent(item.seriesName || '')}&seriesId=${encodeURIComponent(item.seriesId || '')}&seasonId=${encodeURIComponent(item.seasonId || '')}&position=${item.position}`)
    }
  }

  const handleDelete = async (e: React.MouseEvent, itemId: string): Promise<void> => {
    e.stopPropagation()
    try {
      await window.api.history.delete(itemId)
      setHistoryItems(prev => prev.filter(h => h.itemId !== itemId))
    } catch { /* ignore */ }
  }

  const handleClearAll = async (): Promise<void> => {
    try {
      await window.api.history.clear()
      setHistoryItems([])
      setShowClearConfirm(false)
    } catch { /* ignore */ }
  }

  return (
    <div className="w-full flex justify-center">
      <motion.div
        className="px-6 py-8 w-full max-w-[1100px]"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      >
        {/* 页面标题 */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="glass-btn-icon w-9 h-9 flex items-center justify-center"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex-1">
            <h1 className="text-[28px] font-bold text-[var(--text-primary)] tracking-tight flex items-center gap-3">
              <Clock size={24} className="text-[var(--accent)]" />
              播放历史
            </h1>
            <p className="text-[14px] text-[var(--text-secondary)] mt-1">
              共 {historyItems.length} 条记录
            </p>
          </div>
          {historyItems.length > 0 && (
            <motion.button
              onClick={() => setShowClearConfirm(true)}
              className="ios-btn ios-btn-secondary !text-[var(--error)] !border-[var(--error)]/20"
              whileTap={{ scale: 0.96 }}
            >
              <Trash2 size={14} />
              清空历史
            </motion.button>
          )}
        </div>

        {/* 搜索栏 */}
        {historyItems.length > 0 && (
          <div className="mb-6">
            <div className="relative">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索播放历史..."
                className="w-full ios-input !pl-11 !pr-4"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* 内容 */}
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 size={24} className="text-[var(--accent)] animate-spin" />
          </div>
        ) : historyItems.length === 0 ? (
          <div className="text-center py-24">
            <Clock size={48} className="mx-auto text-[var(--text-quaternary)] mb-4" />
            <h2 className="text-[18px] font-medium text-[var(--text-secondary)] mb-2">暂无播放记录</h2>
            <p className="text-[14px] text-[var(--text-quaternary)]">开始播放视频后，记录会自动保存在这里</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="text-center py-20">
            <Search size={32} className="mx-auto text-[var(--text-quaternary)] mb-4" />
            <p className="text-[14px] text-[var(--text-tertiary)]">未找到匹配的记录</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {filteredItems.map((item) => (
              <HistoryCard
                key={item.itemId}
                item={item}
                onClick={() => handlePlay(item)}
                onDelete={(e) => handleDelete(e, item.itemId)}
              />
            ))}
          </div>
        )}
      </motion.div>

      {/* 清空确认弹窗 */}
      <AnimatePresence>
        {showClearConfirm && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowClearConfirm(false)}
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <motion.div
              className="relative glass-thick p-6 rounded-[var(--radius-xl)] w-full max-w-sm"
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-[16px] font-semibold text-[var(--text-primary)] mb-2">清空播放历史</h3>
              <p className="text-[13px] text-[var(--text-tertiary)] mb-6">确定要删除所有播放记录吗？此操作无法撤销。</p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowClearConfirm(false)}
                  className="ios-btn ios-btn-secondary"
                >
                  取消
                </button>
                <button
                  onClick={handleClearAll}
                  className="ios-btn ios-btn-primary !bg-[var(--error)] hover:!bg-[var(--error)]/80"
                >
                  确认清空
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default History
