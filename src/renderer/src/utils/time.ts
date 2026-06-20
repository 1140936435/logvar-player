/**
 * 时间格式化工具函数
 * 统一管理 formatTime 和 formatTimeAgo，避免代码重复
 */

/**
 * 格式化时长（秒）为可读字符串
 * @param seconds 秒数
 * @returns 格式化字符串，如 "01:23:45" 或 "23:45"
 */
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

/**
 * 格式化时间戳为相对时间描述
 * @param timestamp Unix 时间戳（毫秒）
 * @returns 相对时间字符串，如 "刚刚"、"5分钟前"、"3天前"
 */
export function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

/**
 * 格式化时长（秒）为中文描述
 * @param seconds 秒数
 * @returns 中文描述，如 "1小时23分钟"
 */
export function formatDurationChinese(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}小时${m}分钟`
  return `${m}分钟`
}
