/**
 * 测试缩略图生成
 * 用法：node test-thumbnail.js <video-path>
 */

const { SpriteGenerator } = require('sprite-vtt-generator')
const { join, dirname, basename } = require('path')
const { existsSync, mkdirSync } = require('fs')
const { app } = require('electron')

async function testThumbnail(videoPath) {
  console.log('Testing thumbnail generation for:', videoPath)
  
  const outputDir = join(app.getPath('userData'), 'thumbnails')
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }
  
  const videoName = basename(videoPath, '.mp4')
  
  const spriteGenerator = new SpriteGenerator({
    inputPath: videoPath,
    outputDir: outputDir,
    width: 160,
    height: 90,
    rowCount: 1,
    colCount: 10,
    multiple: false,
    interval: 10,
    thumbnailPrefix: 'thumb',
    webVTT: {
      required: true,
      path: join(outputDir, `${videoName}_thumbnails.vtt`)
    }
  })
  
  try {
    await spriteGenerator.generate()
    console.log('✅ Success!')
    console.log('Sprite:', join(outputDir, `${videoName}_sprite.jpg`))
    console.log('VTT:', join(outputDir, `${videoName}_thumbnails.vtt`))
  } catch (err) {
    console.error('❌ Failed:', err.message)
  }
}

// 从命令行参数获取视频路径
const videoPath = process.argv[2]
if (!videoPath) {
  console.log('Usage: node test-thumbnail.js <video-path>')
  process.exit(1)
}

testThumbnail(videoPath)
