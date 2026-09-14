/**
 * PlaybackSourceGuard - 统一播放源校验（主进程唯一真源）
 *
 * 两条 mpv 播放链路（打孔引擎 mpv:play / 画布引擎 preload mpvRender.play）
 * 共用同一份校验逻辑：渲染端传入的播放源必须通过全部三层检查才能交给
 * mpv / libmpv 加载——
 *
 * - L1  scheme 白名单：仅 http/https/file/本地磁盘路径
 * - L1.5 http(s) 只允许「当前 StreamProxy 签发且未过期的有效 session URL」，
 *        而非任意回环地址（防止借 mpv 进程访问本机其他回环服务 / 内网 / 任意站点）
 * - L2  file:// / 本地路径必须经 PathAccessService 授权（realpath 后前缀校验），
 *        否则渲染端被控时可借 mpv 进程读取任意文件
 *
 * 依赖（路径授权 / session 校验）由宿主注入，本模块保持纯函数、可独立测试。
 */

import { fileURLToPath } from 'url'
import { isLoopbackHttpUrl } from '../../shared/playback-url'

/** 校验通过：stream-session 携带原始 URL，local-file 携带解析后的本地路径 */
export type PlaybackSourceVerdict =
  | { ok: true; kind: 'stream-session'; url: string }
  | { ok: true; kind: 'local-file'; path: string }
  | { ok: false; kind: 'reject'; error: string }
  | { ok: false; kind: 'path-denied'; error: string }

export interface PlaybackSourceGuardDeps {
  /** PathAccessService 路径授权检查（L2） */
  isPathAllowed(p: string): boolean
  /** URL 是否为当前 StreamProxy 签发且未过期的有效 session URL（L1.5） */
  isValidStreamSessionUrl(url: string): boolean
}

export function checkPlaybackSource(raw: string, deps: PlaybackSourceGuardDeps): PlaybackSourceVerdict {
  const s = String(raw)
  const lower = s.toLowerCase()
  const isHttp = lower.startsWith('http://') || lower.startsWith('https://')
  const isFileUrl = lower.startsWith('file://')
  const isLocalPath = /^[a-z]:[\\/]/.test(lower) || lower.startsWith('\\\\')

  // L1: scheme 白名单 —— 防止渲染端被控时借 mpv 进程访问任意协议/内网
  if (!isHttp && !isFileUrl && !isLocalPath) {
    return { ok: false, kind: 'reject', error: '播放源仅支持 http/https/file 或本地磁盘路径' }
  }

  if (isHttp) {
    // L1.5: http(s) 仅允许回环 StreamProxy 的有效 session URL
    if (!isLoopbackHttpUrl(s)) {
      return { ok: false, kind: 'reject', error: '播放 http 地址仅允许回环代理（StreamProxy）' }
    }
    if (!deps.isValidStreamSessionUrl(s)) {
      return { ok: false, kind: 'reject', error: '播放 http 地址不是有效的 StreamProxy session' }
    }
    return { ok: true, kind: 'stream-session', url: s }
  }

  // L2: 本地文件必须经过 PathAccessService（realpath 后前缀校验）
  try {
    const p = isFileUrl ? fileURLToPath(s) : s
    if (!deps.isPathAllowed(p)) {
      return { ok: false, kind: 'path-denied', error: '路径不在允许目录内' }
    }
    return { ok: true, kind: 'local-file', path: p }
  } catch {
    return { ok: false, kind: 'reject', error: 'file:// URL 无法解析为本地路径' }
  }
}
