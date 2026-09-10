import { useRef, useState, useEffect, type ReactElement } from 'react'

interface VirtualMediaGridProps<T> {
  items: T[]
  itemSize: number
  gap: number
  renderItem: (item: T, index: number, style: React.CSSProperties) => ReactElement
}

const VIEWPORT_HEIGHT = 600

// 自包含的轻量虚拟列表实现，避免对外部虚拟化库的依赖。
// 仅渲染可视区域内的行，处理大量条目时保持流畅。
export function VirtualMediaGrid<T>({
  items,
  itemSize,
  gap,
  renderItem,
}: VirtualMediaGridProps<T>): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerWidth, setContainerWidth] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const updateWidth = () => setContainerWidth(el.clientWidth)
    updateWidth()
    const ro = new ResizeObserver(updateWidth)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const columnCount = Math.max(2, Math.floor((containerWidth || 800) / (itemSize + gap)))
  const rowCount = Math.ceil(items.length / columnCount)
  const rowHeight = itemSize + gap

  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 2)
  const visibleRows = Math.ceil(VIEWPORT_HEIGHT / rowHeight) + 4
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
      className="relative w-full overflow-y-auto"
      style={{ height: VIEWPORT_HEIGHT }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: rowCount * rowHeight, position: 'relative' }}>
        {rows.map((rowIndex) => (
          <div
            key={rowIndex}
            className="absolute left-0 flex gap-3 sm:gap-4"
            style={{ top: rowIndex * rowHeight, width: '100%', height: rowHeight }}
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
