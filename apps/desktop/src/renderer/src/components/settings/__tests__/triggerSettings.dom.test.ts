// @vitest-environment jsdom
/**
 * 设置 → 触发源的触发日志（TriggerSettings）：一轮没跑完的两种结局。
 *
 *   TSD-1 stopped / interrupted 的行显示当前语言的文案（en / zh / ja）：不是原始 key，也不是回落的「失败」；
 *         同一页的 failed 行照旧显示失败，stopped / interrupted 没有失败那种红色
 *
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 * `useAppEvent` 与确认框是替身；i18n 走真语言资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { TriggerLogEntry, TriggerLogOutcome } from '@shuvix/chat-protocol/triggerSources'

vi.mock('@shuvix/chat-ui', () => ({ useAppEvent: () => undefined }))
vi.mock('../../common/ConfirmDialog', () => ({ ConfirmDialog: () => null }))

import { TriggerSettings } from '../TriggerSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function row(outcome: TriggerLogOutcome): TriggerLogEntry {
  return {
    id: outcome,
    createdAt: new Date(2026, 10, 2, 18, 0).getTime(),
    updatedAt: new Date(2026, 10, 2, 18, 1).getTime(),
    sourceId: 'timer:builtin:minute',
    trigger: 'timer.fired',
    bot: 'ticker',
    botDisplayName: 'Ticker',
    botFile: 'ticker.md',
    bindingIndex: 0,
    when: '',
    outcome,
    sessionId: `s-${outcome}`,
    error: '',
    event: {}
  }
}

const api = {
  trigger: {
    status: vi.fn(async () => []),
    logs: vi.fn(async () => [row('stopped'), row('interrupted'), row('failed')]),
    clearLogs: vi.fn(async () => undefined)
  }
}

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      ja: { translation: ja }
    },
    interpolation: { escapeValue: false }
  })
})

beforeEach(() => {
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const rowEl = (outcome: string): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-trigger-log-row="${outcome}"]`)!

describe('TriggerSettings · outcomes of a run that did not finish', () => {
  it.each([
    ['en', en],
    ['zh', zh],
    ['ja', ja]
  ] as const)(
    'TSD-1(%s) stopped and interrupted rows show the locale string, not the raw key and not the Failed label',
    async (lng, locale) => {
      await i18n.changeLanguage(lng)
      await act(async () => {
        root.render(createElement(TriggerSettings))
      })

      const labels = locale.settings
      expect(rowEl('stopped').getAttribute('data-outcome')).toBe('stopped')
      expect(rowEl('stopped').textContent).toContain(labels.triggerLogStopped)
      expect(rowEl('interrupted').getAttribute('data-outcome')).toBe('interrupted')
      expect(rowEl('interrupted').textContent).toContain(labels.triggerLogInterrupted)
      expect(rowEl('failed').textContent).toContain(labels.triggerLogFailed)

      for (const outcome of ['stopped', 'interrupted']) {
        const text = rowEl(outcome).textContent ?? ''
        expect(text).not.toContain(labels.triggerLogFailed)
        expect(text).not.toContain('triggerLog')
        expect(rowEl(outcome).querySelector('[class*="text-red-"]')).toBeNull()
      }
      expect(rowEl('failed').querySelector('[class*="text-red-"]')).not.toBeNull()
    }
  )
})
