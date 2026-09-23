/**
 * 从系统打开的 md 窗口 —— 窗口本身与它背后的那条内存会话。
 *
 * 契约：
 *   - 一个窗口一条**内存会话**：标题与 notebookPath 是文件名，工作目录是文件所在目录（真实路径），
 *     不属于任何项目；不进会话列表（主窗口侧栏里没有它），不落对话树、不建临时工作区；
 *   - 根 Agent 是 notebook 档案，系统提示词里写着那个目录与文件名，没有项目围栏；
 *   - 编辑器就是笔记本：打字自动保存回**原文件**（原子保存不留临时文件）；经符号链接打开的，
 *     写的是链接指向的那份，链接本身还是链接；md 里的相对图片按文件所在目录显示；
 *   - 关窗 = 删会话，用户的文件与目录原样都在；
 *   - 主窗口与 md 窗口互不牵连：关掉主窗口，md 窗口照常能发消息。
 *
 * 实例带着两个文件冷启动（a.md 直接给、c.md 经一个符号链接给），模型事先种好（见 markdownFixtures）。
 * 断言优先走 md 窗口**自己的** `window.api`（它的 preload 与主窗口是同一份）；「不在列表里 / 不落盘」
 * 按主进程的列表与 userData 目录断。
 *
 *   MWE-1 会话的形态：标题 / notebookPath / 工作目录 / 无项目；不在 session.list()；
 *         没有 data/sessions/<sid>.jsonl，也没有 temp_workspace/<sid>
 *   MWE-2 agent.getInfo(ensure) 的系统提示词含那个目录与 a.md，没有 <project_prompt> 围栏
 *   MWE-4 `![](img/a.png)` 显示成 shuvix-preview:// 的图，指向 <dir>/img/a.png，解码成功
 *   MWE-3 在编辑器里打字 → 原文件被改、不留 .a.md.*.tmp；经链接打开的 → 写到目标、链接仍是链接
 *   MWE-7 主窗口（第二个实例带出来的）侧栏里没有 md 会话那一行
 *   MWE-6 关掉主窗口，md 窗口还在，还能发一条消息并收到回复
 *   MWE-5 关 md 窗口 → 日志「内存会话已删除 session=<sid>」，文件与目录都还在
 */
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isMainPage, listTargets, until, type CdpClient } from '../../harness/cdp'
import { spawnSecondInstance, type E2EMarkdownApp } from '../../harness/launch'
import {
  launchMarkdownWithProvider,
  logLines,
  userDir,
  type UserDir
} from '../../harness/markdownFixtures'
import { markdownWindowPane, sidebarPane, type MarkdownWindowPane } from '../../harness/pages'
import { waitFileWritten, waitRendererReady, writePng } from '../../harness/seed'
import type { FakeProvider } from '../../harness/fakeProvider'

let app: E2EMarkdownApp
let provider: FakeProvider
let files: UserDir
let docs: string
let aPath: string
let cPath: string
let cLink: string
let aw: CdpClient
let cw: CdpClient
let aPane: MarkdownWindowPane
let cPane: MarkdownWindowPane
let aSid: string
let cSid: string

const A_BODY = '# Doc A\n\nalpha body\n\n![](img/a.png)\n\ntail line\n'
const C_BODY = '# Doc C\n\ncharlie body\n'

beforeAll(async () => {
  files = userDir()
  aPath = files.file('docs/a.md', A_BODY)
  cPath = files.file('docs/c.md', C_BODY)
  docs = join(files.root, 'docs')
  writePng(join(files.dir('docs/img'), 'a.png'), { width: 48, height: 24 })
  cLink = files.link('links/link-c.md', cPath)
  ;({ app, provider } = await launchMarkdownWithProvider({
    args: [aPath, cLink],
    markdownWindows: 2
  }))
  aw = await until(() => app.connectMarkdownWindow('/docs/a.md'), 'a.md window connected')
  cw = await until(() => app.connectMarkdownWindow('/docs/c.md'), 'c.md window connected')
  const windows = await app.markdownWindows()
  aSid = windows.find((w) => w.path === aPath)!.sessionId
  cSid = windows.find((w) => w.path === cPath)!.sessionId
  aPane = markdownWindowPane(aw)
  cPane = markdownWindowPane(cw)
  await aPane.ready()
  await cPane.ready()
}, 240_000)

