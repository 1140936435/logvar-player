/**
 * make-transparent-icons.mjs
 *
 * 作用：读取 assets/icon/ 下的原始图标（只读，不修改），
 *       剔除白色/近白色背景像素为透明，生成透明派生资源到 build/。
 *
 * 硬性约束：assets/icon/ 下的原始文件始终只读，不修改、不替换、不编辑。
 *
 * 原理：
 *   - 以 icon-512.png 为母版，确保最高质量。
 *   - 检测每个像素的 RGB 值，若 R>240 && G>240 && B>240（白色/近白色），
 *     将该像素 Alpha 设为 0（完全透明），同时将 RGB 设为 0 避免白边/白底。
 *   - 对边缘像素（200<R,G,B<=240），按白色程度等比降低 Alpha，并同步压暗 RGB。
 *   - 使用 sharp (libvips) 进行高质量缩放，自动正确处理 Alpha 通道，避免 GDI+ 白边问题。
 *   - 生成 Windows 标准多尺寸 ICO（含 16/24/32/48/64/128/256 PNG 数据），完整保留透明通道。
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')

const SOURCE_DIR = resolve(ROOT, 'assets/icon')
const BUILD_DIR = resolve(ROOT, 'build')

// 判定为白色背景的阈值：RGB 各通道均 > 此值则视为白色背景 → 完全透明 + RGB 清零
const WHITE_THRESHOLD = 240
// 边缘软化：RGB 各通道均 > 此值则降低 Alpha（半透明边缘处理）
const EDGE_THRESHOLD = 200

/**
 * 对原始像素数据进行透明化处理：
 * - 白色/近白色像素 → Alpha=0，RGB=0（彻底消除白底/白边根源）
 * - 边缘半透明区 → 按白色程度等比降低 Alpha，RGB 同步压暗
 * - 彩色像素 → 保持不变
 */
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

/**
 * 生成标准 Windows 多尺寸 ICO 文件（PNG-in-ICO，完整保留 Alpha）
 */
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
  console.log('=== 图标透明化处理 ===\n')
  console.log(`源目录: ${SOURCE_DIR}（只读）`)
  console.log(`构建输出: ${BUILD_DIR}\n`)

  mkdirSync(BUILD_DIR, { recursive: true })

  const masterCandidates = ['icon-512.png', 'icon-master.png', 'icon.png', 'icon-256.png']
  let masterSource = null
  for (const name of masterCandidates) {
    const p = resolve(SOURCE_DIR, name)
    if (existsSync(p)) {
      masterSource = name
      break
    }
  }

  if (!masterSource) {
    console.error('错误: 未找到任何母版图标源文件')
    process.exit(1)
  }

  const masterPath = resolve(SOURCE_DIR, masterSource)
  console.log(`[1/4] 读取母版: ${masterSource}`)

  const metadata = await sharp(masterPath).metadata()
  console.log(`  原始尺寸: ${metadata.width}x${metadata.height}, hasAlpha=${metadata.hasAlpha}`)

  const { data: rawData, info } = await sharp(masterPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  console.log(`[2/4] 透明化处理...`)
  const transparentData = makeTransparent(rawData, info.width, info.height)

  const targetSizes = [512, 256, 128, 64, 48, 32, 24, 16]
  const result = {}
  const icoPngMap = {}

  console.log(`[3/4] 生成各尺寸透明 PNG + ICO...`)
  for (const s of targetSizes) {
    const resized = await sharp(transparentData, {
      raw: { width: info.width, height: info.height, channels: 4 }
    })
      .resize(s, s, { kernel: sharp.kernel.lanczos3, fit: 'cover' })
      .png({ compressionLevel: 9, palette: false })
      .toBuffer()

    const outName = s === 512 ? 'icon-512.png' : `icon-${s}.png`
    result[outName] = resized

    if (s <= 256) {
      icoPngMap[s] = resized
    }

    if (s === 256) {
      result['icon.png'] = resized
    }
  }

  const icoBuffer = generateMultiSizeICO(icoPngMap)
  result['icon.ico'] = icoBuffer

  console.log(`[4/4] 写入 build/ ...`)
  for (const [name, buffer] of Object.entries(result)) {
    try {
      writeFileSync(resolve(BUILD_DIR, name), buffer)
      console.log(`  ✅ build/${name} (${buffer.length} bytes)`)
    } catch (e) {
      console.log(`  ⚠️ build/${name} - 写入失败: ${e.message}`)
    }
  }

  // 验证透明通道
  console.log('\n[验证] 检查透明通道...')
  for (const [name, buffer] of Object.entries(result)) {
    if (name === 'icon.ico') continue
    const meta = await sharp(buffer).metadata()
    const status = meta.hasAlpha ? '✅ 含 Alpha' : '❌ 无 Alpha'
    console.log(`  ${name}: ${meta.width}x${meta.height}, ${status}`)
  }

  console.log('\n=== 透明化处理完成 ===')
}

main().catch(err => {
  console.error('❌ 透明化处理失败:', err.message)
  process.exit(1)
})
