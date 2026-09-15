/**
 * secure-schema.ts — 零依赖的运行时参数 schema 校验器
 *
 * 为 src/main/ipc/secure-handle.ts 提供服务，纯函数、不依赖 electron，
 * 可在 Node 环境（vitest）直接单测。
 *
 * 设计：IPC handler 通常是 (event, ...args)，因此 schema 表达为「位置参数校验器数组」，
 * 每个元素校验对应位置的参数；可选参数用 V.optional() 包裹（缺失/undefined 直接通过）。
 */

/** 校验器：返回 null 表示通过，否则返回错误描述字符串 */
export type Validator = (value: unknown, path?: string) => string | null

const typeName = (v: unknown): string => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/** 组合一组校验器的结果，返回第一个错误 */
export function validateArguments(schema: readonly Validator[], args: readonly unknown[]): string | null {
  // 只校验 schema 声明过的位置；剩余参数（rest args）原样透传不做约束
  for (let i = 0; i < schema.length; i++) {
    const err = schema[i](args[i], `第 ${i + 1} 个参数`)
    if (err) return err
  }
  return null
}

/**
 * 校验器工厂集合（命名空间 V，与 zod 的 schema 构造风格对齐但极简）
 */
export const V = {
  /** 任意值（不校验） */
  unknown: (): Validator => () => null,

  /** 必须为字符串 */
  string: (): Validator => (value, path) =>
    typeof value === 'string' ? null : `${path || 'value'} 应为 string，实际为 ${typeName(value)}`,

  /** 必须为有限数字 */
  number: (): Validator => (value, path) =>
    typeof value === 'number' && Number.isFinite(value) ? null : `${path || 'value'} 应为 number，实际为 ${typeName(value)}`,

  /** 必须为布尔值 */
  boolean: (): Validator => (value, path) =>
    typeof value === 'boolean' ? null : `${path || 'value'} 应为 boolean，实际为 ${typeName(value)}`,

  /** 可选值（undefined / 缺失时通过，否则交给内层校验器） */
  optional: (inner: Validator): Validator => (value, path) =>
    value === undefined ? null : inner(value, path),

  /** 必须是指定枚举值之一 */
  enum: (allowed: readonly unknown[]): Validator => (value, path) =>
    allowed.includes(value) ? null : `${path || 'value'} 不在允许枚举内（${JSON.stringify(allowed)}），实际为 ${JSON.stringify(value)}`,

  /** 必须为非 null 对象（宽松，只要求形态） */
  object: (): Validator => (value, path) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? null
      : `${path || 'value'} 应为对象，实际为 ${typeName(value)}`,

  /** 必须为对象，并按声明字段逐项校验（仅校验已声明字段，多余字段忽略；可选字段用 V.optional） */
  shape: (fields: Record<string, Validator>): Validator => (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return `${path || 'value'} 应为对象，实际为 ${typeName(value)}`
    }
    const obj = value as Record<string, unknown>
    for (const [key, validator] of Object.entries(fields)) {
      const err = validator(obj[key], `${path || 'value'}.${key}`)
      if (err) return err
    }
    return null
  },

  /** 必须为数组，且每个元素通过内层校验器 */
  array: (inner: Validator): Validator => (value, path) => {
    if (!Array.isArray(value)) return `${path || 'value'} 应为数组，实际为 ${typeName(value)}`
    for (let i = 0; i < value.length; i++) {
      const err = inner(value[i], `${path || 'value'}[${i}]`)
      if (err) return err
    }
    return null
  }
}
