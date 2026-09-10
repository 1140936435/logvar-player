// ==================== 安全 / 纯函数工具（从 index.ts 拆出，便于单元测试） ====================
// 本模块只包含纯函数与常量，不依赖 electron / 文件系统，
// 因此可以在 Vitest 中直接 import 测试。

/**
 * 需要加密存储的 key 列表。
 * 注意：jellyfin.url / servers[].url 故意不加密——服务器地址不是秘密，
 * 且 safeStorage 不可用时会因空串导致服务器记录被清理。
 */
export const ENCRYPTED_KEYS = new Set([
  'jellyfin.token',
  'danmaku:api-primary',
  'danmaku:api-mirrors',
  'danmaku:app-id',
  'danmaku:app-secret'
])

/** 整体视为凭据的配置命名空间：默认禁止导出，Renderer 读取时剥离敏感字段 */
export const CREDENTIAL_NAMESPACES = new Set([
  'jellyfin',
  'emby',
  'jellyfin:servers'
])

/** 对象字段级敏感名：递归抹除（同时覆盖导出值与 Renderer 返回值） */
export const SENSITIVE_FIELD_RE =
  /^(token|password|app[-_]?secret|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|authorization)$/i

/** 原型污染危险键 */
export const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** 值是否携带加密前缀（enc: / xor:） */
export function isEncrypted(val: string): boolean {
  return val.startsWith('enc:') || val.startsWith('xor:')
}

/** 凭据命名空间 + 所有加密存储键（danmaku app-secret/api 凭据等）都按敏感处理 */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_NAMESPACES.has(key) || ENCRYPTED_KEYS.has(key)
}

/** 是否为“普通对象”（排除数组 / null），用于深合并与字段遍历 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 递归清理值中的 enc:/xor: 前缀密文，防止解密失败时泄露加密 blob */
export function sanitizeEncryptedBlobs(value: unknown): unknown {
  if (typeof value === 'string' && isEncrypted(value)) {
    return ''
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeEncryptedBlobs)
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeEncryptedBlobs(v)
    }
    return out
  }
  return value
}

/** 递归抹除对象中的凭据字段（token/password/appSecret/apiKey 等），返回新对象 */
export function stripSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSensitiveFields)
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_FIELD_RE.test(k) ? '' : stripSensitiveFields(v)
    }
    return out
  }
  return value
}

/**
 * 深合并普通对象（用于数据导入 merge 语义）。
 * - 嵌套普通对象递归合并；数组 / 原始值整体覆盖
 * - 忽略 __proto__ / constructor / prototype，防原型污染
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  patch: Record<string, unknown>
): T {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (DANGEROUS_KEYS.has(k)) continue
    const existing = out[k]
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMerge(existing, v)
    } else {
      out[k] = v
    }
  }
  return out as T
}

// ==================== 豆瓣 URL 白名单 ====================
// 豆瓣图片抓取（media:fetch-douban-poster / douban-img 协议）只能命中官方图片域名，
// 否则协议会被当作任意 URL 抓取跳板（SSRF / 内网探测）。

const DOUBAN_IMAGE_HOST_SUFFIXES = ['douban.com', 'doubanio.com']

/** 仅允许 douban 官方图片域名（含子域）的 http(s) URL */
export function isAllowedDoubanImageUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  return DOUBAN_IMAGE_HOST_SUFFIXES.some(s => host === s || host.endsWith('.' + s))
}

// ==================== HTTP Range 解析 ====================

export interface ByteRange {
  start: number
  end: number
}

/**
 * 解析单段 `Range: bytes=...` 头（返回闭区间 [start, end]）。
 * - `bytes=start-end` / `bytes=start-` / `bytes=-suffix`
 * - 非法 / 多段 / 越界返回 null（调用方按 200 全量或 416 处理）
 */
export function parseRangeHeader(
  header: string | null | undefined,
  size: number
): ByteRange | null {
  if (!header || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const startStr = m[1]
  const endStr = m[2]
  let start: number
  let end: number
  if (startStr === '') {
    // 后缀范围：最后 N 字节
    const suffix = Number(endStr)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startStr)
    end = endStr === '' ? size - 1 : Number(endStr)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null
  end = Math.min(end, size - 1)
  return { start, end }
}

// ==================== 凭据展示 / 更新 ====================

/** 凭据掩码：仅保留首尾各 2 位，中间以 **** 替代（长度 ≤6 时整体掩码） */
export function maskSecret(secret: string): string {
  if (secret.length <= 6) return '****'
  return `${secret.slice(0, 2)}****${secret.slice(-2)}`
}

/**
 * App-Secret 更新语义：留空 / 全是空白 = 保持不变（返回 undefined）。
 * 用于修复“打开弹幕设置不改 secret 再保存会把已配置 secret 清空”的 bug。
 */
export function resolveAppSecretInput(incoming: string | undefined | null): string | undefined {
  if (typeof incoming !== 'string') return undefined
  const trimmed = incoming.trim()
  return trimmed === '' ? undefined : trimmed
}

// ==================== 服务器 URL 前缀匹配 ====================

/** 去掉 URL 末尾斜杠（与主进程 normalizeUrl 语义一致） */
export function normalizeServerUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

/** 由服务器 URL 得到 origin + basePath 前缀（不含末尾斜杠）；无法解析返回 null */
export function serverUrlPrefix(serverUrl: string): string | null {
  try {
    const base = new URL(normalizeServerUrl(serverUrl))
    return `${base.origin}${base.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/**
 * 按 URL 匹配服务器：origin + basePath 前缀匹配，最长优先。
 * - 同 host 不同 basePath（https://host/jellyfin 与 https://host/emby）不会串 token
 * - scheme 编码在 origin 中，https 配置的服务器不会匹配 http 目标（防降级）
 */
export function matchServerByUrlPrefix<T extends { url: string }>(
  target: string,
  servers: T[]
): { server: T; prefix: string } | null {
  const t = normalizeServerUrl(target)
  let best: { server: T; prefix: string } | null = null
  for (const s of servers) {
    const prefix = serverUrlPrefix(s.url)
    if (!prefix) continue
    if (t === prefix || t.startsWith(prefix + '/')) {
      if (!best || prefix.length > best.prefix.length) best = { server: s, prefix }
    }
  }
  return best
}
