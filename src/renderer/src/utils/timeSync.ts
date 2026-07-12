export interface TimeSyncOptions {
  maxDrift: number
  syncInterval: number
}

export class TimeSync {
  private baseTime: number = 0
  private baseVideoTime: number = 0
  private playbackRate: number = 1
  private maxDrift: number
  private syncInterval: number
  private lastSyncTime: number = 0

  constructor(options: TimeSyncOptions = { maxDrift: 0.1, syncInterval: 1000 }) {
    this.maxDrift = options.maxDrift
    this.syncInterval = options.syncInterval
  }

  sync(actualVideoTime: number): void {
    this.baseTime = performance.now()
    this.baseVideoTime = actualVideoTime
    this.lastSyncTime = this.baseTime
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = rate
    this.sync(this.getEstimatedTime())
  }

  getEstimatedTime(): number {
    const now = performance.now()
    const elapsed = (now - this.baseTime) / 1000
    return this.baseVideoTime + elapsed * this.playbackRate
  }

  shouldSync(actualVideoTime: number): boolean {
    const estimated = this.getEstimatedTime()
    const drift = Math.abs(estimated - actualVideoTime)
    const timeSinceLastSync = performance.now() - this.lastSyncTime

    if (drift > this.maxDrift) {
      return true
    }

    if (timeSinceLastSync >= this.syncInterval) {
      return true
    }

    return false
  }

  update(actualVideoTime: number): number {
    if (this.shouldSync(actualVideoTime)) {
      this.sync(actualVideoTime)
      return actualVideoTime
    }
    return this.getEstimatedTime()
  }

  reset(): void {
    this.baseTime = 0
    this.baseVideoTime = 0
    this.playbackRate = 1
    this.lastSyncTime = 0
  }

  getPlaybackRate(): number {
    return this.playbackRate
  }
}

export function clampTime(time: number, duration: number): number {
  return Math.max(0, Math.min(time, duration || Infinity))
}

export function formatTime(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function parseTime(timeStr: string): number {
  const parts = timeStr.split(':').reverse()
  let seconds = 0
  for (let i = 0; i < parts.length; i++) {
    seconds += parseFloat(parts[i]) * Math.pow(60, i)
  }
  return seconds
}

export function interpolateTime(
  start: number,
  end: number,
  progress: number
): number {
  return start + (end - start) * progress
}

export function calculateTimeOffset(
  currentTime: number,
  targetTime: number,
  playbackRate: number
): number {
  const diff = targetTime - currentTime
  return diff / playbackRate
}

export const createTimeSync = (options?: TimeSyncOptions): TimeSync => {
  return new TimeSync(options)
}