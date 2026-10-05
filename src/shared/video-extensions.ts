/**
 * 支持的本地视频扩展名（单一真源）。
 * main（argv 媒体路径识别 / 文件夹扫描）、shared 共用，避免两处集合漂移。
 * 扩展名统一小写；判断时对输入做 toLowerCase，大小写不敏感。
 */
export const VIDEO_EXTENSIONS = [
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.m2ts', '.rmvb'
] as const

export const VIDEO_EXTENSION_SET: ReadonlySet<string> = new Set<string>(VIDEO_EXTENSIONS)

/** 判断路径是否为受支持的视频文件（按扩展名，不校验存在性） */
export function isVideoPath(p: string): boolean {
  const idx = p.lastIndexOf('.')
  if (idx < 0 || idx === p.length - 1) return false
  return VIDEO_EXTENSION_SET.has(p.slice(idx).toLowerCase())
}
