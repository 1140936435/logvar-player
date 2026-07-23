import { build } from 'electron-builder'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')

async function main() {
  console.log('=== 使用 electron-builder API 构建 ===')
  console.log(`项目目录: ${ROOT}\n`)

  try {
    const result = await build({
      config: {
        appId: 'com.mplay.player',
        productName: 'mplay',
        directories: {
          buildResources: 'build',
          output: 'C:\\Temp\\logvar-output'
        },
        files: [
          '!**/.vscode/*',
          '!src/**',
          '!electron.vite.config.*',
          '!{.eslintignore,.eslintrc.cjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
          '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}',
          '!{.gitignore,*.py,*.txt,*.cmd,*.bat,*.sh}',
          '!tools/**',
          '!docs/**',
          '!temp/**',
          '!mpv/**',
          '!resources/**',
          '!logvar-player/**',
          '!.qoder/**',
          '!dist*/**',
          '!assets/icon/**',
          '!scripts/**'
        ],
        asarUnpack: ['out/tools/**'],
        extraResources: [
          {
            from: 'build',
            to: 'icon',
            filter: ['icon-256.png', 'icon-32.png', 'icon-512.png', 'icon-128.png', 'icon-64.png', 'icon-16.png', 'icon.png', 'icon.ico']
          }
        ],
        win: {
          executableName: 'mplay',
          icon: 'build/icon.ico',
          target: [{ target: 'nsis', arch: ['x64'] }]
        },
        nsis: {
          artifactName: '${productName}-${version}-setup.${ext}',
          shortcutName: '${productName}',
          uninstallDisplayName: '${productName}',
          createDesktopShortcut: 'always',
          oneClick: false,
          allowToChangeInstallationDirectory: true
        }
      },
      projectDir: ROOT
    })

    console.log('\n=== 构建成功 ===')
    console.log('输出文件:', result)

  } catch (err) {
    console.error('\n❌ 构建失败:', err.message)
    process.exit(1)
  }
}

main()
