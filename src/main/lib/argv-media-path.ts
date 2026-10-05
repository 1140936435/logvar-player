/**
 * argv 媒体路径提取（纯函数，可单测）。
 *
 * 场景：Windows「右键视频 → 打开方式 → 环影」时，系统把目标文件路径作为
 * 启动参数传给主进程。需兼容以下形态：
 *   - 裸路径：          H:\dev\my video.mp4（路径含空格时 Windows 外壳一般已正确转义）
 *   - 带引号路径：      "H:\dev\my video.mp4"（个别外壳/快捷方式未剥引号）
 *   - file URL：        file:///H:/dev/my%20video.mp4 / file://H:/dev/a.mp4
 *   - 开发态占位：      electron . <path>（'.' 为项目目录占位）
 *   - 无关开关：        --enable-logging 等（须跳过）
 *
 * 安全语义：仅返回「扩展名受支持且文件真实存在」的路径；无效/非媒体路径返回
 * null，由调用方保持默认行为（不播放、不弹错）。
 */
import { existsSync } from 'fs'
import { isVideoPath } from '../../shared/video-extensions'

export interface MediaArgvParseOptions {
  /** 文件存在性判断（测试注入；默认 fs.existsSync） */
  exists?: (p: string) => boolean
}

/** 剥离首尾成对双引号（仅当确实是包裹引号时） */
function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
  return s
}

/** file:// URL → 本地绝对路径；解析失败返回 null */
function fileUrlToPath(raw: string): string | null {
  let rest = raw.slice('file://'.length)
  if (rest.startsWith('/')) rest = rest.slice(1)
  if (!rest) return null
  let p: string
  try {
    p = decodeURIComponent(rest)
  } catch {
    return null // 非法 % 编码
  }
  if (!p) return null
  // Windows 盘符形态：file:///H:/a%20b.mp4 → H:/a b.mp4 → H:\a b.mp4
  if (/^[A-Za-z]:[\\/]/.test(p)) return p.replace(/\//g, '\\')
  // POSIX 形态：file:///home/u/a.mp4 → /home/u/a.mp4（原样保留）
  return p
}

/**
 * 从 Electron 主进程 argv 中提取第一个有效媒体文件路径。
 * argv[0] 恒为可执行文件，从索引 1 开始扫描。
 */
export function extractMediaPathFromArgv(
  argv: string[],
  options: MediaArgvParseOptions = {}
): string | null {
  const exists = options.exists ?? existsSync
  for (let i = 1; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw) continue
    // 跳过开关参数（--xxx / -x）与开发态目录占位（electron .）
    if (raw.startsWith('-')) continue
    if (raw === '.' || raw === '..') continue

    const candidate = stripQuotes(raw)
    if (!candidate) continue

    if (/^file:\/\//i.test(candidate)) {
      const p = fileUrlToPath(candidate)
      if (p && isVideoPath(p) && exists(p)) return p
      continue
    }

    if (isVideoPath(candidate) && exists(candidate)) return candidate
  }
  return null
}
