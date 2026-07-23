import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')

const SOURCE_DIR = resolve(ROOT, 'assets/icon')
const BUILD_DIR = resolve(ROOT, 'build')

const WHITE_THRESHOLD = 240
const EDGE_THRESHOLD = 200

function makeTransparent(rawBuffer, width, height) {
  const output = Buffer.alloc(rawBuffer.length)
  for (let i = 0; i < rawBuffer.length; i += 4) {
    const r = rawBuffer[i]
    const g = rawBuffer[i + 1]
    const b = rawBuffer[i + 2]
    const a = rawBuffer[i + 3]

    if (r > WHITE_THRESHOLD && g > WHITE_THRESHOLD && b > WHITE_THRESHOLD) {
      output[i] = 0
      output[i + 1] = 0
      output[i + 2] = 0
      output[i + 3] = 0
    } else if (r > EDGE_THRESHOLD && g > EDGE_THRESHOLD && b > EDGE_THRESHOLD) {
      const whiteness = Math.min(r, g, b) / 255
      const newAlpha = Math.round(a * (1 - whiteness))
      const factor = newAlpha / 255
      output[i] = Math.round(r * factor)
      output[i + 1] = Math.round(g * factor)
      output[i + 2] = Math.round(b * factor)
      output[i + 3] = newAlpha
    } else {
      output[i] = r
      output[i + 1] = g
      output[i + 2] = b
      output[i + 3] = a
    }
  }
  return output
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

async function processIcon(sourcePath) {
  console.log('=== 图标专业抠图处理 ===\n')
  console.log(`源文件: ${sourcePath}`)
  console.log(`输出目录: ${BUILD_DIR}\n`)

  mkdirSync(BUILD_DIR, { recursive: true })

  const metadata = await sharp(sourcePath).metadata()
  console.log(`[1/5] 读取母版图标`)
  console.log(`  格式: ${metadata.format}`)
  console.log(`  尺寸: ${metadata.width}x${metadata.height}`)
  console.log(`  通道: ${metadata.channels} (含Alpha: ${metadata.hasAlpha})`)

  const { data: rawData, info } = await sharp(sourcePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  console.log(`[2/5] 透明化处理（像素级精确抠图）...`)
  const transparentData = makeTransparent(rawData, info.width, info.height)

  const targetSizes = [512, 256, 128, 64, 48, 32, 24, 16]
  const result = {}
  const icoPngMap = {}

  console.log(`[3/5] 生成各尺寸图标（高质量Lanczos3缩放）...`)
  for (const s of targetSizes) {
    const resized = await sharp(transparentData, {
      raw: { width: info.width, height: info.height, channels: 4 }
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

  console.log(`[4/5] 生成Windows ICO文件...`)
  const icoBuffer = generateMultiSizeICO(icoPngMap)
  result['icon.ico'] = icoBuffer
  console.log(`  ✅ icon.ico (含${Object.keys(icoPngMap).length}种尺寸)`)

  console.log(`[5/5] 写入文件...`)
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

  console.log('\n=== 图标处理完成 ===')
  return result
}

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法: node scripts/process-icon.mjs <源图标文件路径>')
  process.exit(1)
}

const sourcePath = resolve(ROOT, args[0])
if (!existsSync(sourcePath)) {
  console.error(`错误: 文件不存在 - ${sourcePath}`)
  process.exit(1)
}

processIcon(sourcePath).catch(err => {
  console.error('❌ 图标处理失败:', err.message)
  process.exit(1)
})
