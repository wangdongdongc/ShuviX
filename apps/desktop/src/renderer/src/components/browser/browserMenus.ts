import type { TFunction } from 'i18next'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'
import {
  useBrowserTabsStore,
  type BrowserTabInfo,
  type BrowserViewMode
} from '../../stores/browserTabsStore'
import { tabLabel } from './tabUtils'

/**
 * 浏览器窗口的菜单：标签右键菜单、工具条的 ⋮ 菜单、标签条右端的「搜索标签页」。
 *
 * 一律是**原生菜单**（`contextMenu:popup`，与侧栏的行菜单同一条通道）：原生页面画在 DOM 之上，DOM 弹层
 * 一落到页面区就被盖住；原生菜单是系统窗口，永远在最上面。e2e 的桩也是这一条（bootstrap.cjs）。
 */

const SEP: ContextMenuItem = { type: 'separator' }

const isBlank = (tab: BrowserTabInfo): boolean => !tab.url || tab.url === 'about:blank'
const isWeb = (tab: BrowserTabInfo): boolean => /^https?:/i.test(tab.url || '')

async function popup(items: ContextMenuItem[]): Promise<string | null> {
  const result = await window.api.contextMenu.popup({ items })
  return result.actionId
}

/** 在系统浏览器里打开（只对网页有意义：本地文件与别的协议不会交给系统，见 services/externalOpen） */
function openExternal(tab: BrowserTabInfo): void {
  if (isWeb(tab)) void window.api.app.openExternal(tab.url)
}

/** 标签的右键菜单 */
export async function showTabMenu(tab: BrowserTabInfo, t: TFunction): Promise<void> {
  const store = useBrowserTabsStore.getState()
  const ids = store.tabs.map((x) => x.id)
  const at = ids.indexOf(tab.id)
  const others = ids.filter((id) => id !== tab.id)
  const right = at === -1 ? [] : ids.slice(at + 1)
  const action = await popup([
    { id: 'newTab', label: t('browser.newTab') },
    SEP,
    { id: 'reload', label: t('browser.refresh'), enabled: !isBlank(tab) },
    { id: 'duplicate', label: t('browser.menu.duplicate'), enabled: !isBlank(tab) },
    { id: 'copyLink', label: t('browser.menu.copyLink'), enabled: !isBlank(tab) },
    ...(isWeb(tab) ? [{ id: 'openExternal', label: t('browser.openExternal') }] : []),
    SEP,
    { id: 'close', label: t('browser.closeTab') },
    { id: 'closeOthers', label: t('browser.menu.closeOthers'), enabled: others.length > 0 },
    { id: 'closeRight', label: t('browser.menu.closeRight'), enabled: right.length > 0 }
  ])
  switch (action) {
    case 'newTab':
      store.createTab()
      return
    case 'reload':
      void window.api.browserView.reload(tab.id)
      return
    case 'duplicate':
      store.createTab(tab.url)
      return
    case 'copyLink':
      void navigator.clipboard.writeText(tab.url).catch(() => undefined)
      return
    case 'openExternal':
      openExternal(tab)
      return
    case 'close':
      store.closeTab(tab.id)
      return
    case 'closeOthers':
      for (const id of others) store.closeTab(id)
      return
    case 'closeRight':
      for (const id of right) store.closeTab(id)
      return
  }
}

/** 工具条右端的 ⋮ 菜单（作用于选中的那页） */
export async function showMoreMenu(opts: {
  tab: BrowserTabInfo | null
  viewMode: BrowserViewMode
  onViewMode: (mode: BrowserViewMode) => void
  t: TFunction
}): Promise<void> {
  const { tab, viewMode, onViewMode, t } = opts
  const store = useBrowserTabsStore.getState()
  const page = tab && !isBlank(tab) ? tab : null
  const action = await popup([
    { id: 'newTab', label: t('browser.newTab') },
    { id: 'reopen', label: t('browser.menu.reopenClosed') },
    SEP,
    { id: 'zoomIn', label: t('browser.menu.zoomIn'), enabled: !!page },
    { id: 'zoomOut', label: t('browser.menu.zoomOut'), enabled: !!page },
    {
      id: 'zoomReset',
      label: t('browser.menu.zoomReset', { pct: page?.zoomPercent ?? 100 }),
      enabled: !!page && page.zoomPercent !== 100
    },
    SEP,
    viewMode === 'single'
      ? { id: 'viewWall', label: t('browser.view.wall') }
      : { id: 'viewSingle', label: t('browser.view.single') },
    SEP,
    ...(page && isWeb(page) ? [{ id: 'openExternal', label: t('browser.openExternal') }] : []),
    { id: 'settings', label: t('browser.menu.settings') }
  ])
  switch (action) {
    case 'newTab':
      store.createTab()
      return
    case 'reopen':
      store.reopenClosedTab()
      return
    case 'zoomIn':
    case 'zoomOut':
    case 'zoomReset':
      if (page) {
        store.zoomTab(page.id, action === 'zoomIn' ? 'in' : action === 'zoomOut' ? 'out' : 'reset')
      }
      return
    case 'viewWall':
      onViewMode('wall')
      return
    case 'viewSingle':
      onViewMode('single')
      return
    case 'openExternal':
      if (page) openExternal(page)
      return
    case 'settings':
      // 浏览器自己的设置页（shuvix://settings；已经开着就选中它）
      store.openSettings()
      return
  }
}

/** 标签条右端的「搜索标签页」：列出全部标签，点一个就选中它（✓ 标出当前选中的） */
export async function showTabSearchMenu(t: TFunction): Promise<void> {
  const store = useBrowserTabsStore.getState()
  if (store.tabs.length === 0) return
  const action = await popup(
    store.tabs.map((tab) => {
      const label = tabLabel(tab, t('browser.untitledTab'))
      const by = tab.cdpAttached && tab.agentSessionTitle ? ` · ${tab.agentSessionTitle}` : ''
      return {
        id: tab.id,
        label: `${tab.id === store.activeTabId ? '✓ ' : ''}${label}${by}`
      }
    })
  )
  if (action) store.activateTab(action)
}
