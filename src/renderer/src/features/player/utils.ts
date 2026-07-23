import type { SubtitleCue } from './types'

export function parseVTT(vtt: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const lines = vtt.split(/\r?\n/)
  let index = 0

  while (
    index < lines.length &&
    (lines[index].trim() === '' ||
      lines[index].startsWith('WEBVTT') ||
      lines[index].startsWith('Kind:') ||
      lines[index].startsWith('Language:'))
  ) {
    index++
  }

  const timePattern = /^(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/

  const parseTimestamp = (value: string): number => {
    const parts = value.split(':')
    const seconds = parts[2].split(/[.,]/)
    return (
      parseInt(parts[0]) * 3600 +
      parseInt(parts[1]) * 60 +
      parseInt(seconds[0]) +
      parseInt(seconds[1]) / 1000
    )
  }

  while (index < lines.length) {
    const match = lines[index].trim().match(timePattern)
    if (!match) {
      index++
      continue
    }

    const start = parseTimestamp(match[1])
    const end = parseTimestamp(match[2])
    const textLines: string[] = []
    index++

    while (index < lines.length && lines[index].trim() !== '') {
      textLines.push(lines[index].trim())
      index++
    }

    const text = textLines.join('\n').replace(/<[^>]+>/g, '').trim()
    if (text) cues.push({ start, end, text })
  }

  return cues
}

export function formatTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const remainingSeconds = Math.floor(safeSeconds % 60)

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  if (safeBytes >= 1e9) return `${(safeBytes / 1e9).toFixed(1)} GB`
  if (safeBytes >= 1e6) return `${(safeBytes / 1e6).toFixed(1)} MB`
  if (safeBytes >= 1e3) return `${(safeBytes / 1e3).toFixed(1)} KB`
  return `${safeBytes} B`
}

export function cleanTitleForMatch(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/\[.*?\]/g, '')
    .replace(/【.*?】/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\d{4}[./-]\d{2}[./-]\d{2}/g, '')
    .replace(/1080[Pp]|720[Pp]|4K|BD|HD|WEB|DL/gi, '')
    .replace(/x264|x265|H264|HEVC|AVC|AAC|FLAC|AUTO/gi, '')
    .trim()
}

export function extractSeriesNameFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/E?P?\s*\d{1,3}/gi, '')
    .replace(/第\s*\d{1,3}\s*[话集]/g, '')
    .replace(/S\d+E\d{1,3}/gi, '')
    .replace(/\s*-\s*\d{1,3}/, '')
    .replace(/\[.*?\]/g, '')
    .replace(/【.*?】/g, '')
    .replace(/\(.*?\)/g, '')
    .trim()
}
