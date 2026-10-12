import { defineConfig } from 'vitest/config'
import unitConfig from './vitest.config'

/**
 * 命令风险分类探针专用的运行配置：`npm run probe:classifier`。
 *
 * - include 只有 `e2e/live/classifier.probe.ts` 这一个字面路径：同目录会读真实实例数据库的探针
 *   （`probe.ts` / `review.probe.ts` / `subsession.probe.ts`）无论怎么传参都跑不到。
 * - 输入只有 `SHUVIX_PROBE_*` 变量（见探针文件头），不起应用、不读应用数据。
 * - 共享包的路径别名照抄单测配置（worktree 里不这么做会跑到主检出的包源码）。
 */
export default defineConfig({
  resolve: unitConfig.resolve,
  server: unitConfig.server,
  test: {
    include: ['e2e/live/classifier.probe.ts'],
    environment: 'node',
    testTimeout: 15 * 60 * 1000,
    fileParallelism: false,
    reporters: ['default']
  }
})
