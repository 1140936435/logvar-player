// 修复点 1.2: 改为从 shared/types 导入，而非反向从 Player 页面导入
import type { DanmakuComment, EngineDanmakuComment, DanmakuMode } from '../../../shared/types'
import { TrackAllocator } from './trackAllocator'

interface ActiveComment {
  text: string
  x: number
  y: number
  color: string
  width: number
  height: number
  mode: DanmakuMode
  time: number
  // 修复点 2.1: 移除基于 performance.now 的 _utc 混合时钟，统一用外部 videoTime 单一时钟驱动
  // 保留的基准值：弹幕入场时的 videoTime（用于计算相对流逝）
  startVideoTime: number
  // 顶部/底部固定字幕的显示截止 videoTime
  endVideoTime: number
}

interface CollisionRange {
  range: number
  time: number
  width: number
  height: number
}

interface Space {
  ltr: CollisionRange[]
  rtl: CollisionRange[]
  top: CollisionRange[]
  bottom: CollisionRange[]
}

const colorCache = new Map<number, string>()
function decToRgb(dec: number): string {
  const cached = colorCache.get(dec)
  if (cached) return cached
  const r = (dec >> 16) & 0xff
  const g = (dec >> 8) & 0xff
  const b = dec & 0xff
  const result = `rgb(${r},${g},${b})`
  if (colorCache.size > 256) colorCache.clear()
  colorCache.set(dec, result)
  return result
}

// 修复点 2.8: 对齐 DPlayer/B 站规范 — mode=1 滚动(rtl)、mode=4 底部、mode=5 顶部
// B 站规范：1=右滚滚动、4=底部固定、5=顶部固定、6=逆向左滚（ltr）、7=高级（忽略）、8=脚本（忽略）
function formatMode(mode: number): DanmakuMode {
  switch (mode) {
    case 1: return 'rtl'
    case 4: return 'bottom'
    case 5: return 'top'
    case 6: return 'ltr'
    default: return 'rtl'
  }
}

function binsearch(arr: { time: number }[], prop: 'time', key: number): number {
  let left = 0
  let right = arr.length
  while (left < right - 1) {
    const mid = (left + right) >> 1
    if (key >= arr[mid][prop]) {
      left = mid
    } else {
      right = mid
    }
  }
  if (arr[left] && key < arr[left][prop]) {
    return left
  }
  return right
}

function collidableRange(): CollisionRange[] {
  const max = 9007199254740991
  return [
    { range: 0, time: -max, width: max, height: 0 },
    { range: max, time: max, width: 0, height: 0 }
  ]
}

function resetSpace(space: Space): void {
  space.ltr = collidableRange()
  space.rtl = collidableRange()
  space.top = collidableRange()
  space.bottom = collidableRange()
}

export class DanmakuEngine {
  private canvas: HTMLCanvasElement
  // 修复点 1.10: ctx 允许 null，构造后立刻检查有效性
  private ctx: CanvasRenderingContext2D | null = null
  // 修复点 2.4: 所有弹幕内部化，使用 EngineDanmakuComment（mode 已字符串化、尺寸已缓存）
  private allComments: EngineDanmakuComment[] = []
  private runningList: ActiveComment[] = []
  private position = 0
  private space: Space = { ltr: [], rtl: [], top: [], bottom: [] }
  private paused = true
  private visible = true

  // 修复点 2.10: HiDPI 支持
  private dpr = 1
  // CSS 像素尺寸（不乘 DPR）
  private cssWidth = 0
  private cssHeight = 0

  // 滚动持续时长（秒）— 由 width/speed 推导
  private scrollDuration = 4
  // 顶部/底部固定字幕展示时长
  private stillDuration = 5

  private speed = 144 // px/s
  private opacity = 1.0
  private fontSize = 24
  private fontString = ''
  private trackHeight = 36

  private timeOffset = 0
  private maxActiveComments = 300

