import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scanRoots = ['assets/icon', 'build', 'src/renderer/public', '.generated/icons']

function collectIconFiles(directory) {
  const absoluteDirectory = resolve(root, directory)
  if (!existsSync(absoluteDirectory)) return []
  return readdirSync(absoluteDirectory)
    .filter((name) => ['.png', '.ico'].includes(extname(name).toLowerCase()))
    .map((name) => join(absoluteDirectory, name))
}

async function inspectIcon(file) {
  const input = readFileSync(file)
  const metadata = await sharp(input).metadata()
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const stats = { transparent: 0, translucent: 0, opaque: 0, opaqueWhite: 0 }

  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset]
    const green = data[offset + 1]
    const blue = data[offset + 2]
    const alpha = data[offset + 3]

    if (alpha === 0) stats.transparent++
    else if (alpha === 255) stats.opaque++
    else stats.translucent++

    if (alpha === 255 && red >= 250 && green >= 250 && blue >= 250) {
      stats.opaqueWhite++
    }
  }

  const pixelAt = (x, y) => {
    const offset = (y * info.width + x) * info.channels
    return Array.from(data.subarray(offset, offset + 4))
  }

  return {
    file: relative(root, file).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(input).digest('hex'),
    format: metadata.format,
    width: info.width,
    height: info.height,
    sourceHasAlpha: metadata.hasAlpha,
    ...stats,
    corners: [
      pixelAt(0, 0),
      pixelAt(info.width - 1, 0),
      pixelAt(0, info.height - 1),
      pixelAt(info.width - 1, info.height - 1)
    ]
  }
}

const files = scanRoots.flatMap(collectIconFiles).sort()
const results = []

for (const file of files) {
  try {
    results.push(await inspectIcon(file))
  } catch (error) {
    results.push({
      file: relative(root, file).replaceAll('\\', '/'),
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

const report = JSON.stringify(results, null, 2)
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='))

if (outputArgument) {
  writeFileSync(resolve(outputArgument.slice('--output='.length)), report, 'utf8')
} else {
  console.log(report)
}
