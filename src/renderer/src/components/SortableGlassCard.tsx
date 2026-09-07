import React, { type ReactElement } from 'react'
import { motion } from 'framer-motion'
import { GripVertical } from 'lucide-react'

interface SortableGlassCardProps {
  id: string
  title: string
  icon: React.ElementType
  isEditMode: boolean
  isDragging?: boolean
  isDropTarget?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  children: React.ReactNode
}

export function SortableGlassCard({
  id,
  title,
  icon: Icon,
  isEditMode,
  isDragging = false,
  isDropTarget = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  children
}: SortableGlassCardProps): ReactElement {
  return (
    <motion.div
      data-sortable-id={id}
      className={`glass-thick rounded-[var(--radius-2xl)] overflow-hidden transition-all duration-200 ${
        isDragging ? 'shadow-2xl ring-2 ring-[var(--accent)] opacity-50 scale-[1.02]' : ''
      } ${isDropTarget && !isDragging ? 'ring-2 ring-dashed ring-[var(--accent)]/50' : ''} ${
        isEditMode ? 'cursor-grab' : ''
      }`}
      whileHover={!isDragging && !isEditMode ? { y: -2 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 头部 */}
      <div className="flex items-center gap-3 px-7 pt-7 pb-4">
        {/* 拖拽手柄 - 仅在编辑模式显示 */}
        {isEditMode && (
          <div
            draggable
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            className="p-1.5 rounded-md hover:bg-[var(--bg-hover)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)] transition-colors cursor-grab active:cursor-grabbing"
            title="拖动调整顺序"
          >
            <GripVertical size={18} />
          </div>
        )}

        <div className="w-9 h-9 rounded-[var(--radius-md)] bg-[var(--accent-bg)] flex items-center justify-center flex-shrink-0">
          <Icon size={18} className="text-[var(--accent)]" strokeWidth={1.5} />
        </div>
        <h2 className="text-[17px] font-semibold text-[var(--text-primary)] tracking-tight flex-1">{title}</h2>

        {/* 编辑模式指示器 */}
        {isEditMode && (
          <span className="text-[11px] px-2 py-1 rounded-full bg-[var(--accent-bg)] text-[var(--accent)] font-medium">
            可拖动
          </span>
        )}
      </div>

      <div className="mx-7 h-px bg-[var(--separator)]" />

      <div className="p-7 space-y-6">
        {children}
      </div>
    </motion.div>
  )
}
