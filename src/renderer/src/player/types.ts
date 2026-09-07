export interface SubtitleCue {
  start: number
  end: number
  text: string
}

export interface SubtitleTrack {
  index: number
  label: string
  language: string
  url: string
}

export interface FolderVideo {
  name: string
  path: string
}

export interface PlayerContextMenuState {
  x: number
  y: number
  visible: boolean
}