import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync, existsSync, mkdirSync } from 'fs'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      // 复制 log-window.html 到输出目录
      {
        name: 'copy-log-window-html',
        closeBundle() {
          const src = resolve(__dirname, 'src/main/log-window.html')
          const destDir = resolve(__dirname, 'out/main')
          const dest = resolve(destDir, 'log-window.html')
          if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
          if (existsSync(src)) {
            copyFileSync(src, dest)
            console.log('Copied log-window.html to out/main/')
          }
          // 复制 disable-dwm.ps1
          const psSrc = resolve(__dirname, 'disable-dwm.ps1')
          const psDest = resolve(destDir, 'disable-dwm.ps1')
          if (existsSync(psSrc)) {
            copyFileSync(psSrc, psDest)
            console.log('Copied disable-dwm.ps1 to out/main/')
          }
          // 复制 dwm-helper.exe
          const exeSrc = resolve(__dirname, 'tools/dwm-helper.exe')
          const exeDest = resolve(__dirname, 'out/tools/dwm-helper.exe')
          if (existsSync(exeSrc)) {
            const exeDir = resolve(__dirname, 'out/tools')
            if (!existsSync(exeDir)) mkdirSync(exeDir, { recursive: true })
            copyFileSync(exeSrc, exeDest)
            console.log('Copied dwm-helper.exe to out/tools/')
          }
        }
      }
    ]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
