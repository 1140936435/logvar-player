import { useEffect, useRef, type ReactElement } from 'react'

/**
 * MpvCanvasView - mpv 画布渲染视图（方案 C 上屏端）
 *
 * libmpv SW 渲染的帧经 window.api.mpvRender.getFrame() 拉取（结构化克隆一次），
 * 上传 WebGL2 纹理绘制。视频因此是普通 DOM 层：
 * - 控件/弹幕/字幕 canvas 用普通 absolute 定位悬浮，无需窗口透明打孔
 * - 全屏可直接用原生窗口全屏，无任何 workaround
 *
 * 画面适配：libmpv 按目标尺寸渲染时已做等比缩放 + 黑边（contain），
 * 组件只需让渲染目标尺寸跟随画布 backing store（CSS 尺寸 × devicePixelRatio）。
 *
 * 像素格式：rgb0（R,G,B,X），按 RGBA 上传，着色器强制 alpha=1（X 字节是未初始化垃圾）。
 */
export default function MpvCanvasView(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false
    })
    if (!gl) {
      console.error('[MpvCanvasView] WebGL2 不可用')
      return
    }

    // ---- 着色器：直通采样，alpha 强制 1 ----
    const vsSrc = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`
    const fsSrc = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uTex, vUv).rgb, 1.0);
}`
    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type)
      if (!sh) return null
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('[MpvCanvasView] shader:', gl.getShaderInfoLog(sh))
        gl.deleteShader(sh)
        return null
      }
      return sh
    }
    const vs = compile(gl.VERTEX_SHADER, vsSrc)
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc)
    const prog = gl.createProgram()
    if (!vs || !fs || !prog) return
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[MpvCanvasView] link:', gl.getProgramInfoLog(prog))
      return
    }
    gl.useProgram(prog)

    // 全屏三角形
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // rgb0 帧首行在内存顶部 → 上传时翻转 Y
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // ---- 尺寸跟随：backing store = CSS 尺寸 × DPR，并同步给渲染引擎 ----
    let disposed = false
    const applySize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2) // DPR 上限 2，抑制 SW 渲染开销
      const w = Math.max(16, Math.round(canvas.clientWidth * dpr))
      const h = Math.max(16, Math.round(canvas.clientHeight * dpr))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        gl.viewport(0, 0, w, h)
      }
      window.api.mpvRender.setTargetSize(w, h)
    }
    applySize()
    const ro = new ResizeObserver(applySize)
    ro.observe(canvas)

    // ---- 拉帧循环：rAF 驱动，仅在帧序号变化时上传纹理 ----
    let raf = 0
    let lastSeq = -1
    let texW = 0
    let texH = 0
    let frameCount = 0
    let pullErrorLogged = false
    const loop = async (): Promise<void> => {
      if (disposed) return
      try {
        const frame = await window.api.mpvRender.getFrame(lastSeq)
        if (frame && frame.buffer && frame.width > 0) {
          lastSeq = frame.seq
          const pixels = frame.buffer instanceof Uint8Array
            ? frame.buffer
            : new Uint8Array(frame.buffer as unknown as ArrayBuffer)
          if (frame.width !== texW || frame.height !== texH) {
            texW = frame.width
            texH = frame.height
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texW, texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
          } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, texW, texH, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
          }
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          if (++frameCount === 1) {
            console.log(`[MpvCanvasView] 首帧上屏 ${texW}x${texH}`)
          }
        }
      } catch (err) {
        // 拉取失败只记一次，避免刷屏；失败帧直接跳过
        if (!pullErrorLogged) {
          pullErrorLogged = true
          console.error('[MpvCanvasView] 拉帧异常（后续不再重复记录）:', err)
        }
      }
      raf = requestAnimationFrame(() => { void loop() })
    }
    raf = requestAnimationFrame(() => { void loop() })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      gl.deleteTexture(tex)
      gl.deleteBuffer(vbo)
      gl.deleteVertexArray(vao)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
    }
  }, [])

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
}
