import { useState, useEffect, useCallback } from 'react'

// 默认模块顺序
export const DEFAULT_MODULE_ORDER = [
  'server',      // 媒体服务器
  'danmaku',     // 弹幕
  'recently',    // 最近入库
  'player',      // 播放器
  'data'         // 数据管理
]

// 模块元数据映射
export const MODULE_META: Record<string, { title: string; icon: string }> = {
  server: { title: '媒体服务器', icon: 'Server' },
  danmaku: { title: '弹幕', icon: 'MessageCircleMore' },
  recently: { title: '最近入库', icon: 'Sparkles' },
  player: { title: '播放器', icon: 'MonitorPlay' },
  data: { title: '数据管理', icon: 'Database' }
}

const STORAGE_KEY = 'settings:module-order'

export function useModuleLayout() {
  const [moduleOrder, setModuleOrder] = useState<string[]>(DEFAULT_MODULE_ORDER)
  const [isEditMode, setIsEditMode] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  // 加载保存的布局
  useEffect(() => {
    const loadLayout = async () => {
      try {
        const saved = await window.api.store.get(STORAGE_KEY)
        if (saved && Array.isArray(saved)) {
          // 验证并合并保存的顺序
          const savedOrder = saved as string[]
          const validIds = new Set(DEFAULT_MODULE_ORDER)
          const filtered = savedOrder.filter(id => validIds.has(id))
          // 补充缺失的模块
          const missing = DEFAULT_MODULE_ORDER.filter(id => !filtered.includes(id))
          if (filtered.length > 0) {
            setModuleOrder([...filtered, ...missing])
          }
        }
      } catch {
        // 使用默认顺序
      }
    }
    loadLayout()
  }, [])

  // 保存布局到存储
  const saveLayout = useCallback(async (order: string[]) => {
    setIsSaving(true)
    try {
      await window.api.store.set(STORAGE_KEY, order)
      setHasChanges(false)
    } catch (err) {
      console.error('Failed to save layout:', err)
    }
    setIsSaving(false)
  }, [])

  // 更新模块顺序
  const updateOrder = useCallback((newOrder: string[]) => {
    setModuleOrder(newOrder)
    setHasChanges(true)
  }, [])

  // 拖拽结束时保存
  const handleDragEnd = useCallback(async (newOrder: string[]) => {
    setModuleOrder(newOrder)
    setHasChanges(true)
    await saveLayout(newOrder)
  }, [saveLayout])

  // 重置为默认布局
  const resetLayout = useCallback(async () => {
    setModuleOrder(DEFAULT_MODULE_ORDER)
    await window.api.store.delete(STORAGE_KEY)
    setHasChanges(false)
  }, [])

  // 切换编辑模式
  const toggleEditMode = useCallback(() => {
    setIsEditMode(prev => !prev)
  }, [])

  // 退出编辑模式并保存
  const exitEditMode = useCallback(async () => {
    if (hasChanges) {
      await saveLayout(moduleOrder)
    }
    setIsEditMode(false)
  }, [hasChanges, moduleOrder, saveLayout])

  return {
    moduleOrder,
    isEditMode,
    isSaving,
    hasChanges,
    updateOrder,
    handleDragEnd,
    resetLayout,
    toggleEditMode,
    exitEditMode
  }
}
