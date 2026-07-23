const { resolve } = require('path')
const { defineConfig, externalizeDepsPlugin } = require('electron-vite')
const react = require('@vitejs/plugin-react').default
const tailwindcss = require('@tailwindcss/vite').default
const { copyFileSync, existsSync, mkdirSync } = require('fs')

module.exports = defineConfig({
  main: {
    build: {
      minify: 'esbuild',
      emptyOutDir: false,
      rollupOptions: {
        output: {
          entryFileNames: 'main.js'
        }
      }
    },
    plugins: [
      externalizeDepsPlugin(),
      {
        name: 'copy-assets',
        closeBundle() {
          const copy = (src, dest) => {
            const d = resolve(__dirname, dest)
            const dd = resolve(d, '..')
            if (!existsSync(dd)) mkdirSync(dd, { recursive: true })
            if (existsSync(src)) {
              try {
                copyFileSync(src, d)
              } catch (e) {
                // 沙箱/杀软等导致文件无法覆盖时，只要目标位置不是首次创建就跳过
                console.warn(`[copy-assets] 无法复制 ${src} -> ${dest}: ${e.message}`)
              }
            }
          }
          copy('src/main/log-window.html', 'out/main/log-window.html')
          copy('tools/dwm-helper.exe', 'out/tools/dwm-helper.exe')
        }
      }
    ]
  },
  preload: {
    build: {
      emptyOutDir: false,
      rollupOptions: {
        output: {
          entryFileNames: 'preload.js'
        }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    publicDir: resolve('build'),
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      minify: 'esbuild',
      target: 'es2020',
      emptyOutDir: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
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
