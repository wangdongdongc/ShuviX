/**
 * 打开独立窗口时主题不闪：md 窗口、文件预览窗口都在首帧（ready-to-show）就显示，从文档一开始到设置读回来，
 * 根元素的 data-theme 只能是用户的主题。从前外壳一挂载就写上 store 的缺省 github-dark，
 * 等设置读回来才写回去，亮色主题下窗口就白 → 黑 → 白地闪一下（真实窗口的逐帧截图里是 #0d1117）。
 *
 * 观察点钉在文档开始（CDP 的 addScriptToEvaluateOnNewDocument + 重载这扇窗）：重载走的是与新开一样的
 * 内联脚本 → React 挂载 → 读设置，而 MutationObserver 连没画出来的改动也记得到，不看运气。
 * 字号设成非缺省值当「设置已读回」的信号：--app-font-size 与主题在同一轮 effect 里写。
 *
 *   MFP-1 亮色（github-light）：md 窗口 data-theme 从头到尾只有 github-light
 *   MFP-2 非缺省的深色（tokyo-night）：md 窗口同样
 *   MFP-3 亮色（solarized-light）：文件预览窗口同样
 *   MFP-4 存过中文：md 窗口的输入框从第一次出现起就是中文，没有一瞬间的英文（语言的缺省是英文，
 *         首帧靠 i18n.ts 读 localStorage 里记下的那份）
 *
 * 不碰 LLM。每条用例自己关掉它开的窗口。
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import { until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { waitRendererReady } from '../../harness/seed'

const FONT_SIZE = 15

/** 文档一开始就装上：记下根元素 data-theme 的每一个值（含没来得及画出来的），以及输入框的每一个占位文案 */
const RECORD_THEME = `
  window.__themes = []
  window.__placeholders = []
  new MutationObserver(() => {
    const text = document.querySelector('[data-markdown-window] textarea')?.placeholder
    if (text && window.__placeholders.at(-1) !== text) window.__placeholders.push(text)
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['placeholder']
  })
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.target === document.documentElement && r.oldValue) window.__themes.push(r.oldValue)
    }
  }).observe(document, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-theme'],
    attributeOldValue: true
  })
`

let app: E2EApp
let dir: string
let sid = ''

const setSetting = (key: string, value: string): Promise<unknown> =>
  app.main.eval(`window.api.settings.set(${JSON.stringify({ key, value })})`)

/** 设好主题并重载主窗口：localStorage 由它读设置时写，与用户换过主题之后的样子一样 */
async function useTheme(mode: 'light' | 'dark', themeId: string): Promise<void> {
  await setSetting('general.theme', mode)
  await setSetting(mode === 'light' ? 'general.lightTheme' : 'general.darkTheme', themeId)
  await app.main.eval(`localStorage.setItem('theme', 'stale')`)
  await app.main.send('Page.reload')
  await until(
    () => app.main.eval<boolean>(`localStorage.getItem('theme') === ${JSON.stringify(mode)}`),
    'main window reloaded its settings'
  )
  await waitRendererReady(app.main)
}

/** 重载这扇窗，回它从文档开始到设置读回来经历过的所有 data-theme（最后一个是此刻的值） */
async function themesOverReload(win: CdpClient): Promise<string[]> {
  await win.send('Page.enable')
  await win.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_THEME })
  await win.send('Page.reload')
  await until(
    () =>
      win
        .eval<boolean>(
          `!!window.__themes && getComputedStyle(document.documentElement).getPropertyValue('--app-font-size').trim() === '${FONT_SIZE}px'`
        )
        .catch(() => false),
    'settings loaded after reload'
  )
  return win.eval<string[]>(
    `[...window.__themes, document.documentElement.getAttribute('data-theme')]`
  )
}

function closeWindow(win: CdpClient): void {
  void win.eval('window.close()').catch(() => undefined)
  win.close()
}

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  await setSetting('general.fontSize', String(FONT_SIZE))
  dir = realpathSync(app.home)
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs/a.md'), '# a\n\nbody\n')
  writeFileSync(join(dir, 'docs/b.md'), '# b\n\nbody\n')
  writeFileSync(join(dir, 'docs/c.txt'), 'plain text\n')
  sid = (await app.main.eval<{ id: string }>(`window.api.session.create({ title: 'first-paint' })`))
    .id
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('独立窗口的首帧主题', () => {
  it.each([
    { id: 'MFP-1', file: 'a.md', mode: 'light' as const, themeId: 'github-light' },
    { id: 'MFP-2', file: 'b.md', mode: 'dark' as const, themeId: 'tokyo-night' }
  ])('$id md 窗口 $themeId：data-theme 只有这一个值', async ({ file, mode, themeId }) => {
    await useTheme(mode, themeId)
    const path = join(dir, 'docs', file)
    expect(
      await app.main.eval<boolean>(
        `window.api.files.open(${JSON.stringify({ sessionId: sid, path })})`
      )
    ).toBe(true)
    const win = await until(() => app.connectMarkdownWindow(path), `${file} window`)

    const themes = await themesOverReload(win)
    expect(themes.length).toBeGreaterThan(0)
    expect(new Set(themes)).toEqual(new Set([themeId]))

    closeWindow(win)
  })

  it('MFP-3 文件预览窗口 solarized-light：data-theme 只有这一个值', async () => {
    await useTheme('light', 'solarized-light')
    const path = join(dir, 'docs/c.txt')
    expect(
      await app.main.eval<boolean>(
        `window.api.files.open(${JSON.stringify({ sessionId: sid, path })})`
      )
    ).toBe(true)
    const win = await until(() => app.connectFilePreviewWindow(path), 'c.txt window')

    const themes = await themesOverReload(win)
    expect(themes.length).toBeGreaterThan(0)
    expect(new Set(themes)).toEqual(new Set(['solarized-light']))

    closeWindow(win)
  })

  it('MFP-4 存过中文：md 窗口的输入框从第一次出现起就是中文', async () => {
    await setSetting('general.language', 'zh')
    await useTheme('light', 'github-light')
    await until(
      () => app.main.eval<boolean>(`localStorage.getItem('language') === 'zh'`),
      'language remembered'
    )
    const path = join(dir, 'docs/d.md')
    writeFileSync(path, '# d\n\nbody\n')
    expect(
      await app.main.eval<boolean>(
        `window.api.files.open(${JSON.stringify({ sessionId: sid, path })})`
      )
    ).toBe(true)
    const win = await until(() => app.connectMarkdownWindow(path), 'd.md window')

    await themesOverReload(win)
    const placeholders = await until(
      () =>
        win.eval<string[]>(`window.__placeholders`).then((seen) => (seen.length > 0 ? seen : null)),
      'composer placeholder seen'
    )
    expect(placeholders).toEqual([zh.input.placeholderFiles])
    expect(placeholders).not.toContain(en.input.placeholderFiles)

    await setSetting('general.language', 'en')
    closeWindow(win)
  })
})
