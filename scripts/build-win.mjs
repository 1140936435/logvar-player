import { execSync } from 'child_process'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = resolve(__dirname, '..')

const TEMP_DIR = resolve('C:\\Temp\\logvar-build')

function run(cmd, options = {}) {
  console.log(`> ${cmd}`)
  return execSync(cmd, { stdio: 'inherit', ...options })
}

function main() {
  console.log('=== 环影 Windows 构建脚本 ===')
  console.log(`项目目录: ${ROOT}`)
  console.log(`临时构建目录: ${TEMP_DIR}\n`)

  try {
    console.log('[1/5] 清理旧构建文件...')
    if (existsSync(TEMP_DIR)) {
      rmSync(TEMP_DIR, { recursive: true, force: true })
      console.log('  ✅ 已清理临时目录')
    }

    console.log('[2/5] 创建临时目录结构...')
    mkdirSync(resolve(TEMP_DIR, 'src'), { recursive: true })
    mkdirSync(resolve(TEMP_DIR, 'out'), { recursive: true })
    mkdirSync(resolve(TEMP_DIR, 'build'), { recursive: true })
    mkdirSync(resolve(TEMP_DIR, 'assets'), { recursive: true })
    console.log('  ✅ 临时目录结构创建成功')

    console.log('[3/5] 复制项目文件到临时目录...')
    run(`xcopy "${ROOT}\\src" "${TEMP_DIR}\\src\\" /E /H /C /R /Y /Q`)
    run(`xcopy "${ROOT}\\out" "${TEMP_DIR}\\out\\" /E /H /C /R /Y /Q`)
    run(`xcopy "${ROOT}\\build" "${TEMP_DIR}\\build\\" /E /H /C /R /Y /Q`)
    run(`xcopy "${ROOT}\\assets" "${TEMP_DIR}\\assets\\" /E /H /C /R /Y /Q`)
    run(`xcopy "${ROOT}\\package.json" "${TEMP_DIR}\\" /Y`)
    run(`xcopy "${ROOT}\\package-lock.json" "${TEMP_DIR}\\" /Y`)
    run(`xcopy "${ROOT}\\electron-builder.yml" "${TEMP_DIR}\\" /Y`)
    run(`xcopy "${ROOT}\\electron.vite.config.cts" "${TEMP_DIR}\\" /Y`)
    run(`xcopy "${ROOT}\\tsconfig.json" "${TEMP_DIR}\\" /Y`)
    run(`xcopy "${ROOT}\\tsconfig.node.json" "${TEMP_DIR}\\" /Y`)
    run(`xcopy "${ROOT}\\tsconfig.web.json" "${TEMP_DIR}\\" /Y`)
    console.log('  ✅ 项目文件复制成功')

    console.log('[4/5] 在临时目录安装依赖...')
    run('npm ci', { cwd: TEMP_DIR })
    console.log('  ✅ 依赖安装成功')

    console.log('[5/5] 在临时目录执行构建和打包...')
    run('npm run build:win', { cwd: TEMP_DIR })
    console.log('  ✅ 打包成功')

    const distSrc = resolve(TEMP_DIR, 'dist')
    const distDest = resolve(ROOT, 'dist')

    console.log(`\n[6/6] 复制安装包到项目目录...`)
    if (existsSync(distDest)) {
      rmSync(distDest, { recursive: true, force: true })
    }
    run(`xcopy "${distSrc}" "${distDest}\\" /E /H /C /R /Y /Q`)
    console.log(`  ✅ 安装包已复制到 ${distDest}`)

    console.log('\n=== 构建完成 ===')
    console.log(`安装包位置: ${distDest}`)

  } catch (err) {
    console.error('\n❌ 构建失败:', err.message)
    process.exit(1)
  }
}

main()
