import { describe, it, expect } from 'vitest'
import { V, validateArguments } from './secure-schema'

describe('secure-schema validators', () => {
  it('V.string 只接受字符串', () => {
    expect(V.string()('abc')).toBeNull()
    expect(V.string()(123)).toContain('string')
    expect(V.string()(undefined)).toContain('string')
    expect(V.string()(null)).toContain('string')
  })

  it('V.number 只接受有限数字', () => {
    expect(V.number()(1)).toBeNull()
    expect(V.number()(0)).toBeNull()
    expect(V.number()('1')).toContain('number')
    expect(V.number()(NaN)).toContain('number')
    expect(V.number()(Infinity)).toContain('number')
  })

  it('V.boolean 只接受布尔', () => {
    expect(V.boolean()(true)).toBeNull()
    expect(V.boolean()(false)).toBeNull()
    expect(V.boolean()(1)).toContain('boolean')
  })

  it('V.optional undefined 通过，非 undefined 交给内层', () => {
    expect(V.optional(V.string())(undefined)).toBeNull()
    expect(V.optional(V.string())('x')).toBeNull()
    expect(V.optional(V.string())(5)).toContain('string')
  })

  it('V.enum 限制枚举范围', () => {
    const e = V.enum(['json', 'csv'])
    expect(e('json')).toBeNull()
    expect(e('csv')).toBeNull()
    expect(e('xml')).toContain('枚举')
  })

  it('V.array 校验每个元素', () => {
    expect(V.array(V.string())(['a', 'b'])).toBeNull()
    expect(V.array(V.string())(['a', 1])).toContain('[1]')
    expect(V.array(V.string())('a')).toContain('数组')
    expect(V.array(V.object())([{}, { a: 1 }])).toBeNull()
  })

  it('V.object 拒绝 null/数组/原始类型', () => {
    expect(V.object()({})).toBeNull()
    expect(V.object()([])).toContain('对象')
    expect(V.object()(null)).toContain('对象')
    expect(V.object()('str')).toContain('对象')
  })

  it('V.shape 校验声明字段，可选字段缺失通过，必填字段缺失拒绝', () => {
    const shape = V.shape({
      query: V.string(),
      year: V.optional(V.number()),
      type: V.optional(V.string())
    })
    expect(shape({ query: 'abc' })).toBeNull()
    expect(shape({ query: 'abc', year: 2024, type: 'series' })).toBeNull()
    expect(shape({ query: 'abc', year: 'x' })).toContain('year')
    expect(shape({})).toContain('query')
    expect(shape(null)).toContain('对象')
    // 未声明的多余字段忽略
    expect(shape({ query: 'a', extra: 1 })).toBeNull()
  })

  it('V.unknown 放行一切', () => {
    expect(V.unknown()(undefined)).toBeNull()
    expect(V.unknown()({ any: 'thing' })).toBeNull()
  })
})

describe('validateArguments 组合位置参数', () => {
  const schema = [V.string(), V.optional(V.number())]

  it('按 schema 长度校验，多余参数（rest）不约束', () => {
    expect(validateArguments(schema, ['x', 1, 'extra', { free: true }])).toBeNull()
  })

  it('第二个参数可选：缺失/undefined 通过', () => {
    expect(validateArguments(schema, ['x'])).toBeNull()
    expect(validateArguments(schema, ['x', undefined])).toBeNull()
  })

  it('首个参数类型错误会被拒绝，并带出错位置', () => {
    const err = validateArguments(schema, [123, 5])
    expect(err).toContain('第 1 个参数')
    expect(err).toContain('string')
  })

  it('空 schema 恒通过', () => {
    expect(validateArguments([], ['anything'])).toBeNull()
  })
})
