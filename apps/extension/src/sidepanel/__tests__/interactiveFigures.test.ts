/**
 * EXT-1 —— Chrome 侧边栏**不开** ```interactive 交互图。
 *
 * chat-ui 的 CodeBlock 只在 `ChatHostValue.interactiveFigures === true` 时才把交互块挂进沙箱
 * iframe；否则显示源码并说明「只在桌面端运行」。扩展不能开它：MV3 扩展页的 CSP 禁内联脚本，
 * srcdoc 又继承宿主页面的 CSP —— 块在侧边栏里根本跑不起来，开了只会得到一块空白 iframe。
 * 宿主值是 `sidepanel/App.tsx` 里 `useMemo<ChatHostValue>` 拼出来的那一份，所以这里做的是源码扫描：
 * 扩展自己的源码里（测试除外）一处都不许出现 `interactiveFigures`。
 *
 * 源码用 `import.meta.glob(..., { query: '?raw' })` 读（扩展的 tsconfig 只有 chrome / vite 的类型，
 * 没有 node:fs）。在桌面的 vitest 配置里跑（node 环境），与同目录的 tabSelection.test.ts 一样。
 */
import { describe, expect, it } from 'vitest'

const SOURCES = import.meta.glob<string>('../../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true
})

/** 扩展的产品源码（测试文件与 __tests__ 目录除外） */
const productSources = (): Array<[string, string]> =>
  Object.entries(SOURCES).filter(([path]) => !/__tests__|\.test\.tsx?$/.test(path))

describe('Chrome 侧边栏的宿主值（EXT-1）', () => {
  it('EXT-1 侧边栏把 ChatHostProvider 的值交给 chat-ui，而扩展源码里一处都没有 interactiveFigures', () => {
    const sources = productSources()
    // 正控制组：确实扫到了侧边栏那份宿主值（glob 落空时下面的「没有」恒绿）
    // glob 的键是相对本文件的路径：侧边栏的 App.tsx 就是 `../App.tsx`
    const app = sources.find(([path]) => path === '../App.tsx')
    expect(app, '没扫到 sidepanel/App.tsx').toBeDefined()
    expect(app![1]).toContain('useMemo<ChatHostValue>')
    expect(app![1]).toContain('<ChatHostProvider value={host}>')
    expect(sources.length).toBeGreaterThan(5)

    const offenders = sources.filter(([, text]) => text.includes('interactiveFigures'))
    expect(offenders.map(([path]) => path)).toEqual([])
  })
})
