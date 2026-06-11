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
