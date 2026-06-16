import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { copyFileSync, existsSync, mkdirSync } from 'fs'

export default defineConfig({
  main: {
    build: {
      minify: 'esbuild'
    },
    plugins: [
      externalizeDepsPlugin(),
      {
        name: 'copy-assets',
        closeBundle() {
          const copy = (src: string, dest: string) => {
            const d = resolve(__dirname, dest)
            const dd = resolve(d, '..')
            if (!existsSync(dd)) mkdirSync(dd, { recursive: true })
            if (existsSync(src)) copyFileSync(src, d)
          }
          copy('src/main/log-window.html', 'out/main/log-window.html')
          copy('tools/dwm-helper.exe', 'out/tools/dwm-helper.exe')
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
    plugins: [react(), tailwindcss()],
    build: {
      minify: 'esbuild',
      target: 'es2020',
      rollupOptions: {
        output: {
          manualChunks(id) {
            // 拆分大型库到单独 chunk，利用浏览器缓存
            if (id.includes('node_modules/framer-motion')) return 'vendor-fm'
            if (id.includes('node_modules/lucide-react')) return 'vendor-icons'
            if (id.includes('node_modules/react-router')) return 'vendor-router'
            if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'vendor-react'
          }
        }
      }
    }
  }
})
