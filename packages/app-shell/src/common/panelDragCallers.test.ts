/**
 * 面板分隔条都走 startPanelDrag 的守门用例（纯文本检查，用 fs 读源码，不经打包器）。
 *
 * 从前各分隔条自己在 document 上听 mousemove / mouseup：指针一进 iframe（右侧面板里的小组件、对话里的
 * ```interactive 块）事件就归了 iframe，往那边拖一卡一卡的，在 iframe 上松开后分隔条还粘着指针。手势收进
 * `common/panelDrag.ts` 之后，哪个调用方再自己挂一遍监听，这个 bug 就在它那里回来 —— 单测替不了真 iframe，
 * 只能在源码上拴住。
 *
 *   PDC-1 四个调用方（右侧面板、会话面板、左侧栏、底部终端）都调 startPanelDrag，且没有一个自己
 *         `addEventListener('mousemove'` / `addEventListener('mouseup'`
 *   PDC-2 SidebarResizeHandle 里不再有 `pointerEvents`（逐个给 iframe 关命中的旧办法已删 —— 遮罩替了它）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../../..')

const CALLERS = [
  'apps/desktop/src/renderer/src/components/browser/BrowserResizeHandle.tsx',
  'packages/app-shell/src/panel/SessionPanel.tsx',
  'packages/app-shell/src/sidebar/SidebarResizeHandle.tsx',
  'apps/desktop/src/renderer/src/components/terminal/BottomPanel.tsx'
]

const source = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8')

describe('panel dividers use startPanelDrag', () => {
  it.each(CALLERS)('PDC-1 %s', (rel) => {
    const text = source(rel)
    expect(text).toMatch(/\bstartPanelDrag\s*\(/)
    expect(text).not.toMatch(/addEventListener\(\s*['"]mousemove['"]/)
    expect(text).not.toMatch(/addEventListener\(\s*['"]mouseup['"]/)
  })

  it('PDC-2 SidebarResizeHandle no longer touches pointerEvents', () => {
    expect(source('packages/app-shell/src/sidebar/SidebarResizeHandle.tsx')).not.toContain(
      'pointerEvents'
    )
  })
})
