import { useMemo, type ReactElement } from 'react'
import type { DanmakuComment } from '../../../../shared/types'

// ---------- 密度计算纯函数 ----------
export interface HeatmapResult {
  buckets: number[]
  maxCount: number
  total: number
}

export function buildDanmakuHeatmap(
  comments: DanmakuComment[],
  duration: number,
  bucketSeconds = 1
): HeatmapResult {
  if (duration <= 0 || comments.length === 0) {
    return { buckets: [], maxCount: 0, total: 0 }
  }
  const bucketCount = Math.ceil(duration / bucketSeconds)
  const buckets = new Array(bucketCount).fill(0)
  let maxCount = 0
  let total = 0

  for (const c of comments) {
    const t = c.time
    if (t < 0 || t >= duration) continue
    const idx = Math.floor(t / bucketSeconds)
    if (idx >= 0 && idx < bucketCount) {
      buckets[idx]++
      if (buckets[idx] > maxCount) maxCount = buckets[idx]
      total++
    }
  }

  return { buckets, maxCount, total }
}

// ---------- 热力图组件 ----------
interface DanmakuHeatmapProps {
  comments: DanmakuComment[]
  duration: number
  visible: boolean
}

export function DanmakuHeatmap({ comments, duration, visible }: DanmakuHeatmapProps): ReactElement | null {
  const heatmap = useMemo(
    () => buildDanmakuHeatmap(comments, duration, 1),
    [comments, duration]
  )

  if (!visible || duration <= 0 || heatmap.buckets.length === 0 || heatmap.maxCount === 0) return null

  const barCount = heatmap.buckets.length
  // 限制 DOM 节点数：桶数过多时合并渲染（每桶至少 1px 宽）
  const maxBars = 800
  const step = barCount > maxBars ? Math.ceil(barCount / maxBars) : 1
  const bars: { left: number; width: number; opacity: number }[] = []
  const barWidthPct = (step / barCount) * 100

  for (let i = 0; i < barCount; i += step) {
    let sum = 0
    let cnt = 0
    for (let j = i; j < Math.min(i + step, barCount); j++) {
      sum += heatmap.buckets[j]
      cnt++
    }
    const avg = cnt > 0 ? sum / cnt : 0
    const alpha = heatmap.maxCount > 0 ? avg / heatmap.maxCount : 0
    bars.push({
      left: (i / barCount) * 100,
      width: barWidthPct,
      opacity: 0.06 + alpha * 0.5
    })
  }

  return (
    <div
      className="absolute left-0 right-0 pointer-events-none overflow-hidden"
      style={{ bottom: '50%', height: '8px', marginBottom: '1px' }}
    >
      {bars.map((b, i) => (
        <div
          key={i}
          className="absolute top-0 bottom-0"
          style={{
            left: `${b.left}%`,
            width: `${b.width}%`,
            backgroundColor: '#8b82f6',
            opacity: b.opacity
          }}
        />
      ))}
    </div>
  )
}
