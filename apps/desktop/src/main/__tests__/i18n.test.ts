/**
 * 主进程 i18n 的语言：存过的优先，没存就是英文，不看系统语言（本模块不再碰 electron 的 app.getLocale）。
 *
 *   I18N-M1 没存 → en
 *   I18N-M2 存过 → 就是它
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function languageAfterInit(saved?: string): Promise<string> {
  const { initI18n } = await import('../i18n')
  const i18next = (await import('i18next')).default
  initI18n(saved)
  return i18next.language
}

beforeEach(() => {
  vi.resetModules()
})

describe('主进程的语言', () => {
  it('I18N-M1 没存 → en', async () => {
    expect(await languageAfterInit()).toBe('en')
    expect(await languageAfterInit('')).toBe('en')
  })

  it.each(['zh', 'ja'])('I18N-M2 存过 %s → 就是它', async (saved) => {
    expect(await languageAfterInit(saved)).toBe(saved)
  })
})
