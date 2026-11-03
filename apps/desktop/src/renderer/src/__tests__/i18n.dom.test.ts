// @vitest-environment jsdom
/**
 * 渲染进程 i18n 的初始语言：上次记下的那份，没有就是英文，**不看系统语言**。
 * 每条用例重新导入，按「新开一个窗口」的样子跑。
 *
 *   I18N-1 什么都没存、系统是中文 → en
 *   I18N-2 记下过 zh / ja → 就是它（首帧不闪英文）
 *   I18N-3 记下的不是支持的语言 → en
 *   I18N-4 读 localStorage 就抛 → en，导入不抛
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function initialLanguage(): Promise<string> {
  vi.resetModules()
  return (await import('../i18n')).default.language
}

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('渲染进程的初始语言', () => {
  it('I18N-1 什么都没存、系统是中文 → en', async () => {
    expect(await initialLanguage()).toBe('en')
  })

  it.each(['zh', 'ja', 'en'])('I18N-2 记下过 %s → 就是它', async (language) => {
    localStorage.setItem('language', language)
    expect(await initialLanguage()).toBe(language)
  })

  it.each(['fr', 'zh-CN', ''])('I18N-3 记下的是 %j → en', async (language) => {
    localStorage.setItem('language', language)
    expect(await initialLanguage()).toBe('en')
  })

  it('I18N-4 读 localStorage 就抛 → en', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(await initialLanguage()).toBe('en')
  })
})
