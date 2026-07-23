import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')

const SOURCE_DIR = resolve(ROOT, 'assets/icon')
const BUILD_DIR = resolve(ROOT, 'build')

function generateLVIcon(width, height) {
  const pixels = new Uint8Array(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  const scale = width / 100

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      let r = 255, g = 255, b = 255, a = 0

      const nx = (x - cx) / scale
      const ny = (y - cy) / scale

      const letterL = drawLetterL(nx, ny)
      const letterV = drawLetterV(nx - 15, ny)

      if (letterL || letterV) {
        const dist = Math.sqrt(nx * nx + ny * ny)
        const angle = Math.atan2(ny, nx)

        const gradient = Math.sin(angle * 3 + dist * 0.1) * 0.5 + 0.5
        const edge = letterL ? getEdgeValue(nx, ny, true) : getEdgeValue(nx - 15, ny, false)

        if (edge > 0) {
          r = Math.round(50 + gradient * 100 + edge * 100)
          g = Math.round(50 + gradient * 50 + edge * 80)
          b = Math.round(150 + gradient * 100 + edge * 70)
          a = Math.round(200 + edge * 55)
        } else {
          r = Math.round(100 + gradient * 80)
          g = Math.round(120 + gradient * 60)
          b = Math.round(200 + gradient * 55)
          a = 255
        }

        const highlight = getHighlight(nx, ny, letterL)
        if (highlight > 0) {
          r = Math.min(255, r + highlight * 80)
          g = Math.min(255, g + highlight * 60)
          b = Math.min(255, b + highlight * 40)
        }
      }

      pixels[i] = r
      pixels[i + 1] = g
      pixels[i + 2] = b
      pixels[i + 3] = a
    }
  }

  return pixels
}

function drawLetterL(x, y) {
  const left = -22, right = -8
  const top = -35, bottom = 35

  const thick = 12
  const armLength = 25

  const inVertical = x >= left && x <= right && y >= top && y <= bottom
  const inHorizontal = x >= left && x <= left + armLength && y >= bottom - thick && y <= bottom

  return inVertical || inHorizontal
}

function drawLetterV(x, y) {
  const scale = 0.8
  const centerX = 0
  const bottomY = 35
  const armLength = 35
  const thick = 8

  const slope = armLength / 45

  const leftArm = (y - bottomY) <= -slope * (x - centerX + armLength / 2) &&
                  (y - bottomY) >= slope * (x - centerX + armLength / 2) &&
                  x >= centerX - armLength / 2 && x <= centerX

  const rightArm = (y - bottomY) <= slope * (x - centerX - armLength / 2) &&
                   (y - bottomY) >= -slope * (x - centerX - armLength / 2) &&
                   x >= centerX && x <= centerX + armLength / 2

  const thickenedLeft = false
  const thickenedRight = false

  return leftArm || rightArm || thickenedLeft || thickenedRight
}

function getEdgeValue(x, y, isL) {
  let dist = Infinity

  if (isL) {
    const edges = [
      { x: -22, y: -35, w: 14, h: 70 },
      { x: -22, y: 23, w: 25, h: 12 },
    ]

    for (const edge of edges) {
      const dx = Math.max(edge.x - x, x - edge.x - edge.w, 0)
      const dy = Math.max(edge.y - y, y - edge.y - edge.h, 0)
      dist = Math.min(dist, Math.sqrt(dx * dx + dy * dy))
    }
  } else {
    const centerX = 0
    const bottomY = 35
    const armLength = 35

    const dx1 = x - (centerX - armLength / 2)
    const dy1 = y - bottomY
    const dist1 = Math.abs(dy1 * 2 - dx1 * 3) / Math.sqrt(4 + 9)

    const dx2 = x - (centerX + armLength / 2)
    const dy2 = y - bottomY
    const dist2 = Math.abs(dy2 * 2 + dx2 * 3) / Math.sqrt(4 + 9)

    dist = Math.min(dist1, dist2, Math.abs(x - centerX))
  }

  const edgeWidth = 3
  return Math.max(0, 1 - dist / edgeWidth)
}

function getHighlight(x, y, isL) {
  const lightX = -30
  const lightY = -40

  const dx = x - lightX
  const dy = y - lightY
  const dist = Math.sqrt(dx * dx + dy * dy)
  const angle = Math.atan2(dy, dx)

  const facingLight = isL ? (x < -15 && y < 0) : (x > -10 && y < 0)

  if (facingLight && dist < 60) {
    return Math.max(0, 1 - dist / 60) * 0.6
  }
  return 0
}

function generateMultiSizeICO(pngMap) {
  const sizes = Object.keys(pngMap)
    .map(Number)
    .sort((a, b) => a - b)

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)

  let dataOffset = 6 + sizes.length * 16
  const dirEntries = []
  const dataBuffers = []

  for (const size of sizes) {
    const pngBuffer = pngMap[size]
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(pngBuffer.length, 8)
    entry.writeUInt32LE(dataOffset, 12)
    dirEntries.push(entry)
    dataBuffers.push(pngBuffer)
    dataOffset += pngBuffer.length
  }

  return Buffer.concat([header, ...dirEntries, ...dataBuffers])
}

async function main() {
  console.log('=== LV 图标生成器 ===\n')
  console.log(`输出目录: ${BUILD_DIR}\n`)

  mkdirSync(BUILD_DIR, { recursive: true })

  const baseSize = 512
  console.log(`[1/4] 生成 ${baseSize}x${baseSize} 母版图标...`)
  const masterPixels = generateLVIcon(baseSize, baseSize)

  const targetSizes = [512, 256, 128, 64, 48, 32, 24, 16]
  const result = {}
  const icoPngMap = {}

  console.log(`[2/4] 生成各尺寸透明 PNG...`)
  for (const s of targetSizes) {
    const resized = await sharp(masterPixels, {
      raw: { width: baseSize, height: baseSize, channels: 4 }
    })
      .resize(s, s, { kernel: sharp.kernel.lanczos3, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, palette: false })
      .toBuffer()

    const outName = `icon-${s}.png`
    result[outName] = resized
    console.log(`  ✅ ${outName} (${s}x${s})`)

    if (s <= 256) {
      icoPngMap[s] = resized
    }

    if (s === 256) {
      result['icon.png'] = resized
    }
  }

  console.log(`[3/4] 生成 Windows ICO 文件...`)
  const icoBuffer = generateMultiSizeICO(icoPngMap)
  result['icon.ico'] = icoBuffer
  console.log(`  ✅ icon.ico (含${Object.keys(icoPngMap).length}种尺寸)`)

  console.log(`[4/4] 写入文件...`)
  for (const [name, buffer] of Object.entries(result)) {
    try {
      writeFileSync(resolve(BUILD_DIR, name), buffer)
      console.log(`  ✅ build/${name} (${buffer.length} bytes)`)
    } catch (e) {
      console.log(`  ⚠️ build/${name} - 写入失败: ${e.message}`)
    }
  }

  console.log('\n[验证] 检查透明通道...')
  for (const [name, buffer] of Object.entries(result)) {
    if (name === 'icon.ico') continue
    const meta = await sharp(buffer).metadata()
    const status = meta.hasAlpha ? '✅ 含Alpha' : '❌ 无Alpha'
    console.log(`  ${name}: ${meta.width}x${meta.height}, ${status}`)
  }

  console.log('\n=== LV 图标生成完成 ===')
}

main().catch(err => {
  console.error('❌ 图标生成失败:', err.message)
  process.exit(1)
})
