/**
 * 播放 URL 白名单（主进程 mpv:play 与 preload mpvRender.play 共用）。
 *
 * 架构约束：媒体服务器地址与 token 全部留在主进程，渲染端拿到的 http 播放地址
 * 只可能是回环 StreamProxy 签发的不透明 session URL（http://127.0.0.1:<port>/s/<uuid>）。
 * 因此 mpv 引擎（打孔 / 画布两条链路）对 http(s) 一律只放行回环地址：
 * 渲染端被控时无法借 mpv 进程探测内网 / 访问任意站点（SSRF）。
 */

/** 视为回环的主机名（hostname 已由 URL 解析为小写、IPv6 不含方括号） */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** http(s) URL 且主机为回环地址（StreamProxy / 本机调试用） */
export function isLoopbackHttpUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  // WHATWG URL 对 IPv6 hostname 保留方括号（'[::1]'），归一化后再比较
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return LOOPBACK_HOSTS.has(host)
}
