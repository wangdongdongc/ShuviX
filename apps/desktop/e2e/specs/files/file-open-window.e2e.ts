/**
 * 应用里点开一个文件 → 独立窗口（`window.api.files.open` → previewWindowService.openFileInWindow）：
 * md 进协作编辑窗口（#markdown-window），其余能预览的进只读文件预览窗口（#file-preview），
 * 不能预览的（二进制 / 超限 / 目录 / 不存在）不响应：回 false、不开窗，主进程记一行「不支持预览」。
 * 右侧面板没有 Preview tab，会话面板也没有 Preview 工具了。
 *
 *   E-1 相对路径 a.txt → 预览窗口显示正文；hash 里的 sessionId 是借来的会话；不开 md 窗口
 *   E-2 doc.md → md 窗口，不开预览窗口
 *   E-3 相对 / 绝对 / sub/../ 的写法再开 → 仍只有一个窗口
 *   E-4 blob.bin / 带 NUL 的 noext / 2MB+1 的 big.txt / 目录 sub / 不存在的 missing.txt → false，
 *       窗口数不变，主进程日志各有一行「不支持预览」
 *   E-5 借来的会话删了：绝对路径照开、图片解码（naturalWidth 40）；相对路径 → false
 *   E-6 openedBy=agent → hash 带 openedBy=agent，预览顶上有来源横幅（文案 + 完整路径）
 *   E-7 主窗口没有 `[data-session-tool="preview"]`，右侧面板的标签栏没有 Preview（eye）tab
 *   E-8 真实 UI：笔记本里点 `[[a.txt]]` → 预览窗口；点 `[[doc]]` → md 窗口
 *
 * 不碰 LLM；界面语言钉成 en（横幅文案按 en.json 比）。每条用例自己关掉它开的窗口。
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  filePreviewWindowImages,
  filePreviewWindowShot,
  notebookEditorPane,
  rightPanelPane,
  sessionToolKeys,
  sidebarPane
} from '../../harness/pages'
import { createProject, waitRendererReady, writePng } from '../../harness/seed'

let app: E2EApp
let projectDir: string
let projectId = ''
let sid = ''

const real = (rel: string): string => join(projectDir, rel)

const openFile = (params: {
  sessionId?: string
  path: string
  openedBy?: 'agent' | 'user'
}): Promise<boolean> =>
  app.main.eval<boolean>(
    `window.api.files.open(${JSON.stringify({ sessionId: params.sessionId ?? sid, path: params.path, ...(params.openedBy ? { openedBy: params.openedBy } : {}) })})`
  )

const previewCount = async (): Promise<number> => (await app.filePreviewWindows()).length
const mdCount = async (): Promise<number> => (await app.markdownWindows()).length

/** 关一个窗口并等它的 target 消失 */
async function closeWindow(
  client: CdpClient,
  gone: () => Promise<boolean>,
  what: string
): Promise<void> {
  await client.eval('window.close()').catch(() => undefined)
  client.close()
  await until(async () => (await gone()) || null, what)
}

const closePreview = (client: CdpClient, name: string): Promise<void> =>
  closeWindow(
    client,
    async () => !(await app.filePreviewWindows()).some((w) => w.path.endsWith(`/${name}`)),
    `preview window for ${name} closed`
  )
const closeMarkdown = (client: CdpClient, name: string): Promise<void> =>
  closeWindow(
    client,
    async () => !(await app.markdownWindows()).some((w) => w.path.endsWith(`/${name}`)),
    `md window for ${name} closed`
  )

