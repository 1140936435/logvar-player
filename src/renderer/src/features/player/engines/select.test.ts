import { describe, expect, it } from 'vitest'
import { resolveEngineMode } from './select'

describe('resolveEngineMode 引擎选择', () => {
  it('pref=html5 且 mpv/canvas 均可用 → 仍选 html5（尊重用户偏好，不抢跑）', () => {
    expect(resolveEngineMode('html5', true, true)).toBe('html5')
  })

  it('pref=html5 且 mpv/canvas 均不可用 → html5', () => {
    expect(resolveEngineMode('html5', false, false)).toBe('html5')
  })

  it('默认偏好：canvas > mpv > html5', () => {
    expect(resolveEngineMode(undefined, true, true)).toBe('mpv-canvas')
    expect(resolveEngineMode(undefined, true, false)).toBe('mpv')
    expect(resolveEngineMode(undefined, false, false)).toBe('html5')
  })

  it('mpv 全部不可用（探测失败/未安装）→ 自动 fallback 到 html5', () => {
    expect(resolveEngineMode(undefined, false, false)).toBe('html5')
    expect(resolveEngineMode('mpv', false, false)).toBe('html5')
    expect(resolveEngineMode('mpv-canvas', false, false)).toBe('html5')
  })

  it('pref=mpv：mpv 不可用但 canvas 可用 → 降级 mpv-canvas；均不可用 → html5', () => {
    expect(resolveEngineMode('mpv', false, true)).toBe('mpv-canvas')
    expect(resolveEngineMode('mpv', false, false)).toBe('html5')
  })

  it('pref=mpv-canvas：canvas 不可用但 mpv 可用 → 降级 mpv', () => {
    expect(resolveEngineMode('mpv-canvas', true, false)).toBe('mpv')
  })
})
