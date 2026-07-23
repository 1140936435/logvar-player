import { writeFileSync, existsSync, mkdirSync, createWriteStream } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'
import sharp from 'sharp'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = 'G:\\dev\\logvar-player'
console.log(`[debug] ROOT: ${ROOT}`)
const ICON_DIR = resolve(ROOT, 'assets/icon')
const BUILD_DIR = resolve(ROOT, 'build')

console.log(`[debug] ICON_DIR: ${ICON_DIR}`)
console.log(`[debug] BUILD_DIR: ${BUILD_DIR}`)

if (!existsSync(ICON_DIR)) mkdirSync(ICON_DIR, { recursive: true })
if (!existsSync(BUILD_DIR)) mkdirSync(BUILD_DIR, { recursive: true })

const API_BASE = 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image'

const prompts = [
  'APP icon, square rounded corners, iOS 17 liquid frosted glass style, video player theme, centered minimalist white play triangle symbol, translucent frosted glass texture, subtle gaussian blur, delicate highlight edges, faint ambient reflection, low saturation fresh colors, floating soft glow shadow, minimalist flat design, clean premium aesthetic, no text, no watermark, no placeholder, 8K ultra HD, centered composition, isolated icon body, transparent background with alpha channel, suitable for Windows and macOS software icons, refined lighting, soft diffuse reflection',
  'APP icon, square rounded corners, iOS 17 liquid glass morph style, video player, centered play button triangle, semi-transparent white glass, gradient sky blue to lavender inside the icon body, glass refraction effect, thin highlight edge, soft glow, minimal clean design, no text, no watermark, premium quality, 8K, centered, isolated icon body, transparent background with alpha channel, Windows macOS compatible',
  'APP icon, square with rounded corners, iOS 17 glassmorphism style, video player icon, centered play triangle symbol, frosted glass body, gradient light blue purple inside the icon, subtle reflections, smooth edges, soft shadow, minimalist modern design, no text, no words, no watermark, high resolution, professional icon, centered composition, transparent background with alpha channel',
  'APP icon, rounded square, iOS 17 liquid crystal glass style, video player, centered white play triangle, transparent glass material, gradient pale blue to violet inside the icon body, delicate highlight on top, soft ambient glow, clean simple design, no text elements, no watermark, 8K quality, isolated icon body, transparent background with alpha channel, cross-platform icon'
]

async function fetchJSON(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function downloadFile(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(dest))
}

async function validateImage(path) {
  try {
    const metadata = await sharp(path).metadata()
    const isValid = metadata.width > 0 && metadata.height > 0 && metadata.width === metadata.height
    if (!isValid) throw new Error(`Invalid image: ${JSON.stringify(metadata)}`)
    if (!metadata.hasAlpha) throw new Error('Image has no alpha channel')
    
    const buffer = await sharp(path).resize(100, 100).ensureAlpha().raw().toBuffer()
    const pixelCount = buffer.length / 4
    const whitePixelRatio = buffer.filter((_, i) => i % 4 === 0 && buffer[i] > 240 && buffer[i+1] > 240 && buffer[i+2] > 240).length / pixelCount
    const textIndicatorRatio = buffer.filter((_, i) => i % 4 === 0 && buffer[i] < 50 && buffer[i+1] < 50 && buffer[i+2] < 50).length / pixelCount
    const transparentPixelRatio = buffer.filter((_, i) => i % 4 === 3 && buffer[i] < 250).length / pixelCount
    
    if (whitePixelRatio > 0.8) throw new Error('Image is mostly white - likely placeholder')
    if (textIndicatorRatio > 0.4) throw new Error('High dark pixel ratio - likely contains text')
    if (transparentPixelRatio < 0.05) throw new Error('Image background is not transparent')
    
    return true
  } catch (err) {
    console.error(`[validate] ${err.message}`)
    return false
  }
}

