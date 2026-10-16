/**
 * 主窗口里的笔记本也是协作编辑 —— doc_* 落在哪，按每次调用当时有没有编辑器显示着这份文档来定。
 *
 * 契约（CLAUDE.md「Co-editing — every notebook」；desktop services/liveDocumentBridge.ts、tools/doc.ts、
 * renderer NotebookSessionView → useCoEditing）：
 *   - 编辑器开着（主窗口正显示这条笔记本会话）：doc_read 读的是活缓冲并报「用户在哪」，doc_edit 当场落在
 *     缓冲上（不重挂载、留 agent 的改动痕迹、不经安全询问），由自动保存写盘；
 *   - 切到别的会话（编辑器摘下）：同一组工具走**磁盘回落** —— doc_read 说文档没开着，doc_edit 直接改文件
 *     （一轮结束时盘上已是改后的字节），再打开这条笔记读到的就是新内容；
 *   - 切回来：新挂上的编辑器接手，又是活的；
 *   - write 碰这份文档（绝对路径或相对工作目录的写法）→ 拒绝并指向 doc_*（红的块），别的文件照常写；
 *   - 外部写盘三方合并进编辑器：用户没存盘的输入与外部改动两边都留下（以前会重挂载、随后被自动保存盖掉）。
 *
 * 一个实例、一个项目（在假 HOME 里 —— 工作目录是会话目录，写入不问）、一条笔记本会话（notes/nc.md）+ 一条
 * 普通会话「Other」。用例按顺序接力（文档的内容一轮轮往下传）。工具结果读下一次请求里模型真正看到的那条
 * tool 消息；一轮的结束读主窗口录到的 agent_end（主窗口是默认前端，收得到每条会话的事件）。
 *
 *   NC-1 主窗口开着笔记：doc_read 报「The user: cursor on line」；doc_edit 出现在编辑器里、不重挂载、
 *        有 agent 的（非 external）痕迹、自动保存写盘、没有安全决策
 *   NC-2 切到「Other」：doc_read 说「没开着」；agent_end 时盘上就是改后的字节；再打开这条笔记读到新内容
 *   NC-3 切回来：又是活的（报用户在哪、非 external 痕迹、不重挂载）
 *   NC-4 write 碰这份文档（绝对 / 相对）→ 拒绝那句话、块是红的、字节不变；写 other.md 照常
 *   NC-5 回归：主窗口里没存盘的输入 + 外部改了另一段 → 两边都在（编辑器与盘），不重挂载
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  startFakeProvider,
  type FakeProvider,
  type FakeRequest,
  type FakeTurn
} from '../../harness/fakeProvider'
import {
  autoAllowed,
  createProject,
  eventRecorder,
  installAutoAllow,
  securityDecisions,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import {
  notebookEditorPane,
  sidebarPane,
  type NotebookEditorPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 120, completion: 12 }

const NOT_OPEN =
  'The document is not open in an editor right now: this is the saved file, and your changes are written to it directly.'
const REFUSAL =
  "This is the document open in this notebook session. Change it with doc_edit or doc_insert, so the change lands in the user's editor; write and edit are for other files."

const SEED = '# NC note\n\nSeed paragraph NC.\n\nSecond paragraph NC.\n'

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let sidebar: SidebarPane
let editor: NotebookEditorPane
let projDir = ''
let docPath = ''
let nbSid = ''
let otherSid = ''

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  // 项目在假 HOME 里：工作目录是会话目录，磁盘回落的写入不问
  projDir = join(app.home, 'proj-notebook-coedit')
  mkdirSync(join(projDir, 'notes'), { recursive: true })
  docPath = join(projDir, 'notes', 'nc.md')
  writeFileSync(docPath, SEED)
  const project = await createProject(app.main, { name: 'NotebookCoeditProj', path: projDir })
  nbSid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ projectId: project.id, notebookPath: 'notes/nc.md' })}).then((s) => s.id)`
  )
  otherSid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ projectId: project.id, title: 'Other' })}).then((s) => s.id)`
  )

  sidebar = sidebarPane(app.main)
  editor = notebookEditorPane(app.main)
  events = eventRecorder(app.main)
  await events.install()
  // 安全网：本文件没有任何一步该弹询问卡；真弹了就点允许并记下来，断言里读它
  await installAutoAllow(app.main)
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

// ─── 工具 ─────────────────────────────────────────────────

/** 一次工具调用的脚本 */
function call(
  id: string,
  name: string,
  args: Record<string, unknown>
): { id: string; name: string; args: string } {
  return { id, name, args: JSON.stringify(args) }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => ((c as { type?: string }).type === 'text' ? (c as { text: string }).text : ''))
    .join('')
}