afterAll(async () => {
  aw?.close()
  cw?.close()
  await app?.stop()
  await provider?.close()
  files?.remove()
})

interface SessionShot {
  title: string
  projectId: string | null
  workingDirectory: string
  settings: { notebookPath?: string; workingDirectory?: string }
}

const sessionOf = (client: CdpClient, sid: string): Promise<SessionShot | null> =>
  client.eval<SessionShot | null>(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s ?? null)`
  )

describe('md 窗口背后的内存会话', () => {
  it('MWE-1 形态：文件名 / 工作目录 / 无项目；不在列表；不落对话树、不建临时工作区', async () => {
    const s = await sessionOf(aw, aSid)
    expect(s).toMatchObject({
      title: 'a.md',
      projectId: null,
      workingDirectory: docs,
      settings: { notebookPath: 'a.md', workingDirectory: docs }
    })
    // 经链接打开的那个：一切按真实路径（标题是目标的文件名，目录是目标所在的目录）
    expect(await sessionOf(cw, cSid)).toMatchObject({
      title: 'c.md',
      workingDirectory: docs,
      settings: { notebookPath: 'c.md' }
    })

    const listed = await aw.eval<string[]>(
      `window.api.session.list().then((ss) => ss.map((s) => s.id))`
    )
    expect(listed).not.toContain(aSid)
    expect(listed).not.toContain(cSid)

    for (const sid of [aSid, cSid]) {
      expect(existsSync(join(app.userData, 'data', 'sessions', `${sid}.jsonl`))).toBe(false)
      expect(existsSync(join(app.userData, 'temp_workspace', sid))).toBe(false)
    }
  })

  it('MWE-2 系统提示词：notebook 档案，写着那个目录与 a.md，没有项目围栏', async () => {
    const info = await aw.eval<{ systemPrompt: string; tools: Array<{ name: string }> }>(
      `window.api.agent.getInfo(${JSON.stringify(aSid)}, { ensure: true })`
    )
    expect(info.systemPrompt).toContain(docs)
    expect(info.systemPrompt).toContain('a.md')
    expect(info.systemPrompt).not.toContain('{{shuvix:')
    expect(info.systemPrompt).not.toContain('<project_prompt>')
    // notebook 档案的工具白名单：有 edit，没有派活 / 子会话
    const names = info.tools.map((t) => t.name)
    expect(names).toContain('edit')
    expect(names).not.toContain('agent')
    expect(names).not.toContain('session')
    // 建了运行时也不落盘
    expect(existsSync(join(app.userData, 'temp_workspace', aSid))).toBe(false)
  })
})

describe('md 窗口里的编辑器', () => {
  it('MWE-4 相对图片按文件所在目录显示（shuvix-preview://，解码成功）', async () => {
    const img = join(docs, 'img', 'a.png')
    const shots = await until(async () => {
      const all = await aPane.images()
      const hit = all.find((i) => i.path === img)
      return hit && hit.complete && hit.naturalWidth > 0 ? all : null
    }, 'relative image decoded in the md window')
    const hit = shots.find((i) => i.path === img)!
    expect(hit.src.startsWith('shuvix-preview://')).toBe(true)
    expect(hit.src).toContain(`session=${encodeURIComponent(aSid)}`)
    expect(hit.naturalWidth).toBe(48)
  })

  it('MWE-3 打字 → 自动保存回原文件，不留临时文件', async () => {
    const before = readFileSync(aPath, 'utf8')
    await aPane.typeAtEnd('typed-mwe3')
    const after = await waitFileWritten(aPath, before, 'a.md autosaved')
    expect(after).toContain('typed-mwe3')
    expect(after.startsWith(before.replace(/\n$/, ''))).toBe(true)
    expect(after.trimEnd().endsWith('typed-mwe3')).toBe(true)
    expect(readdirSync(docs).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('MWE-3 经符号链接打开的：写到链接指向的文件，链接本身还是那个链接', async () => {
    const before = readFileSync(cPath, 'utf8')
    await cPane.typeAtEnd('typed-via-link')
    const after = await waitFileWritten(cPath, before, 'c.md (link target) autosaved')
    expect(after).toContain('typed-via-link')
    expect(lstatSync(cLink).isSymbolicLink()).toBe(true)
    expect(readlinkSync(cLink)).toBe(cPath)
    expect(readFileSync(cLink, 'utf8')).toBe(after)
    expect(readdirSync(join(files.root, 'links'))).toEqual(['link-c.md'])
    expect(readdirSync(docs).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('主窗口与 md 窗口互不牵连', () => {
  let main: CdpClient | null = null

  it('MWE-7 第二个实例带出来的主窗口：侧栏里没有 md 会话那一行', async () => {
    const second = await spawnSecondInstance(app)
    expect(second.code).toBe(0)
    main = await until(() => app.mainWindow(), 'main window created by a no-file second instance')
    await waitRendererReady(main)

    // 对照行：一条普通会话 —— 它出现了，才说明侧栏已经把列表拉回来了
    await main.eval(`window.api.session.create({ title: 'mwe7-control' })`)
    const sidebar = sidebarPane(main)
    await until(
      () => sidebar.titles().then((titles) => titles.includes('mwe7-control')),
      'sidebar shows the control session'
    )
    const titles = await sidebar.titles()
    expect(titles).not.toContain('a.md')
    expect(titles).not.toContain('c.md')
    const listed = await main.eval<string[]>(
      `window.api.session.list().then((ss) => ss.map((s) => s.id))`
    )
    expect(listed).not.toContain(aSid)
  })

  it('MWE-6 关掉主窗口，md 窗口还在，照样能发消息、收到回复', async () => {
    expect(main).not.toBeNull()
    await main!.eval('window.close()').catch(() => undefined)
    main!.close()
    await until(
      async () => !(await listTargets(app.port)).some((t) => isMainPage(t)),
      'main window closed'
    )
    expect((await app.markdownWindows()).map((w) => w.path).sort()).toEqual([aPath, cPath].sort())

    provider.reset()
    provider.script({ text: 'reply-after-main-closed', usage: { prompt: 100, completion: 10 } })
    expect(await aPane.sendEnabled()).toBe(false) // 还没填字
    await aPane.send('hello from the md window')
    await aPane.waitDrawerText('reply-after-main-closed', 30_000)
    expect(provider.chatRequests()).toHaveLength(1)
    expect(provider.chatRequests()[0].lastUserText).toContain('hello from the md window')
    // 聊过了也不落盘：内存会话的对话树只在内存里
    expect(existsSync(join(app.userData, 'data', 'sessions', `${aSid}.jsonl`))).toBe(false)
  })
})

describe('关 md 窗口', () => {
  it('MWE-5 关窗 → 内存会话被删；文件与目录都还在', async () => {
    const cBefore = readFileSync(cPath, 'utf8')
    await cw.eval('window.close()').catch(() => undefined)
    await until(
      () => logLines(app.mainLog(), `内存会话已删除 session=${cSid}`).length === 1,
      'ephemeral session deleted after the window closed'
    )
    expect(await sessionOf(aw, cSid)).toBeNull()
    expect((await app.markdownWindows()).map((w) => w.path)).toEqual([aPath])
    expect(readFileSync(cPath, 'utf8')).toBe(cBefore)
    expect(lstatSync(cLink).isSymbolicLink()).toBe(true)
    expect(statSync(docs).isDirectory()).toBe(true)
    // 另一个窗口不受影响
    expect(await sessionOf(aw, aSid)).toMatchObject({ title: 'a.md' })
  })
})
