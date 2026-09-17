// 弹幕 API 韧性参数与纯函数（无 electron 依赖，可在 Node 环境直接单测）
//
// 背景：自建弹幕服务（LogVar API）在冷缓存 / 向上游源站拉取时单次响应实测可达 ~7s，
// 原 5s / 10s 超时会在「服务端只是慢」的情况下误判失败（日志：Request timeout after 5000ms）。
// 本机到该服务的链路为毫秒级（TCP <12ms、0% 丢包），耗时全部发生在服务端处理阶段，
// 因此策略是「放宽单次超时 + 有限次指数退避重试」，而不是收紧超时或直接放弃。

/** 单次弹幕 API 请求超时（原 5000ms；服务端实测最慢 ~7s，取 15s 留足余量） */
export const DANMAKU_TIMEOUT_MS = 15000

/** 默认重试次数（1 = 最多 2 次尝试；最坏耗时 ≈ 15s×2 + 退避） */
export const DANMAKU_MAX_RETRIES = 1

/** 指数退避基数（600ms → 1200ms → 2400ms …） */
export const DANMAKU_RETRY_BASE_DELAY_MS = 600

/** 单次退避上限 */
export const DANMAKU_RETRY_MAX_DELAY_MS = 5000

/**
 * hash 匹配层（POST /api/v2/match）单次超时：该层是"快速通道"，
 * 失败后仍有 metadata 搜索层兜底，因此给较短超时且不重试，
 * 避免它把整个匹配链路拖长（原继承 15s×2 会让 hash 层独自占掉 30s）。
 */
export const DANMAKU_HASH_TIMEOUT_MS = 10000

/** 抖动上限，避免多个请求同时重试形成尖峰 */
export const DANMAKU_RETRY_JITTER_MS = 200

/**
 * 计算第 attempt 次重试（1-based）前的退避时长：指数增长 + 抖动，带封顶。
 * @param attempt 第几次重试，从 1 开始
 * @param random 随机源（默认 Math.random），便于测试注入
 */
export function computeRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const step = Math.max(0, Math.floor(attempt) - 1)
  const base = Math.min(DANMAKU_RETRY_BASE_DELAY_MS * Math.pow(2, step), DANMAKU_RETRY_MAX_DELAY_MS)
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * DANMAKU_RETRY_JITTER_MS)
  return base + jitter
}

/**
 * 判断错误是否值得重试：超时 / 连接被重置 / 连接中断。
 * 与主进程 dandanRequest 原有判定保持一致，避免把「服务未监听」这类
 * 重试无意义的错误也纳入重试。
 */
export function isRetryableError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return msg.includes('timeout') || msg.includes('socket hang up') || msg.includes('econnreset')
}

/**
 * 归一化备用源列表：兼容 string[] / 换行或逗号分隔的字符串，去空、去重、去尾斜杠。
 * 注意：只做清洗，不内置任何默认备用地址（不臆造第三方源）。
 */
export function normalizeMirrorList(value: unknown): string[] {
  let raw: string[] = []
  if (Array.isArray(value)) raw = value.map((v) => String(v))
  else if (typeof value === 'string') raw = value.split(/[\n,]/)

  const out: string[] = []
  for (const item of raw) {
    const url = item.trim().replace(/\/+$/, '')
    if (url && !out.includes(url)) out.push(url)
  }
  return out
}
