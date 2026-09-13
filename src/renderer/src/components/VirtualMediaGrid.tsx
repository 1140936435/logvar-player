import { useRef, useState, useEffect, type ReactElement } from 'react'

interface VirtualMediaGridProps<T> {
  items: T[]
  itemSize: number
  gap: number
  renderItem: (item: T, index: number, style: React.CSSProperties) => ReactElement
}

/** 首帧前 ResizeObserver 尚未回报时的兜底 viewport，避免首屏渲染 0 行 */
const FALLBACK_VIEWPORT = { width: 800, height: 600 }

// 自包含的轻量虚拟列表实现，避免对外部虚拟化库的依赖。
// 仅渲染可视区域内的行，处理大量条目时保持流畅。
// 视口宽高全部来自 ResizeObserver 的真实测量（勿写死常量：窗口尺寸 / DPI /
// 侧边栏开合都会使估算行号偏差）；gap 以 prop 为唯一数据源，行内布局用
// inline style 呈现，不再与 JSX 上的响应式 gap class 各说各话。
export function VirtualMediaGrid<T>({
  items,
  itemSize,
  gap,
  renderItem,
}: VirtualMediaGridProps<T>): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setViewport({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const columnCount = Math.max(2, Math.floor((viewport.width + gap) / (itemSize + gap)))
  const rowCount = Math.ceil(items.length / columnCount)
  const rowHeight = itemSize + gap

  const overscan = 2
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const visibleRows = Math.ceil(viewport.height / rowHeight) + overscan * 2
  const endIndex = Math.min(rowCount, startIndex + visibleRows)

  const rows: number[] = []
  for (let i = startIndex; i < endIndex; i++) rows.push(i)

  const getItemsForRow = (rowIndex: number): T[] => {
    const start = rowIndex * columnCount
    return items.slice(start, start + columnCount)
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-y-auto"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: rowCount * rowHeight, position: 'relative' }}>
        {rows.map((rowIndex) => (
          <div
            key={rowIndex}
            className="absolute left-0 flex"
            style={{ top: rowIndex * rowHeight, width: '100%', height: rowHeight, gap }}
          >
            {getItemsForRow(rowIndex).map((item, colIndex) =>
              renderItem(item, rowIndex * columnCount + colIndex, { flex: '0 0 auto', width: itemSize })
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