beforeAll(async () => {
  app = await launchApp()
  await waitRendererReady(app.main)
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)

  mkdirSync(join(app.home, 'proj-open'), { recursive: true })
  // 窗口按真实路径开（/tmp → /private/tmp 之类由主进程 realpath 抹平）：后面一律按真实路径比
  projectDir = realpathSync(join(app.home, 'proj-open'))
  mkdirSync(join(projectDir, 'sub'))
  writeFileSync(join(projectDir, 'a.txt'), 'hello preview\n')
  writePng(join(projectDir, 'pic.png'), { width: 40, height: 24 })
  writeFileSync(join(projectDir, 'doc.md'), '# doc\n\nmarkdown body\n')
  writeFileSync(join(projectDir, 'blob.bin'), Buffer.from([1, 2, 3, 4]))
  writeFileSync(join(projectDir, 'noext'), Buffer.from([0x41, 0x00, 0x42]))
  writeFileSync(join(projectDir, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
  writeFileSync(join(projectDir, 'nb.md'), '# nb\n\nSee [[a.txt]] and [[doc]].\n')

  projectId = (await createProject(app.main, { name: 'e2e-open', path: projectDir })).id
  sid = (
    await app.main.eval<{ id: string }>(
      `window.api.session.create(${JSON.stringify({ title: 'e2e-open', projectId })})`
    )
  ).id
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('files.open → 独立窗口', () => {
  it('E-1 相对路径 a.txt → 预览窗口显示正文，hash 借的是发起的会话，不开 md 窗口', async () => {
    expect(await openFile({ path: 'a.txt' })).toBe(true)
    const win = await until(() => app.connectFilePreviewWindow(real('a.txt')), 'a.txt window')
    try {
      const target = (await app.filePreviewWindows()).find((w) => w.path === real('a.txt'))
      expect(target?.sessionId).toBe(sid)
      expect(new URL(target!.url).hash).toContain('openedBy=user')
      const shot = await until(async () => {
        const s = await filePreviewWindowShot(win)
        return s.text.includes('hello preview') ? s : null
      }, 'a.txt content rendered')
      expect(shot.mounted).toBe(true)
      // 用户自己点开的：没有来源横幅
      expect(shot.text).not.toContain(en.panel.preview.openedByAgent)
      expect(await mdCount()).toBe(0)
    } finally {
      await closePreview(win, 'a.txt')
    }
  })

  it('E-2 doc.md → md 窗口，不开预览窗口', async () => {
    expect(await openFile({ path: 'doc.md' })).toBe(true)
    const win = await until(() => app.connectMarkdownWindow(real('doc.md')), 'doc.md md window')
    try {
      expect((await app.filePreviewWindows()).some((w) => w.path.endsWith('/doc.md'))).toBe(false)
      expect(await previewCount()).toBe(0)
    } finally {
      await closeMarkdown(win, 'doc.md')
    }
  })

  it('E-3 相对 / 绝对 / sub/../ 的写法都落到同一个预览窗口', async () => {
    expect(await openFile({ path: 'a.txt' })).toBe(true)
    const win = await until(() => app.connectFilePreviewWindow(real('a.txt')), 'a.txt window')
    try {
      expect(await openFile({ path: real('a.txt') })).toBe(true)
      expect(await openFile({ path: 'sub/../a.txt' })).toBe(true)
      expect(await openFile({ path: join(app.home, 'proj-open', 'a.txt') })).toBe(true)
      await sleep(1000)
      const hits = (await app.filePreviewWindows()).filter((w) => w.path === real('a.txt'))
      expect(hits).toHaveLength(1)
      expect(await previewCount()).toBe(1)
    } finally {
      await closePreview(win, 'a.txt')
    }
  })

  it('E-4 不能预览的 → false、不开窗，主进程各记一行「不支持预览」', async () => {
    const before = { preview: await previewCount(), md: await mdCount() }
    const names = ['blob.bin', 'noext', 'big.txt', 'sub', 'missing.txt']
    for (const name of names) {
      expect(await openFile({ path: name }), name).toBe(false)
    }
    await sleep(800)
    expect(await previewCount()).toBe(before.preview)
    expect(await mdCount()).toBe(before.md)
    const log = await until(() => {
      const text = app.mainLog()
      return names.every((n) => text.includes(`不支持预览`) && text.includes(`不响应: ${real(n)}`))
        ? text
        : null
    }, 'one "not previewable" log line per file')
    for (const name of names) {
      const line = log.split('\n').find((l) => l.includes(`不响应: ${real(name)}`))
      expect(line, name).toContain('不支持预览')
    }
  })

  it('E-5 借来的会话删了：绝对路径照开、图片解码；相对路径 → false', async () => {
    const gone = (
      await app.main.eval<{ id: string }>(
        `window.api.session.create(${JSON.stringify({ title: 'e2e-open-gone', projectId })})`
      )
    ).id
    await app.main.eval(`window.api.session.delete(${JSON.stringify(gone)})`)

    expect(await openFile({ sessionId: gone, path: 'pic.png' })).toBe(false)
    expect(await openFile({ sessionId: gone, path: real('pic.png') })).toBe(true)
    const win = await until(() => app.connectFilePreviewWindow(real('pic.png')), 'pic.png window')
    try {
      const target = (await app.filePreviewWindows()).find((w) => w.path === real('pic.png'))
      expect(target?.sessionId).toBe(gone)
      const imgs = await until(async () => {
        const shots = await filePreviewWindowImages(win)
        return shots.some((i) => i.naturalWidth === 40) ? shots : null
      }, 'pic.png decoded in the preview window')
      expect(imgs.find((i) => i.naturalWidth === 40)?.naturalHeight).toBe(24)
    } finally {
      await closePreview(win, 'pic.png')
    }
  })

  it('E-6 openedBy=agent → hash 带 agent，顶上有来源横幅（文案 + 完整路径）', async () => {
    expect(await openFile({ path: 'a.txt', openedBy: 'agent' })).toBe(true)
    const win = await until(() => app.connectFilePreviewWindow(real('a.txt')), 'a.txt window')
    try {
      const target = (await app.filePreviewWindows()).find((w) => w.path === real('a.txt'))
      expect(new URL(target!.url).hash).toContain('openedBy=agent')
      const shot = await until(async () => {
        const s = await filePreviewWindowShot(win)
        return s.text.includes(en.panel.preview.openedByAgent) ? s : null
      }, 'agent banner rendered')
      expect(shot.text).toContain(real('a.txt'))
    } finally {
      await closePreview(win, 'a.txt')
    }
  })

  it('E-7 主窗口没有 Preview 会话工具，右侧面板没有 Preview tab', async () => {
    const sidebar = sidebarPane(app.main)
    expect(await sidebar.openSession('e2e-open')).toBe(true)
    // 刚点开过好几个文件 —— 以前这会亮出 Preview 入口
    expect(await openFile({ path: 'a.txt' })).toBe(true)
    const win = await until(() => app.connectFilePreviewWindow(real('a.txt')), 'a.txt window')
    await closePreview(win, 'a.txt')

    const tools = await sessionToolKeys(app.main)
    expect(tools).toContain('files')
    expect(tools).not.toContain('preview')

    const panel = rightPanelPane(app.main)
    await panel.open()
    try {
      const icons = await panel.tabIcons()
      expect(icons).toEqual(
        expect.arrayContaining(['lucide-wrench', 'lucide-calendar-days', 'lucide-activity'])
      )
      expect(icons).not.toContain('lucide-eye')
      expect(icons).toHaveLength(3)
    } finally {
      await panel.close()
    }
  })

  it('E-8 笔记本里点 [[a.txt]] → 预览窗口；点 [[doc]] → md 窗口', async () => {
    await app.main.eval(
      `window.api.session.create(${JSON.stringify({ title: 'e2e-open-nb', projectId, notebookPath: 'nb.md' })})`
    )
    const sidebar = sidebarPane(app.main)
    await until(() => sidebar.openSession('e2e-open-nb'), 'notebook session opened')
    const editor = notebookEditorPane(app.main)
    await until(
      async () => (await editor.wikiLinkStatus('a.txt')) === 'resolved',
      '[[a.txt]] resolved'
    )

    await editor.clickWikiLink('a.txt')
    const preview = await until(
      () => app.connectFilePreviewWindow(real('a.txt')),
      'a.txt preview window from the notebook'
    )
    try {
      await until(
        async () => (await filePreviewWindowShot(preview)).text.includes('hello preview'),
        'a.txt content rendered'
      )
    } finally {
      await closePreview(preview, 'a.txt')
    }

    await until(async () => (await editor.wikiLinkStatus('doc')) === 'resolved', '[[doc]] resolved')
    await editor.clickWikiLink('doc')
    const md = await until(
      () => app.connectMarkdownWindow(real('doc.md')),
      'doc.md md window from the notebook'
    )
    try {
      expect((await app.filePreviewWindows()).some((w) => w.path.endsWith('/doc.md'))).toBe(false)
    } finally {
      await closeMarkdown(md, 'doc.md')
    }
  })
})
