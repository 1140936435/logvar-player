import { defineConfig } from 'vitest/config'

// 仅测试主进程中的纯函数模块（src/main/lib/**）。
// 这些模块不依赖 electron / 文件系统，可在 Node 环境下直接单测。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true
  }
})
