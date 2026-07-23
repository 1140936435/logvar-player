import { useRef, useMemo, type ReactElement } from 'react'
import { useVirtual } from '@tanstack/react-virtual'

interface VirtualMediaGridProps<T> {
  items: T[]
  itemSize: number
  gap: number
  renderItem: (item: T, index: number, style: React.CSSProperties) => ReactElement
}

export function VirtualMediaGrid<T>({
  items,
  itemSize,
  gap,
  renderItem,
}: VirtualMediaGridProps<T>): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)

  const columnCount = useMemo(() => {
    if (!containerRef.current) return 4
    const containerWidth = containerRef.current.clientWidth
    return Math.max(2, Math.floor(containerWidth / (itemSize + gap)))
  }, [itemSize, gap])

  const rowCount = useMemo(() => {
    return Math.ceil(items.length / columnCount)
  }, [items.length, columnCount])

  const rowHeight = itemSize + gap

  const virtualizer = useVirtual({
    count: rowCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => rowHeight,
    overscan: 2,
  })

  const getItemsForRow = (rowIndex: number): T[] => {
    const start = rowIndex * columnCount
    return items.slice(start, start + columnCount)
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{
        height: virtualizer.totalSize,
        width: '100%',
      }}
    >
      <div
        className="absolute inset-0 overflow-y-auto"
        style={{
          scrollMarginTop: 0,
        }}
        onScroll={virtualizer.scrollHandler}
      >
        <div style={{ height: virtualizer.totalSize }} />
      </div>
      {virtualizer.virtualItems.map((virtualRow) => {
        const rowItems = getItemsForRow(virtualRow.index)
        return (
          <div
            key={virtualRow.index}
            className="flex gap-3 sm:gap-4"
            style={{
              position: 'absolute',
              top: virtualRow.start,
              left: 0,
              width: '100%',
              height: rowHeight,
            }}
          >
            {rowItems.map((item, colIndex) => {
              const globalIndex = virtualRow.index * columnCount + colIndex
              return renderItem(item, globalIndex, { flex: '0 0 auto', width: itemSize })
            })}
          </div>
        )
      })}
    </div>
  )
}