/** 模型在之后的请求里看到的那条工具结果（没有为 undefined） */
function toolMessage(
  id: string,
  reqs: FakeRequest[] = provider.chatRequests()
): string | undefined {
  for (const req of reqs) {
    const hit = (req.body.messages ?? []).find(
      (m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === id
    )
    if (hit) return contentText(hit.content)
  }
  return undefined
}

const waitToolMessage = (id: string): Promise<string> =>
  until(() => toolMessage(id), `tool result of ${id} reached the model`)

/** 会话里某次工具调用的块（message.list） */
async function toolBlock(id: string): Promise<{ isError?: boolean } | undefined> {
  const messages = await app.main.eval<
    Array<{ blocks?: Array<{ type: string; toolCallId?: string; isError?: boolean }> }>
  >(`window.api.message.list(${JSON.stringify(nbSid)})`)
  for (const m of messages) {
    const b = (m.blocks ?? []).find((x) => x.type === 'tool' && x.toolCallId === id)
    if (b) return b
  }
  return undefined
}

/** 脚本化几轮（最后一轮缺省收一句话），经 IPC 发一句（不等它跑完） */
async function run(turns: FakeTurn[], text = 'go'): Promise<void> {
  provider.reset()
  await events.clear()
  provider.script(...turns.map((t) => ({ usage: USAGE, ...t })))
  await app.main.eval(
    `(window.api.agent.prompt({ sessionId: ${JSON.stringify(nbSid)}, text: ${JSON.stringify(text)} }).catch(() => undefined), true)`
  )
}

const runEnd = (): Promise<unknown> =>
  events.waitFor('agent_end', { sessionId: nbSid, timeoutMs: 30_000 })

/** 快轮询（痕迹看见之后约 2.6s 就移除，until 的 400ms 一拍可能错过） */
async function poll<T>(
  fn: () => T | Promise<T>,
  what: string,
  timeoutMs = 15_000,
  every = 40
): Promise<NonNullable<T>> {
  const t0 = Date.now()
  for (;;) {
    let v: T | undefined
    try {
      v = await fn()
    } catch {
      /* 未就绪 */
    }
    if (v) return v as NonNullable<T>
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs}ms): ${what}`)
    await sleep(every)
  }
}

const disk = (): string => readFileSync(docPath, 'utf8')

/** 打开这条笔记，等编辑器显示 marker */
async function openNotebook(marker: string): Promise<void> {
  await until(() => sidebar.openSession('nc.md'), 'notebook session opened')
  await until(
    async () => (await editor.text())?.includes(marker),
    `notebook editor shows ${JSON.stringify(marker)}`
  )
}

// ─── 用例 ─────────────────────────────────────────────────

describe('主窗口笔记本的协作编辑', () => {
  it('NC-1 编辑器开着：doc_read 报用户在哪；doc_edit 落在编辑器里、不重挂载、agent 的痕迹、自动保存写盘、不经安全询问', async () => {
    await openNotebook('Seed paragraph NC.')
    const tag = await editor.tagEditor()

    await run([
      { toolCalls: [call('nc1_read', 'doc_read', {})] },
      {
        toolCalls: [
          call('nc1_edit', 'doc_edit', {
            find: 'Seed paragraph NC.',
            replace: 'Agent paragraph NC.'
          })
        ]
      },
      { text: 'nc1-done' }
    ])
    // 痕迹看见之后约 2.6s 就移除 —— 从发出那一刻起就盯着
    const marks = await poll(async () => {
      const ms = await editor.changeMarks()
      return ms.some((m) => !m.external) ? ms : null
    }, 'agent (non-external) change mark')
    // 痕迹盖着 agent 改出来的字（至少盖住其中一段）
    const covered = marks.filter((m) => !m.external).map((m) => m.text.trim())
    expect(
      covered.some((t) => t !== '' && 'Agent paragraph NC.'.includes(t)),
      covered.join(' | ')
    ).toBe(true)
    await runEnd()

    const read = await waitToolMessage('nc1_read')
    expect(read).toContain('The user: cursor on line')
    expect(read).not.toContain(NOT_OPEN)
    expect(read).toContain('│Seed paragraph NC.')

    expect(await editor.text()).toContain('Agent paragraph NC.')
    expect(await editor.editorTag()).toBe(tag)
    await until(() => disk().includes('Agent paragraph NC.'), 'autosave wrote the agent edit')
    expect(disk()).toBe(SEED.replace('Seed paragraph NC.', 'Agent paragraph NC.'))

    const edit = await waitToolMessage('nc1_edit')
    expect(edit.startsWith('Replaced at line 3. The text there now:\n')).toBe(true)
    expect(securityDecisions(app).filter((d) => d.toolCallId === 'nc1_edit')).toEqual([])
    expect(await autoAllowed(app.main)).toEqual([])
  })

  it('NC-2 切到 Other：磁盘回落 —— doc_read 说没开着；agent_end 时盘上已是改后的字节；再打开读到新内容', async () => {
    const before = SEED.replace('Seed paragraph NC.', 'Agent paragraph NC.')
    await until(() => disk() === before, 'NC-1 edit saved before switching away')
    await until(() => sidebar.openSession('Other'), 'switched to the Other session')
    await until(async () => (await editor.text()) === null, 'notebook editor unmounted')

    await run([
      { toolCalls: [call('nc2_read', 'doc_read', {})] },
      {
        toolCalls: [
          call('nc2_edit', 'doc_edit', {
            find: 'Agent paragraph NC.',
            replace: 'Disk paragraph NC.'
          })
        ]
      },
      { text: 'nc2-done' }
    ])
    await runEnd()
    const expected = SEED.replace('Seed paragraph NC.', 'Disk paragraph NC.')
    // 一轮结束时磁盘上就是改后的字节（没有编辑器等着存）
    expect(disk()).toBe(expected)

    const read = await waitToolMessage('nc2_read')
    expect(read).toContain(NOT_OPEN)
    expect(read).not.toContain('The user:')
    expect(read).toContain('│Agent paragraph NC.')
    const edit = await waitToolMessage('nc2_edit')
    expect(edit).toBe('Replaced at line 3. The text there now:\n2│\n3│Disk paragraph NC.\n4│')
    expect(await autoAllowed(app.main)).toEqual([])

    // 这一轮发给的是笔记本会话：正显示着的 Other 一条消息都没有
    expect(
      await app.main.eval<unknown[]>(`window.api.message.list(${JSON.stringify(otherSid)})`)
    ).toEqual([])

    await openNotebook('Disk paragraph NC.')
    expect(await editor.text()).not.toContain('Agent paragraph NC.')
  })

  it('NC-3 切回来：新挂上的编辑器接手 —— 又是活的（报用户在哪、agent 的痕迹、不重挂载）', async () => {
    // NC-2 末尾已经重新打开了这条笔记
    expect(await editor.text()).toContain('Disk paragraph NC.')
    const tag = await editor.tagEditor()

    await run([
      { toolCalls: [call('nc3_read', 'doc_read', {})] },
      {
        toolCalls: [
          call('nc3_edit', 'doc_edit', {
            find: 'Disk paragraph NC.',
            replace: 'Back paragraph NC.'
          })
        ]
      },
      { text: 'nc3-done' }
    ])
    await poll(async () => {
      const ms = await editor.changeMarks()
      return ms.some((m) => !m.external)
    }, 'agent (non-external) change mark after the hand-over')
    await runEnd()

    const read = await waitToolMessage('nc3_read')
    expect(read).toContain('The user: cursor on line')
    expect(read).not.toContain(NOT_OPEN)
    expect(await editor.text()).toContain('Back paragraph NC.')
    expect(await editor.editorTag()).toBe(tag)
    await until(() => disk().includes('Back paragraph NC.'), 'autosave wrote the edit')
    expect(securityDecisions(app).filter((d) => d.toolCallId === 'nc3_edit')).toEqual([])
  })

  it('NC-4 write 碰这份文档（绝对 / 相对）→ 拒绝并指向 doc_*、块是红的、字节不变；写 other.md 照常', async () => {
    const expected = SEED.replace('Seed paragraph NC.', 'Back paragraph NC.')
    await until(() => disk() === expected, 'NC-3 edit saved')
    const otherPath = join(projDir, 'other.md')

    await run([
      {
        toolCalls: [
          call('nc4_abs', 'write', { path: docPath, content: 'clobbered (absolute)\n' }),
          call('nc4_rel', 'write', { path: 'notes/nc.md', content: 'clobbered (relative)\n' }),
          call('nc4_other', 'write', { path: 'other.md', content: 'a separate file\n' })
        ]
      },
      { text: 'nc4-done' }
    ])
    await runEnd()

    for (const id of ['nc4_abs', 'nc4_rel']) {
      expect(await waitToolMessage(id), id).toContain(REFUSAL)
      expect((await until(() => toolBlock(id), `${id} block listed`)).isError, id).toBe(true)
    }
    const other = await waitToolMessage('nc4_other')
    expect(other).toContain('Wrote')
    expect(other).not.toContain(REFUSAL)
    expect(
      (await until(() => toolBlock('nc4_other'), 'nc4_other block listed')).isError
    ).toBeFalsy()

    expect(disk()).toBe(expected)
    expect(await editor.text()).toContain('Back paragraph NC.')
    expect(await editor.text()).not.toContain('clobbered')
    expect(existsSync(otherPath)).toBe(true)
    expect(readFileSync(otherPath, 'utf8')).toBe('a separate file\n')
    expect(await autoAllowed(app.main)).toEqual([])
  })

  it('NC-5 回归：没存盘的输入 + 外部改了另一段 → 编辑器与盘两边都在，不重挂载', async () => {
    const base = SEED.replace('Seed paragraph NC.', 'Back paragraph NC.')
    await until(() => disk() === base, 'document settled before NC-5')
    // 「刚打过字」的窗口过去，免得上一条的状态混进来
    await sleep(1700)
    const tag = await editor.tagEditor()

    await editor.typeAtEnd('typed-nc5')
    // 自动保存的防抖（200ms）之内，别的程序改了另一段
    writeFileSync(docPath, base.replace('Second paragraph NC.', 'Second paragraph EXTERNAL.'))

    await until(async () => {
      const shown = (await editor.text()) ?? ''
      return shown.includes('typed-nc5') && shown.includes('Second paragraph EXTERNAL.')
    }, 'editor holds both the typing and the external change')
    await until(
      () => disk().includes('typed-nc5') && disk().includes('Second paragraph EXTERNAL.'),
      'disk holds both the typing and the external change'
    )
    // 落定后再看一遍：没有哪一边被后来的保存盖掉
    await sleep(1200)
    const finalDisk = disk()
    expect(finalDisk).toContain('typed-nc5')
    expect(finalDisk).toContain('Second paragraph EXTERNAL.')
    expect(finalDisk).toContain('Back paragraph NC.')
    expect(finalDisk.split('typed-nc5')).toHaveLength(2)
    const shown = (await editor.text()) ?? ''
    expect(shown).toContain('typed-nc5')
    expect(shown).toContain('Second paragraph EXTERNAL.')
    expect(await editor.editorTag()).toBe(tag)
  })
})
