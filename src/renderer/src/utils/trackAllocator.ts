import type { DanmakuMode } from '../../../shared/types'

export interface TrackItem {
  y: number
  height: number
  endTime: number
  // 修复 Task 1: 新增字段用于宽度碰撞检测（参考 DPlayer willCollide 算法）
  width: number       // 弹幕宽度
  startTime: number   // 弹幕进入轨道的时间
  speed: number       // 弹幕移动速度（px/s），top/bottom 为 0
}

export interface AllocateOptions {
  danmaku: {
    width: number
    height: number
    mode: DanmakuMode
  }
  currentTime: number
  // 修复 Task 2: scrollDuration 已是有效时长（engine 层已除以 playbackRate），allocate 内直接使用
  scrollDuration: number
  canvasWidth: number    // 修复 Task 1: 新增，碰撞计算需要画布宽度
  canvasHeight: number
  topBoundary: number
  bottomBoundary: number
}

export class TrackAllocator {
  private tracks: Record<DanmakuMode, TrackItem[]> = {
    ltr: [],
    rtl: [],
    top: [],
    bottom: []
  }

  allocate(options: AllocateOptions): number | null {
    const {
      danmaku,
      currentTime,
      scrollDuration,
      canvasWidth,
      topBoundary,
      bottomBoundary
    } = options

    const { mode, height, width } = danmaku
    // 修复 Task 2: 直接使用 scrollDuration，不再除以 playbackRate（engine 层已处理）
    const effectiveDuration = scrollDuration
    const endTime = currentTime + effectiveDuration
    const availableHeight = bottomBoundary - topBoundary

    if (height > availableHeight) {
      return null
    }

    const modeTracks = this.tracks[mode]
    this.cleanupExpired(mode, currentTime)

    // 修复 Task 1: 参考DPlayer willCollide算法，对滚动弹幕进行宽度碰撞检测
    // 滚动弹幕（ltr/rtl）需要检查宽度碰撞；固定弹幕（top/bottom）只需时间过期判断
    const isScrolling = mode === 'ltr' || mode === 'rtl'
    // 滚动弹幕速度 = (画布宽度 + 弹幕宽度) / 持续时长
    const speed = isScrolling ? (canvasWidth + width) / effectiveDuration : 0

    for (const track of modeTracks) {
      // 1. 时间过期 → 可直接复用轨道
      if (currentTime >= track.endTime) {
        track.endTime = endTime
        track.width = width
        track.startTime = currentTime
        track.speed = speed
        return track.y
      }
      // 2. 未过期
      if (isScrolling) {
        // 滚动弹幕：检查 willCollide（宽度碰撞）
        if (this.willCollide(track, currentTime, canvasWidth, mode)) {
          continue  // 碰撞，跳过此轨道
        }
        // 不碰撞，可以复用此轨道（前一条已离开入口区域）
        track.endTime = endTime
        track.width = width
        track.startTime = currentTime
        track.speed = speed
        return track.y
      }
      // 固定弹幕（top/bottom）未过期，不能复用，跳过
    }

    // 没有可复用轨道 → 新建轨道
    const lastTrack = modeTracks[modeTracks.length - 1]
    const nextY = lastTrack ? lastTrack.y + lastTrack.height : topBoundary

    if (nextY + height > bottomBoundary) {
      return null
    }

    const newTrack: TrackItem = {
      y: nextY,
      height,
      endTime,
      width,
      startTime: currentTime,
      speed
    }
    modeTracks.push(newTrack)
    return nextY
  }

  // 参考 DPlayer willCollide 算法：判断新弹幕是否会与轨道上已有弹幕视觉碰撞
  // 简化判断：如果已有弹幕还没完全进入屏幕（尾缘仍在屏幕外），则碰撞
  // （完整 DPlayer 算法还会检查新弹幕追上已有弹幕的情况，此处简化处理）
  private willCollide(
    prev: TrackItem,
    currentTime: number,
    canvasWidth: number,
    mode: DanmakuMode
  ): boolean {
    const elapsed = currentTime - prev.startTime
    if (elapsed < 0) return true  // 异常：时间倒流，保守认为碰撞

    const prevSpeed = prev.speed
    if (prevSpeed <= 0) return false  // 静止弹幕不滚动，无碰撞

    if (mode === 'rtl') {
      // rtl: 右→左滚动。已有弹幕从右边缘(cssWidth)进入，向左移动。
      // 已有弹幕前缘（左边缘）位置 = cssWidth - speed * elapsed
      // 若前缘 > cssWidth - prevWidth，说明尾缘（右边缘）还没进入屏幕，新弹幕会撞上
      const prevFrontEdge = canvasWidth - prevSpeed * elapsed
      return prevFrontEdge > canvasWidth - prev.width
    } else {
      // ltr: 左→右滚动。已有弹幕从左边缘(-width)进入，向右移动。
      // 已有弹幕前缘（右边缘）位置 = speed * elapsed
      // 若前缘 < prevWidth，说明尾缘（左边缘）还没进入屏幕，新弹幕会撞上
      const prevFrontEdge = prevSpeed * elapsed
      return prevFrontEdge < prev.width
    }
  }

  cleanupExpired(mode: DanmakuMode, currentTime: number): void {
    const modeTracks = this.tracks[mode]
    let writeIndex = 0
    for (let i = 0; i < modeTracks.length; i++) {
      if (currentTime < modeTracks[i].endTime) {
        if (i !== writeIndex) {
          modeTracks[writeIndex] = modeTracks[i]
        }
        writeIndex++
      }
    }
    modeTracks.length = writeIndex
  }

  clear(mode?: DanmakuMode): void {
    if (mode) {
      this.tracks[mode] = []
    } else {
      this.tracks = {
        ltr: [],
        rtl: [],
        top: [],
        bottom: []
      }
    }
  }

  getTracks(mode?: DanmakuMode): TrackItem[] {
    if (mode) {
      return [...this.tracks[mode]]
    }
    return Object.values(this.tracks).flat()
  }
}
