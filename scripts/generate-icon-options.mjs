import { mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')

const BUILD_DIR = resolve(ROOT, 'build')

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

function drawPlayTriangle(ctx, x, y, size, color) {
  const halfSize = size / 2
  ctx.beginPath()
  ctx.moveTo(x + halfSize, y)
  ctx.lineTo(x + size, y + halfSize)
  ctx.lineTo(x + halfSize, y + halfSize)
  ctx.lineTo(x + halfSize, y)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

function optionA(width, height) {
  const pixels = new Uint8Array(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  const radius = width * 0.35

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const dx = x - cx
      const dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist <= radius) {
        const angle = Math.atan2(dy, dx)
        const gradient = (Math.sin(angle * 2) + 1) / 2
        
        const r = Math.round(60 + gradient * 120)
        const g = Math.round(100 + gradient * 80)
        const b = Math.round(220 + gradient * 35)
        pixels[i] = r
        pixels[i + 1] = g
        pixels[i + 2] = b
        pixels[i + 3] = 255

        if (dist <= radius * 0.65) {
          pixels[i] = 255
          pixels[i + 1] = 255
          pixels[i + 2] = 255
        }

        const playSize = radius * 0.4
        const playX = cx - playSize * 0.15
        const playY = cy - playSize / 2
        const px = x - playX
        const py = y - playY

        if (px >= 0 && px <= playSize && py >= 0 && py <= playSize) {
          const inTriangle = (py <= (px / playSize) * (playSize / 2)) &&
                             (py >= -(px - playSize) * (playSize / (2 * playSize)) + playSize / 2)
          if (inTriangle) {
            pixels[i] = Math.round(60 + gradient * 120)
            pixels[i + 1] = Math.round(100 + gradient * 80)
            pixels[i + 2] = Math.round(220 + gradient * 35)
          }
        }
      } else {
        pixels[i] = 0
        pixels[i + 1] = 0
        pixels[i + 2] = 0
        pixels[i + 3] = 0
      }
    }
  }
  return pixels
}

function optionB(width, height) {
  const pixels = new Uint8Array(width * height * 4)
  const scale = width / 100

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const nx = (x - width / 2) / scale
      const ny = (y - height / 2) / scale

      const letterL = (nx >= -22 && nx <= -8 && ny >= -35 && ny <= 35) ||
                      (nx >= -22 && nx <= 3 && ny >= 23 && ny <= 35)
      
      const letterV = (ny <= 35 - Math.abs(nx) * 1.2 && ny >= -35 && Math.abs(nx) <= 25)

      if (letterL || letterV) {
        const dist = Math.sqrt(nx * nx + ny * ny)
        const angle = Math.atan2(ny, nx)
        const gradient = (Math.sin(angle * 3 + dist * 0.1) + 1) / 2

        const r = Math.round(80 + gradient * 100)
        const g = Math.round(130 + gradient * 70)
        const b = Math.round(230 + gradient * 25)
        pixels[i] = r
        pixels[i + 1] = g
        pixels[i + 2] = b
        pixels[i + 3] = 255
      } else {
        pixels[i] = 0
        pixels[i + 1] = 0
        pixels[i + 2] = 0
        pixels[i + 3] = 0
      }
    }
  }
  return pixels
}

function optionC(width, height) {
  const pixels = new Uint8Array(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  const scale = width / 120

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const nx = (x - cx) / scale
      const ny = (y - cy) / scale

      let isActive = false
      let alpha = 0

      for (let wave = 0; wave < 3; wave++) {
        const waveY = Math.sin(nx * 0.15 + wave * 2) * 20
        const waveWidth = 8 - wave * 2
        const dist = Math.abs(ny - waveY)
        
        if (dist <= waveWidth) {
          isActive = true
          alpha = Math.max(alpha, 1 - dist / waveWidth)
        }
      }

      if (isActive && alpha > 0.1) {
        const gradient = (Math.sin(nx * 0.1) + 1) / 2
        const finalAlpha = Math.round(alpha * 255)
        
        const r = Math.round(50 + gradient * 150)
        const g = Math.round(100 + gradient * 100)
        const b = Math.round(200 + gradient * 55)
        
        pixels[i] = r
        pixels[i + 1] = g
        pixels[i + 2] = b
        pixels[i + 3] = finalAlpha
      } else {
        pixels[i] = 0
        pixels[i + 1] = 0
        pixels[i + 2] = 0
        pixels[i + 3] = 0
      }
    }
  }
  return pixels
}

