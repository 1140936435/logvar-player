import { describe, expect, it } from 'vitest'
import { extractMediaPathFromArgv } from './argv-media-path'
import { isVideoPath } from '../../shared/video-extensions'

const EXE = 'C:\\Program Files\\环影\\环影.exe'

// 模拟存在性判断：仅接受给出的已知文件
function makeExists(known: string[]): (p: string) => boolean {
  const set = new Set(known.map((p) => p.toLowerCase()))
  return (p: string) => set.has(p.toLowerCase())
}

const KNOWN = ['H:\\dev\\my video.mp4', 'D:\\movies\\a.mkv', 'C:\\vids\\b.MOV']
const exists = makeExists(KNOWN)

describe('extractMediaPathFromArgv', () => {
  it('无参数（仅可执行文件）返回 null', () => {
    expect(extractMediaPathFromArgv([EXE], { exists })).toBeNull()
  })

  it('仅开发态占位（electron .）返回 null', () => {
    expect(extractMediaPathFromArgv([EXE, '.'], { exists })).toBeNull()
  })

  it('仅开关参数返回 null', () => {
    expect(extractMediaPathFromArgv([EXE, '--enable-logging', '-d'], { exists })).toBeNull()
  })

  it('裸路径命中返回原路径', () => {
    expect(extractMediaPathFromArgv([EXE, 'H:\\dev\\my video.mp4'], { exists })).toBe(
      'H:\\dev\\my video.mp4'
    )
  })

  it('带引号路径命中返回剥引号后的路径', () => {
    expect(extractMediaPathFromArgv([EXE, '"H:\\dev\\my video.mp4"'], { exists })).toBe(
      'H:\\dev\\my video.mp4'
    )
  })

  it('扩展名大小写不敏感（.MOV）', () => {
    expect(extractMediaPathFromArgv([EXE, 'C:\\vids\\b.MOV'], { exists })).toBe('C:\\vids\\b.MOV')
  })

  it('file:/// 盘符形式命中，URL 编码解码', () => {
    expect(
      extractMediaPathFromArgv([EXE, 'file:///H:/dev/my%20video.mp4'], { exists })
    ).toBe('H:\\dev\\my video.mp4')
  })

  it('file:// 无前导斜杠形式命中', () => {
    expect(extractMediaPathFromArgv([EXE, 'file://H:/dev/my%20video.mp4'], { exists })).toBe(
      'H:\\dev\\my video.mp4'
    )
  })

  it('file URL 非法编码返回 null', () => {
    expect(extractMediaPathFromArgv([EXE, 'file:///H:/dev/my%zzvideo.mp4'], { exists })).toBeNull()
  })

  it('非视频扩展名返回 null', () => {
    expect(extractMediaPathFromArgv([EXE, 'H:\\dev\\notes.txt'], { exists })).toBeNull()
    expect(extractMediaPathFromArgv([EXE, 'file:///H:/dev/notes.txt'], { exists })).toBeNull()
  })

  it('路径不存在返回 null', () => {
    expect(extractMediaPathFromArgv([EXE, 'H:\\dev\\missing.mp4'], { exists })).toBeNull()
  })

  it('前面混有开关/占位，中间路径命中', () => {
    expect(
      extractMediaPathFromArgv([EXE, '.', '--disable-gpu', 'D:\\movies\\a.mkv'], { exists })
    ).toBe('D:\\movies\\a.mkv')
  })

  it('多个参数时取第一个有效媒体路径', () => {
    expect(
      extractMediaPathFromArgv([EXE, 'D:\\movies\\a.mkv', 'H:\\dev\\my video.mp4'], { exists })
    ).toBe('D:\\movies\\a.mkv')
  })

  it('默认 exists 使用真实文件系统（不存在的路径返回 null）', () => {
    expect(extractMediaPathFromArgv([EXE, 'Z:\\no\\such\\file.mp4'])).toBeNull()
  })
})

describe('isVideoPath', () => {
  it('支持常见扩展名', () => {
    expect(isVideoPath('a.mp4')).toBe(true)
    expect(isVideoPath('a.MKV')).toBe(true)
    expect(isVideoPath('a.m2ts')).toBe(true)
  })

  it('拒绝非视频与无扩展名', () => {
    expect(isVideoPath('a.txt')).toBe(false)
    expect(isVideoPath('a')).toBe(false)
    expect(isVideoPath('a.')).toBe(false)
    expect(isVideoPath('')).toBe(false)
  })
})
