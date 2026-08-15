import { defineConfig } from 'vitest/config'

/**
 * e2e 套件 —— 与单测（vitest.config.ts）完全分离，`npm run test:e2e` 运行。
 *
 * 每个 spec 文件在 beforeAll 里 launchApp() 一个隔离实例（fake HOME + 独立 userData +
 * CDP 端口），文件间串行执行避免端口/实例冲突。前置依赖 electron-vite build 产物
 * （test:e2e 脚本已包含构建步骤）。
 */
export default defineConfig({
  test: {
    include: ['e2e/specs/**/*.e2e.ts'],
    environment: 'node',
    // 串行：同一 CDP 端口,一次只跑一个实例
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
})