async function generateIcons(optionFunc, optionName, description) {
  console.log(`\n=== 生成方案 ${optionName}: ${description} ===\n`)

  mkdirSync(BUILD_DIR, { recursive: true })

  const baseSize = 512
  console.log(`[1/3] 生成 ${baseSize}x${baseSize} 母版图标...`)
  const masterPixels = optionFunc(baseSize, baseSize)

  const targetSizes = [512, 256, 128, 64, 48, 32, 24, 16]
  const result = {}
  const icoPngMap = {}

  console.log(`[2/3] 生成各尺寸透明 PNG...`)
  for (const s of targetSizes) {
    const resized = await sharp(masterPixels, {
      raw: { width: baseSize, height: baseSize, channels: 4 }
    })
      .resize(s, s, { kernel: sharp.kernel.lanczos3, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, palette: false })
      .toBuffer()

    const outName = `icon-${optionName}-${s}.png`
    result[outName] = resized
    console.log(`  ✅ ${outName} (${s}x${s})`)

    if (s <= 256) {
      icoPngMap[s] = resized
    }
  }

  console.log(`[3/3] 生成 Windows ICO 文件...`)
  const icoBuffer = generateMultiSizeICO(icoPngMap)
  const icoName = `icon-${optionName}.ico`
  result[icoName] = icoBuffer
  console.log(`  ✅ ${icoName} (含${Object.keys(icoPngMap).length}种尺寸)`)

  for (const [name, buffer] of Object.entries(result)) {
    try {
      writeFileSync(resolve(BUILD_DIR, name), buffer)
    } catch (e) {
      console.log(`  ⚠️ build/${name} - 写入失败: ${e.message}`)
    }
  }

  return result
}

async function main() {
  console.log('=== mplay 图标设计方案生成器 ===\n')
  console.log('基于行业调研，提供3个设计方案：\n')

  console.log('方案 A - 圆形播放按钮风格')
  console.log('  参考：Plex、YouTube Music、Buddy')
  console.log('  设计特点：圆形背景 + 内嵌播放三角形，蓝紫渐变配色\n')

  console.log('方案 B - LV字母标志风格')
  console.log('  参考：Jellyfin、VLC、现代字母logo')
  console.log('  设计特点：LV字母组合，玻璃质感渐变，简洁现代\n')

  console.log('方案 C - 媒体波浪风格')
  console.log('  参考：QQ音乐、网易云音乐、Spotify')
  console.log('  设计特点：声波/波浪图形，抽象媒体概念，流动感强\n')

  await generateIcons(optionA, 'A', '圆形播放按钮风格')
  await generateIcons(optionB, 'B', 'LV字母标志风格')
  await generateIcons(optionC, 'C', '媒体波浪风格')

  console.log('\n=== 所有方案生成完成 ===\n')
  console.log('生成的图标文件位于 build/ 目录：')
  console.log('  - 方案A: icon-A-*.png, icon-A.ico')
  console.log('  - 方案B: icon-B-*.png, icon-B.ico')
  console.log('  - 方案C: icon-C-*.png, icon-C.ico')
  console.log('\n请选择一个方案，然后运行以下命令应用：')
  console.log('  npm run prepare:icons')
}

main().catch(err => {
  console.error('❌ 图标生成失败:', err.message)
  process.exit(1)
})
