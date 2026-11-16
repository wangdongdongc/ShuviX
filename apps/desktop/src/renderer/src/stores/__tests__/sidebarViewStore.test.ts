/**
 * 侧栏视图的 store 在没有 `window` 的环境里（node）：初值 `sessions`，`setView` 不抛。
 * 有 localStorage 的情形见 sidebarViewStore.dom.test.ts。
 *
 * app-shell 的整只 barrel 在 node 里加载不了（chat-ui 一加载就读 `window.location`），这里只给 store 用到的
 * 那一个文件（真的 `toSidebarView`）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock(
  '@shuvix/app-shell',
  async () => await import('../../../../../../../packages/app-shell/src/sidebar/SidebarViewSwitch')
)

import { useSidebarViewStore } from '../sidebarViewStore'

describe('sidebarViewStore without window', () => {
  it('VST-11 loads as sessions and setView does not throw', () => {
    expect(typeof window).toBe('undefined')
    expect(useSidebarViewStore.getState().view).toBe('sessions')
    expect(() => useSidebarViewStore.getState().setView('inbox')).not.toThrow()
    expect(useSidebarViewStore.getState().view).toBe('inbox')
  })
})