async function generateIcon(prompt, index) {
  const encodedPrompt = encodeURIComponent(prompt)
  const url = `${API_BASE}?prompt=${encodedPrompt}&image_size=square`
  
  console.log(`[${index+1}/4] Generating icon...`)
  
  let attempts = 0
  const maxAttempts = 5
  
  while (attempts < maxAttempts) {
    attempts++
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      
      const contentType = res.headers.get('content-type') || ''
      let imageUrl = ''
      
      if (contentType.includes('application/json')) {
        const result = await res.json()
        imageUrl = result.url || result.imageUrl || result.data?.url
        if (!imageUrl) {
          console.warn(`[${index+1}] Attempt ${attempts}: No image URL in JSON response`)
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
      } else if (contentType.includes('image/')) {
        imageUrl = url
      } else {
        console.warn(`[${index+1}] Attempt ${attempts}: Unknown content-type: ${contentType}`)
        await new Promise(r => setTimeout(r, 1000))
        continue
      }
      
      const tempPath = resolve(ICON_DIR, `icon-temp-${index}.png`)
      
      if (contentType.includes('image/')) {
        const arrayBuffer = await res.arrayBuffer()
        writeFileSync(tempPath, Buffer.from(arrayBuffer))
      } else {
        await downloadFile(imageUrl, tempPath)
      }
      
      const isValid = await validateImage(tempPath)
      if (!isValid) {
        console.warn(`[${index+1}] Attempt ${attempts}: Image validation failed`)
        await new Promise(r => setTimeout(r, 1500))
        continue
      }
      
      const metadata = await sharp(tempPath).metadata()
      console.log(`[${index+1}] ✅ Validated: ${metadata.width}x${metadata.height}, ${metadata.format}`)
      
      return tempPath
    } catch (err) {
      console.error(`[${index+1}] Attempt ${attempts} failed: ${err.message}`)
      await new Promise(r => setTimeout(r, 1000))
    }
  }
  
  throw new Error(`Failed to generate valid icon after ${maxAttempts} attempts`)
}

async function generateAllIcons() {
  const masterPaths = []
  
  for (let i = 0; i < prompts.length; i++) {
    const masterPath = await generateIcon(prompts[i], i)
    masterPaths.push(masterPath)
  }
  
  const bestMaster = masterPaths[0]
  console.log(`\nUsing first generated icon as master: ${bestMaster}`)
  
  await generateSizes(bestMaster)
  
  for (const path of masterPaths) {
    try {
      if (path !== bestMaster) {
        const fs = await import('fs')
        fs.unlinkSync(path)
      }
    } catch {}
  }
  
  console.log('\n✅ All icons generated successfully!')
}

async function generateSizes(masterPath) {
  const sizes = [512, 256, 128, 64, 32, 16]
  
  for (const size of sizes) {
    const dest = resolve(ICON_DIR, `icon-${size}.png`)
    await sharp(masterPath)
      .resize(size, size, { kernel: sharp.kernel.lanczos3 })
      .ensureAlpha()
      .png({ compressionLevel: 9 })
      .toFile(dest)
    console.log(`  Generated ${size}x${size}`)
  }
  
  await sharp(masterPath)
    .resize(256, 256, { kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toFile(resolve(ICON_DIR, 'icon.png'))
  
  await sharp(masterPath)
    .resize(256, 256, { kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toFile(resolve(BUILD_DIR, 'icon.png'))
  
  await sharp(masterPath)
    .resize(512, 512, { kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toFile(resolve(BUILD_DIR, 'icon-512.png'))
  
  await sharp(masterPath)
    .resize(32, 32, { kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toFile(resolve(BUILD_DIR, 'icon-32.png'))
  
  await sharp(masterPath)
    .resize(16, 16, { kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toFile(resolve(BUILD_DIR, 'icon-16.png'))
  
  await generateICO(resolve(ICON_DIR, 'icon-256.png'))
}

async function generateICO(pngPath) {
  const pngBuffer = await sharp(pngPath).toBuffer()
  
  const icoHeader = Buffer.alloc(6)
  icoHeader.writeUInt16LE(0, 0)
  icoHeader.writeUInt16LE(1, 2)
  icoHeader.writeUInt16LE(1, 4)
  
  const dirEntry = Buffer.alloc(16)
  dirEntry.writeUInt8(0, 0)
  dirEntry.writeUInt8(0, 1)
  dirEntry.writeUInt8(0, 2)
  dirEntry.writeUInt8(0, 3)
  dirEntry.writeUInt16LE(1, 4)
  dirEntry.writeUInt16LE(32, 6)
  dirEntry.writeUInt32LE(pngBuffer.length, 8)
  dirEntry.writeUInt32LE(22, 12)
  
  const icoBuffer = Buffer.concat([icoHeader, dirEntry, pngBuffer])
  writeFileSync(resolve(BUILD_DIR, 'icon.ico'), icoBuffer)
  console.log('  Generated icon.ico')
}

generateAllIcons().catch(err => {
  console.error('❌ Failed:', err.message)
  process.exit(1)
})
