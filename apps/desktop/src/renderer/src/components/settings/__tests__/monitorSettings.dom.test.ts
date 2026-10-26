// @vitest-environment jsdom
/**
 * 设置 → 监视器（MonitorSettings）：三个子页 —— LLM 请求日志、分类器日志与应用日志。
 *
 *   MON-1 合法子 tab 恰是 httpLogs / classifierLogs / appLog（hash 路由按它校验，旧的 agents 回落到默认）
 *   MON-2 标签条恰三项、按这个顺序、标签已译；activeKey 就是传进来的 subTab
 *   MON-3 subTab = httpLogs → 只画请求日志页；classifierLogs → 只画分类器日志页；appLog → 只画应用日志页
 *   MON-4 点标签条上的某一项 → onSubTabChange(那一项的 key)
 *
 * 标签条与三个子页换成替身（它们各自有测试）。i18n 走真 zh 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h } = await import('react')
  return {
    PanelTabBar: ({
      tabs,
      activeKey,
      onSelect
    }: {
      tabs: Array<{ key: string; label: string }>
      activeKey: string
      onSelect: (key: string) => void
    }) =>
      h(
        'div',
        { 'data-tab-bar': '', 'data-active': activeKey },
        ...tabs.map((tab) =>
          h(
            'button',
            { key: tab.key, 'data-tab': tab.key, onClick: () => onSelect(tab.key) },
            tab.label
          )
        )
      )
  }
})
vi.mock('../HttpLogSettings', async () => {
  const { createElement: h } = await import('react')
  return { HttpLogSettings: () => h('div', { 'data-page': 'httpLogs' }) }
})
vi.mock('../ClassifierLogSettings', async () => {
  const { createElement: h } = await import('react')
  return { ClassifierLogSettings: () => h('div', { 'data-page': 'classifierLogs' }) }
})
vi.mock('../AppLogSettings', async () => {
  const { createElement: h } = await import('react')
  return { AppLogSettings: () => h('div', { 'data-page': 'appLog' }) }
})

import { MonitorSettings, MONITOR_SUB_TABS, type MonitorSubTab } from '../MonitorSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function render(subTab: MonitorSubTab, onSubTabChange = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(createElement(MonitorSettings, { subTab, onSubTabChange }))
  })
}

const pages = (): string[] =>
  [...container.querySelectorAll('[data-page]')].map((el) => el.getAttribute('data-page') ?? '')

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('MonitorSettings', () => {
  it('MON-1 合法子 tab 恰是 httpLogs / classifierLogs / appLog', () => {
    expect([...MONITOR_SUB_TABS].sort()).toEqual(['appLog', 'classifierLogs', 'httpLogs'])
    expect(MONITOR_SUB_TABS.has('agents')).toBe(false)
  })

  it('MON-2 标签条恰三项、按这个顺序、标签已译；activeKey 就是 subTab', async () => {
    await render('classifierLogs')
    const tabs = [...container.querySelectorAll('[data-tab]')].map((el) => [
      el.getAttribute('data-tab'),
      el.textContent
    ])
    expect(tabs).toEqual([
      ['httpLogs', i18n.t('settings.monitorSubTabLlm')],
      ['classifierLogs', i18n.t('settings.monitorSubTabClassifier')],
      ['appLog', i18n.t('settings.monitorSubTabAppLog')]
    ])
    expect(i18n.t('settings.monitorSubTabClassifier')).not.toBe('settings.monitorSubTabClassifier')
    expect(i18n.t('settings.monitorSubTabAppLog')).toBe('应用日志')
    expect(container.querySelector('[data-tab-bar]')!.getAttribute('data-active')).toBe(
      'classifierLogs'
    )
  })

  it('MON-3 subTab 决定画哪一页（只画那一页）', async () => {
    await render('httpLogs')
    expect(pages()).toEqual(['httpLogs'])
    await render('classifierLogs')
    expect(pages()).toEqual(['classifierLogs'])
    await render('appLog')
    expect(pages()).toEqual(['appLog'])
  })

  it('MON-4 点标签 → onSubTabChange(那一项的 key)', async () => {
    const onSubTabChange = vi.fn()
    await render('httpLogs', onSubTabChange)
    await act(async () => {
      ;(container.querySelector('[data-tab="classifierLogs"]') as HTMLElement).click()
    })
    expect(onSubTabChange).toHaveBeenLastCalledWith('classifierLogs')
    await act(async () => {
      ;(container.querySelector('[data-tab="httpLogs"]') as HTMLElement).click()
    })
    expect(onSubTabChange).toHaveBeenLastCalledWith('httpLogs')
    await act(async () => {
      ;(container.querySelector('[data-tab="appLog"]') as HTMLElement).click()
    })
    expect(onSubTabChange).toHaveBeenLastCalledWith('appLog')
    expect(onSubTabChange).toHaveBeenCalledTimes(3)
  })
})
