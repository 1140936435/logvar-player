import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DANMAKU_MAX_DPR, DanmakuEngine, resolveDanmakuDpr } from './danmakuEngine'
import type { DanmakuComment } from '../../../shared/types'

/**
 * 无 DOM 依赖的假 canvas/ctx：DanmakuEngine 只用到 canvas.getContext('2d')、
 * parentElement.clientWidth/Height、style.width/height、width/height，
 * 以及 ctx 的 clearRect / fillText / measureText / setTransform 与少量可写属性。
 * 本文件用于锁定「性能关键改动」的行为（DPR 上限、空闲帧不再重复整屏清屏）。
 */
function createFakeCanvas(cssWidth = 800, cssHeight = 450) {
  const counters = { clearRect: 0, fillText: 0 }
  const ctx = {
    font: '',
    textBaseline: '',
    globalAlpha: 1,
    fillStyle: '',
    clearRect: () => { counters.clearRect++ },
    fillText: () => { counters.fillText++ },
    setTransform: () => {},
    measureText: (text: string) => ({ width: text.length * 12 })
  }
  const canvas = {
    width: 0,
    height: 0,
    style: { width: '', height: '' },
    parentElement: { clientWidth: cssWidth, clientHeight: cssHeight },
    getContext: () => ctx
  }
  return { canvas: canvas as unknown as HTMLCanvasElement, counters }
}

const SCROLL_COMMENT: DanmakuComment = {
  time: 0,
  mode: 1,
  color: 0xffffff,
  text: '性能测试弹幕',
  width: 120,
  height: 36
}

describe('resolveDanmakuDpr（弹幕画布 DPR 上限，性能红线）', () => {
  it('高 DPR 屏被压到上限，避免整屏重绘像素量爆炸', () => {
    expect(resolveDanmakuDpr(3)).toBe(DANMAKU_MAX_DPR)
    expect(resolveDanmakuDpr(4)).toBe(DANMAKU_MAX_DPR)
  })

  it('常规 DPR 原样保留（不牺牲清晰度）', () => {
    expect(resolveDanmakuDpr(1)).toBe(1)
    expect(resolveDanmakuDpr(2)).toBe(2)
    expect(resolveDanmakuDpr(1.5)).toBe(1.5)
  })

  it('非法/异常值兜底为 1', () => {
    expect(resolveDanmakuDpr(0)).toBe(1)
    expect(resolveDanmakuDpr(-2)).toBe(1)
    expect(resolveDanmakuDpr(Number.NaN)).toBe(1)
    expect(resolveDanmakuDpr(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('DanmakuEngine 渲染开销（性能关键行为）', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 3 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resize 使用受控 DPR：3x 屏 backing store 按 2x 分配', () => {
    const { canvas } = createFakeCanvas(800, 450)
    const engine = new DanmakuEngine(canvas)
    engine.resize()

    const raw = canvas as unknown as { width: number; height: number }
    expect(raw.width).toBe(800 * DANMAKU_MAX_DPR)
    expect(raw.height).toBe(450 * DANMAKU_MAX_DPR)

    engine.destroy()
  })

  it('有可见弹幕时每帧清屏一次并绘制', () => {
    const { canvas, counters } = createFakeCanvas()
    const engine = new DanmakuEngine(canvas)
    engine.resize()
    engine.loadComments([SCROLL_COMMENT])
    const base = counters.clearRect // loadComments 内部 clear() 会清一次屏

    engine.update(0.05, 1)
    expect(counters.clearRect).toBe(base + 1)
    expect(counters.fillText).toBeGreaterThan(0)

    engine.update(0.1, 1)
    expect(counters.clearRect).toBe(base + 2)
    expect(counters.fillText).toBeGreaterThan(1)

    engine.destroy()
  })

  it('弹幕全部离屏后：仅清一次残留屏，后续空闲帧不再整屏清屏', () => {
    const { canvas, counters } = createFakeCanvas()
    const engine = new DanmakuEngine(canvas)
    engine.resize()
    engine.loadComments([SCROLL_COMMENT])

    engine.update(0.1, 1)
    const afterDraw = counters.clearRect

    // 跳到弹幕早已结束的时间：本帧清一次残留屏（旧实现此后每帧都会重复清屏）
    engine.update(30, 1)
    expect(counters.clearRect).toBe(afterDraw + 1)

    // 空闲帧：无可见弹幕且画布已干净 → 不得再产生任何清屏调用
    engine.update(30.1, 1)
    engine.update(30.2, 1)
    engine.update(30.3, 1)
    expect(counters.clearRect).toBe(afterDraw + 1)

    engine.destroy()
  })

  it('seek 后画布残留必被清一次（不留旧弹幕残影），且随后空闲帧不再重复清屏', () => {
    const { canvas, counters } = createFakeCanvas()
    const engine = new DanmakuEngine(canvas)
    engine.resize()
    engine.loadComments([SCROLL_COMMENT])

    engine.update(0.1, 1)
    const afterDraw = counters.clearRect

    // seek 到片尾：runningList 清空、position 越过全部弹幕，画布上仍是 seek 前的画面
    engine.seek(600)
    engine.update(600, 1)
    expect(counters.clearRect).toBe(afterDraw + 1)

    engine.update(600.1, 1)
    expect(counters.clearRect).toBe(afterDraw + 1)

    engine.destroy()
  })

  it('关闭弹幕后不再产生任何清屏/绘制调用（空闲帧零开销）', () => {
    const { canvas, counters } = createFakeCanvas()
    const engine = new DanmakuEngine(canvas)
    engine.resize()
    engine.loadComments([SCROLL_COMMENT])

    engine.update(0.1, 1)
    engine.disable() // 内部清屏一次并把画布标记为干净
    const afterDisable = counters.clearRect
    const fillAfterDisable = counters.fillText

    engine.update(0.2, 1)
    engine.update(0.3, 1)
    expect(counters.clearRect).toBe(afterDisable)
    expect(counters.fillText).toBe(fillAfterDisable)

    engine.destroy()
  })
})
