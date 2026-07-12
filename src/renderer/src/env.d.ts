/// <reference types="react" />

// 修复点 1.8: 消除 WindowApi vs Api 双份声明冲突，以 shared/preload-types.ts 里的 Api 为唯一真源
// 修复点 1.1: 移除不存在的 electron-vite/renderer 三斜线引用

import type { Api } from '../../shared/preload-types'

// 修复点 1.20: ImportMeta 必须放在 declare global 里才能作为全局类型生效
// 否则每个模块各自的 ImportMeta 独立声明，main.tsx 的 import.meta.env 依旧爆红
declare global {
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }

  interface ImportMetaEnv {
    readonly PROD: boolean
    readonly DEV: boolean
    readonly MODE: string
  }

  interface Window {
    api: Api
    electron: typeof import('@electron-toolkit/preload').electronAPI
  }
}

export {}
