/**
 * 强类型值包装器 - 替代 any 类型
 * 用于 store.get/set 等需要动态类型的场景
 */

// Store value types
export type StoreValue = string | number | boolean | Record<string, unknown> | unknown[] | null

// Douban API response types
export interface DoubanSearchResult {
  id: number
  title: string
  year: string
  poster: string
  overview: string
  rating?: number
  cover?: string
  url?: string
}

export interface DoubanSearchResponse {
  subjects: DoubanSearchResult[]
  total?: number
}

// FFprobe types
export interface FFprobeStream {
  index: number
  codec_name: string
  codec_type: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  bit_rate?: string
  sample_rate?: string
  channels?: number
  disposition?: Record<string, number>
  tags?: Record<string, string>
}

export interface FFprobeFormat {
  format_name?: string
  format_long_name?: string
  duration?: string
  size?: string
  bitrate?: string
  tags?: Record<string, string>
}

export interface FFprobeData {
  streams: FFprobeStream[]
  formats?: FFprobeFormat[]
  format?: FFprobeFormat
  program_count?: number
  programs?: Array<{
    id: number
    name?: string
    streams: FFprobeStream[]
  }>
}

// Store callback types
export interface StoreCallbacks {
  on: (event: string, callback: (...args: unknown[]) => void) => void
  off: (event: string, callback: (...args: unknown[]) => void) => void
}

// IPC response wrapper
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// Generic typed getter
export function typedStoreGet<T extends StoreValue>(value: unknown): T | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as T
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return value as T
  }
  return null
}

// Generic typed setter
export function typedStoreSet(value: StoreValue): StoreValue {
  return value
}