  // 弹幕显示区域边界（百分比，0-100）
  private topBoundaryPercent = 0
  private bottomBoundaryPercent = 100
  // 性能优化：缓存的边界像素值，避免每帧重复计算
  private topBoundaryPx = 0
  private bottomBoundaryPx = 0
  // 轨道分配器（参考 DPlayer 算法）
  private trackAllocator = new TrackAllocator()

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      console.warn('[DanmakuEngine] 2D context is unavailable, danmaku disabled.')
      return
    }
    this.ctx = ctx
    this.buildFont()
    resetSpace(this.space)
    this.updateBoundaryPixels()
  }

  // 性能优化：缓存边界像素值，避免 allocate/update 每帧重复计算
  private updateBoundaryPixels(): void {
    this.topBoundaryPx = (this.topBoundaryPercent / 100) * this.cssHeight
    this.bottomBoundaryPx = (this.bottomBoundaryPercent / 100) * this.cssHeight
  }

  private buildFont(): void {
    this.fontString = `bold ${this.fontSize}px "Microsoft YaHei", sans-serif`
    this.trackHeight = Math.round(this.fontSize * 1.5)
  }

  // 修复点 2.10: 真实尺寸乘以 DPR，ctx 上再 scale，保证 Retina 屏不糊
  resize(): void {
    const parent = this.canvas.parentElement
    if (!parent) return
    this.cssWidth = parent.clientWidth
    this.cssHeight = parent.clientHeight
    this.dpr = Math.max(1, Math.min(3, typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1))
    this.canvas.style.width = `${this.cssWidth}px`
    this.canvas.style.height = `${this.cssHeight}px`
    this.canvas.width = Math.floor(this.cssWidth * this.dpr)
    this.canvas.height = Math.floor(this.cssHeight * this.dpr)
    if (this.ctx) {
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    }
    if (this.speed > 0 && this.cssWidth > 0) {
      this.scrollDuration = this.cssWidth / this.speed
    }
    // 性能优化：尺寸变化后重新缓存边界像素值
    this.updateBoundaryPixels()
  }

  // 修复点 2.4: 深拷贝+规范化成 EngineDanmakuComment，不修改外部传入数组
  loadComments(comments: DanmakuComment[]): void {
    const ctx = this.ctx
    const widthCtx = ctx ?? (typeof document !== 'undefined'
      ? document.createElement('canvas').getContext('2d')
      : null)
    if (widthCtx) widthCtx.font = this.fontString

    const engineComments: EngineDanmakuComment[] = comments
      .filter((c) => typeof c?.time === 'number' && typeof c?.mode === 'number' && typeof c?.text === 'string')
      .map((c) => {
        let w = c.width
        let h = c.height ?? this.trackHeight
        if ((w === undefined || w <= 0) && widthCtx) {
          try { w = widthCtx.measureText(c.text).width } catch { w = c.text.length * this.fontSize * 0.6 }
        }
        return {
          time: c.time,
          mode: formatMode(c.mode),
          color: c.color >>> 0,
          text: c.text,
          width: Math.max(1, w ?? c.text.length * this.fontSize * 0.6),
          height: Math.max(1, h)
        } satisfies EngineDanmakuComment
      })
      .sort((a, b) => a.time - b.time)

    this.allComments = engineComments
    this.clear()
    this.position = 0
  }

  getCommentCount(): number {
    return this.allComments.length
  }

  clear(): void {
    this.runningList = []
    resetSpace(this.space)
    this.trackAllocator.clear()
    this.position = 0
    this.paused = true
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight)
    }
  }

  setOpacity(opacity: number): void {
    this.opacity = Math.max(0, Math.min(1, opacity))
  }

  setFontSize(size: number): void {
    this.fontSize = Math.max(12, Math.min(48, size))
    this.buildFont()
  }

  setSpeed(speed: number): void {
    if (typeof speed !== 'number' || isNaN(speed) || !isFinite(speed) || speed <= 0) {
      return
    }
    this.speed = speed
    if (this.cssWidth > 0) {
      this.scrollDuration = this.cssWidth / speed
    }
  }

  setTimeOffset(offset: number): void {
    this.timeOffset = Math.max(-30, Math.min(30, offset))
  }

  getTimeOffset(): number {
    return this.timeOffset
  }

  setMaxActiveComments(count: number): void {
    this.maxActiveComments = Math.max(50, Math.min(500, count))
  }

  // 设置弹幕显示区域边界（百分比，0-100）
  setBoundary(topPercent: number, bottomPercent: number): void {
    this.topBoundaryPercent = Math.max(0, Math.min(100, topPercent))
    this.bottomBoundaryPercent = Math.max(this.topBoundaryPercent, Math.min(100, bottomPercent))
    // 性能优化：边界变化后重新缓存像素值
    this.updateBoundaryPixels()
    console.log(`[DanmakuEngine] 弹幕区域边界已设置: ${this.topBoundaryPercent}% - ${this.bottomBoundaryPercent}%`)
  }

  getBoundary(): { topPercent: number; bottomPercent: number } {
    return {
      topPercent: this.topBoundaryPercent,
      bottomPercent: this.bottomBoundaryPercent
    }
  }

  enable(): void {
    this.visible = true
  }

  disable(): void {
    this.visible = false
    this.pause()
    if (this.ctx) this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight)
  }

  isEnabled(): boolean {
    return this.visible
  }

  // ========== 碰撞 & 轨道分配（参考 DPlayer 算法）==========
  private allocate(cmt: EngineDanmakuComment, videoTime: number, playbackRate: number): number {
    const ct = videoTime - this.timeOffset
    const pbr = playbackRate || 1

    // 修复 Task 2: 在 engine 层统一计算 effectiveDuration（除以 playbackRate）
    // trackAllocator 直接使用此值，不再二次除法，避免重复计算
    // - 滚动弹幕（ltr/rtl）：scrollDuration / pbr（倍速时滚动更快）
    // - 固定弹幕（top/bottom）：stillDuration（按视频时间计时，不受倍速影响）
    const effectiveDuration = cmt.mode === 'top' || cmt.mode === 'bottom'
      ? this.stillDuration
      : this.scrollDuration / pbr

    // 性能优化：使用缓存的边界像素值，避免每帧重复计算
    const topBoundary = this.topBoundaryPx
    const bottomBoundary = this.bottomBoundaryPx

    // 修复 ARCH-1: 统一使用 TrackAllocator 进行轨道分配（top/bottom/ltr/rtl 全部走同一套）
    // 不再为 top/bottom 维护独立的 CollisionRange 碰撞系统
    const allocatedY = this.trackAllocator.allocate({
      danmaku: {
        width: cmt.width,
        height: cmt.height,
        mode: cmt.mode
      },
      currentTime: ct,
      // 修复 Task 2: 已是有效时长，不再传 playbackRate（allocate 内直接使用）
      scrollDuration: effectiveDuration,
      canvasWidth: this.cssWidth,
      canvasHeight: this.cssHeight,
      topBoundary,
      bottomBoundary
    })

    // 超出边界返回屏幕外（会被渲染层丢弃）
    if (allocatedY === null) {
      return this.cssHeight + 1
    }

    // 修复 ARCH-1: top/bottom 模式按边界转换 y 坐标
    if (cmt.mode === 'bottom') {
      // bottom: 从底部边界向上堆叠
      // allocatedY 是从 topBoundary 起算的绝对 y，需镜像到底部
      return bottomBoundary - (allocatedY - topBoundary) - cmt.height
    }
    // top / ltr / rtl: allocatedY 即为最终 y 坐标
    return allocatedY
  }

  private createActiveComment(cmt: EngineDanmakuComment, videoTime: number): ActiveComment {
    const duration = cmt.mode === 'top' || cmt.mode === 'bottom'
      ? this.stillDuration
      : this.scrollDuration
    return {
      text: cmt.text,
      x: 0,
      y: 0,
      color: decToRgb(cmt.color),
      width: cmt.width,
      height: cmt.height,
      mode: cmt.mode,
      time: cmt.time,
      startVideoTime: videoTime,
      endVideoTime: videoTime + duration
    }
  }

  // 修复点 2.1: 核心同步逻辑 —— 只使用传入的 videoTime 一个时钟源，不再混用 performance.now
  // 这样 pause / resume / seek / ratechange / 缓冲卡顿后全都天然与视频对齐。
  update(videoTime: number, playbackRate: number = 1): void {
    const ctx = this.ctx
    if (!ctx || !this.visible || this.allComments.length === 0) {
      if (ctx) ctx.clearRect(0, 0, this.cssWidth, this.cssHeight)
      return
    }
    // 修复点 3.9: 单帧执行时的异常不能导致后续帧永远停画，try/catch 兜底并输出可追踪错误
    try {
    if (this.cssWidth <= 0 || this.cssHeight <= 0) {
      this.resize()
      if (this.cssWidth <= 0 || this.cssHeight <= 0) return
    }

    const ct = videoTime - this.timeOffset
    const pbr = playbackRate || 1
    const scrollDur = this.scrollDuration
    const stillDur = this.stillDuration

    // 1. 移除已离开屏幕的活跃弹幕
    for (let i = this.runningList.length - 1; i >= 0; i--) {
      const cmt = this.runningList[i]
      if (cmt.mode === 'top' || cmt.mode === 'bottom') {
        if (ct - cmt.startVideoTime >= stillDur) this.runningList.splice(i, 1)
      } else {
        if (ct - cmt.startVideoTime >= scrollDur) this.runningList.splice(i, 1)
      }
    }

    // 1.5 清理轨道分配器中已过期的轨道记录
    // 修复 ARCH-1: 统一使用 TrackAllocator 后，四种模式都需要清理
    this.trackAllocator.cleanupExpired('ltr', ct)
    this.trackAllocator.cleanupExpired('rtl', ct)
    this.trackAllocator.cleanupExpired('top', ct)
    this.trackAllocator.cleanupExpired('bottom', ct)

    // 修复 ARCH-5: 使用缓存的自定义边界像素值，用于屏幕外丢弃判断
    const topBoundary = this.topBoundaryPx
    const bottomBoundary = this.bottomBoundaryPx

    // 2. 从 position 开始按时间顺序加入新的活跃弹幕
    while (this.position < this.allComments.length) {
      const cmt = this.allComments[this.position]
      if (cmt.time > ct) break // 还没到显示时间
      const elapsed = ct - cmt.time
      const life = cmt.mode === 'top' || cmt.mode === 'bottom' ? stillDur : scrollDur
      if (elapsed > life) { this.position++; continue } // 已经过了
      if (this.runningList.length >= this.maxActiveComments) break

      const active = this.createActiveComment(cmt, ct)
      active.y = this.allocate(cmt, ct, pbr)
      // 修复 ARCH-5: 分配到屏幕外的（轨道溢出或超出自定义边界）直接丢弃，不进入渲染
      // 原代码仅判断 0/cssHeight，未考虑自定义边界，导致超出 bottomBoundary 的弹幕仍会进入渲染
      if (active.y + active.height <= topBoundary || active.y >= bottomBoundary) { this.position++; continue }
      this.runningList.push(active)
      this.position++
    }

    // 3. 防止极端情况（连续大跳时间后）过多堆积
    while (this.runningList.length > this.maxActiveComments) {
      this.runningList.shift()
    }

    // 4. 清屏 + 按当前 videoTime 计算坐标并绘制（全部由 ct 单一时钟驱动）
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight)
    ctx.font = this.fontString
    ctx.textBaseline = 'middle'
    ctx.globalAlpha = this.opacity

    for (const cmt of this.runningList) {
      const elapsedVideo = ct - cmt.startVideoTime
      let x = 0
      if (cmt.mode === 'ltr') {
        // 左→右：从 -width 滚到 cssWidth
        const total = this.cssWidth + cmt.width
        x = -cmt.width + total * (elapsedVideo / scrollDur)
      } else if (cmt.mode === 'rtl') {
        // 右→左：从 cssWidth 滚到 -width（DPlayer 默认）
        const total = this.cssWidth + cmt.width
        x = this.cssWidth - total * (elapsedVideo / scrollDur)
      } else {
        // top / bottom 固定位置水平居中
        x = (this.cssWidth - cmt.width) / 2
      }

      if (x >= -cmt.width && x <= this.cssWidth) {
        ctx.fillStyle = cmt.color
        ctx.fillText(cmt.text, x, cmt.y + cmt.height / 2)
      }
    }
    ctx.globalAlpha = 1
    } catch (err) {
      // 修复点 3.9: 单帧异常兜底，避免后续帧永远不绘制。使用 warn 级别避免刷屏。
      console.warn('[DanmakuEngine:update] 单帧绘制异常，已跳过:', err instanceof Error ? err.message : String(err))
    }
  }

  // seek 后清空活跃列表和碰撞区，重定位 position 到目标时间附近
  seek(time: number): void {
    this.runningList = []
    resetSpace(this.space)
    this.trackAllocator.clear()
    if (!this.ctx) return
    // 修复 BUG-3: seek 后用二分查找重定位 position，避免跳过大量弹幕
    this.position = binsearch(this.allComments, 'time', time)
    console.log(`[DanmakuEngine:seek] position 重定位到 ${this.position}, time=${time}`)
  }

  play(): void {
    if (!this.visible || !this.paused) return
    this.paused = false
  }

  pause(): void {
    if (!this.visible || this.paused) return
    this.paused = true
  }

  destroy(): void {
    this.clear()
    this.allComments = []
    this.runningList = []
    resetSpace(this.space)
    this.ctx = null
  }
}
