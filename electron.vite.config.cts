const { resolve } = require('path')
const { defineConfig, externalizeDepsPlugin } = require('electron-vite')
const react = require('@vitejs/plugin-react').default
const tailwindcss = require('@tailwindcss/vite').default
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')

// 生产构建注入的 CSP（仅写入 out/renderer/index.html，dev 走 vite server 不受影响）。
// script-src 'self' 是 XSS 防线核心；style 需 unsafe-inline（framer-motion 写 style 属性）；
// img/media 放行自定义图片协议、file:、本地流代理与远程源
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: file: http: https: jellyfin-image: emby-image: douban-img: local-file:",
  "media-src 'self' blob: data: file: http: https: local-file:",
  "connect-src 'self' blob: data: file: http: https: ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ')

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
          const copy = (src: string, dest: string) => {
            const d = resolve(__dirname, dest)
            const dd = resolve(d, '..')
            if (!existsSync(dd)) mkdirSync(dd, { recursive: true })
            if (existsSync(src)) {
              try {
                copyFileSync(src, d)
              } catch (e: unknown) {
                // 沙箱/杀软等导致文件无法覆盖时，只要目标位置不是首次创建就跳过
                console.warn(`[copy-assets] 无法复制 ${src} -> ${dest}: ${(e as Error).message}`)
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
        input: {
          preload: resolve('src/preload/index.ts'),
          'log-preload': resolve('src/preload/log-preload.ts')
        },
        output: {
          entryFileNames: '[name].js'
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
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'inject-prod-csp',
        closeBundle() {
          // 只在生产产物注入 CSP meta；dev 环境由 vite server 提供页面，
          // 注入会破坏 HMR / react-refresh，因此不处理
          const htmlPath = resolve(__dirname, 'out/renderer/index.html')
          if (!existsSync(htmlPath)) return
          let html = readFileSync(htmlPath, 'utf-8')
          if (html.includes('Content-Security-Policy')) return
          html = html.replace(
            '<head>',
            `<head>\n    <meta http-equiv="Content-Security-Policy" content="${PROD_CSP}" />`
          )
          writeFileSync(htmlPath, html)
        }
      }
    ],
    build: {
      minify: 'esbuild',
      target: 'es2020',
      emptyOutDir: false,
      rollupOptions: {
        output: {
          manualChunks(id: string) {
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
