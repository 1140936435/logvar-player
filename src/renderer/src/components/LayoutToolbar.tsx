import React, { type ReactElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings2, RotateCcw, Save, X, Loader2 } from 'lucide-react'

interface LayoutToolbarProps {
  isEditMode: boolean
  isSaving: boolean
  hasChanges: boolean
  onToggleEditMode: () => void
  onReset: () => void
  onExitEditMode: () => void
}

export function LayoutToolbar({
  isEditMode,
  isSaving,
  hasChanges,
  onToggleEditMode,
  onReset,
  onExitEditMode
}: LayoutToolbarProps): ReactElement {
  return (
    <div className="flex items-center justify-between mb-6">
      {/* 左侧标题 */}
      <div className="flex items-center gap-3">
        <h1 className="text-[28px] font-bold text-[var(--text-primary)] tracking-tight">设置</h1>
        <AnimatePresence>
          {isEditMode && (
            <motion.span
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="px-2.5 py-1 rounded-full bg-[var(--accent-bg)] text-[var(--accent)] text-[12px] font-medium"
            >
              编辑模式
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* 右侧操作按钮 */}
      <div className="flex items-center gap-2">
        {isEditMode ? (
          <>
            {/* 重置按钮 */}
            <motion.button
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              whileTap={{ scale: 0.95 }}
              onClick={onReset}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-[var(--separator)] text-[var(--text-secondary)] text-[13px] font-medium hover:bg-[var(--bg-hover)] transition-colors"
            >
              <RotateCcw size={15} />
              恢复默认
            </motion.button>

            {/* 完成按钮 */}
            <motion.button
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              whileTap={{ scale: 0.95 }}
              onClick={onExitEditMode}
              disabled={isSaving}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--accent)] text-white text-[13px] font-medium hover:brightness-110 disabled:opacity-50 transition-all"
            >
              {isSaving ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  保存中...
                </>
              ) : (
                <>
                  {hasChanges ? <Save size={15} /> : <X size={15} />}
                  {hasChanges ? '保存布局' : '完成'}
                </>
              )}
            </motion.button>
          </>
        ) : (
          <motion.button
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            whileTap={{ scale: 0.95 }}
            onClick={onToggleEditMode}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-[var(--separator)] text-[var(--text-secondary)] text-[13px] font-medium hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            <Settings2 size={15} />
            自定义布局
          </motion.button>
        )}
      </div>
    </div>
  )
}
