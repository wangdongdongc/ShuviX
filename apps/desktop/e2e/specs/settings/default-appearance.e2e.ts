/**
 * 什么都没选过的实例：主题跟随系统，语言是英文（系统语言是别的也一样）。
 *
 * 实例用 `--lang=zh-CN` 启动，让系统语言确实是中文（`navigator.language` 核对这一点），否则「不看系统语言」
 * 在英文系统上证明不了什么。明暗用 CDP 模拟 prefers-color-scheme 两头都走一遍，不依赖这台机器当前的外观。
 *
 *   DA-1 没存过语言、系统是中文 → 界面（输入框占位）是英文，记下的也是 en
 *   DA-2 主进程同样是英文（工具的 label 由主进程按它的语言翻译）
 *   DA-3 没存过主题 → data-theme 跟着系统：模拟深色 github-dark、模拟浅色 github-light，记下的是 system
 *   DA-4 显式选了中文 → 重载后是中文（缺省不盖掉用户的选择）
 *
 * 不碰 LLM。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { waitRendererReady } from '../../harness/seed'

let app: E2EApp

const placeholder = (): Promise<string | null> =>
  app.main.eval<string | null>(`document.querySelector('textarea')?.placeholder ?? null`)

const dataTheme = (): Promise<string | null> =>
  app.main.eval<string | null>(`document.documentElement.getAttribute('data-theme')`)

const emulateScheme = (value: 'dark' | 'light'): Promise<unknown> =>
  app.main.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value }]
  })

beforeAll(async () => {
  app = await launchApp({ args: ['--lang=zh-CN'] })
  await waitRendererReady(app.main)
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('什么都没选过的实例', () => {
  it('DA-1 没存过语言、系统是中文 → 界面是英文，记下的也是 en', async () => {
    expect(await app.main.eval<string>('navigator.language')).toMatch(/^zh/)
    expect(await app.main.eval(`window.api.settings.get('general.language')`)).toBeFalsy()
    await until(
      async () => (await placeholder()) === en.input.placeholderFiles,
      'composer placeholder in English'
    )
    await until(
      () => app.main.eval<boolean>(`localStorage.getItem('language') === 'en'`),
      'language remembered'
    )
  })

  it('DA-2 主进程同样是英文', async () => {
    const tools = await app.main.eval<Array<{ name: string; label: string }>>(
      `window.api.tools.definitions()`
    )
    expect(tools.find((tool) => tool.name === 'bash')?.label).toBe(en.tool.bashLabel)
  })

  it('DA-3 没存过主题 → data-theme 跟着系统，记下的是 system', async () => {
    expect(await app.main.eval(`window.api.settings.get('general.theme')`)).toBeFalsy()
    expect(await app.main.eval<string | null>(`localStorage.getItem('theme')`)).toBe('system')

    await emulateScheme('dark')
    await until(async () => (await dataTheme()) === 'github-dark', 'follows emulated dark')
    await emulateScheme('light')
    await until(async () => (await dataTheme()) === 'github-light', 'follows emulated light')

    await app.main.send('Emulation.setEmulatedMedia', { features: [] })
  })

  it('DA-4 显式选了中文 → 重载后是中文', async () => {
    await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'zh' })`)
    await app.main.send('Page.reload')
    await until(
      () => app.main.eval<boolean>(`localStorage.getItem('language') === 'zh'`).catch(() => false),
      'language remembered after reload'
    )
    await waitRendererReady(app.main)
    await until(
      async () => (await placeholder()) === zh.input.placeholderFiles,
      'composer placeholder in Chinese'
    )
  })
})
