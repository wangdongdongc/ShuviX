/**
 * 设置页「工作流」tab（WorkflowSettings + RegistryNoteView）。
 *
 * 与智能体 / 安全策略 tab 同形：内置工作流随包发布、没有文件，是原文的只读查看（给「创建覆盖副本」）；
 * 用户工作流的详情**就是这份 md 的笔记本会话**（隐藏项目 `__workflows__`，自动保存，没有保存按钮），
 * 列表选中项按文件名认。与另外两个 tab 唯一的呈现差异：结构合法但**脚本语法错**的文件，属性卡的
 * 解析器校验看不见 —— 拒绝原因只能由宿主挂在笔记上方的红框里（reasonText）。
 *
 * 用例间有顺序依赖：同一个设置窗口一路点下去（openSettings 对已存在的窗口只聚焦、不切 tab）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  registryNotePane,
  workflowsPane,
  type RegistryNotePane,
  type WorkflowsPane
} from '../../harness/pages'
import { REGISTRY_NOTE_PROJECT_IDS, noteWrite, registryNoteSessions } from '../../harness/seed'

const WORKFLOWS_PROJECT = REGISTRY_NOTE_PROJECT_IDS.workflow

interface WorkflowRow {
  name: string
  displayName: string
  triggers: string[]
  source: 'builtin' | 'user'
  overridden?: boolean
}

/** 最小合法用户工作流 md（与 workflowService.test.ts 的 userWf 同形） */
const userWf = (name: string, opts: { script?: string } = {}): string =>
  [
    '---',
    'shuvix: workflow v1',
    `name: '${name.replace(/'/g, "''")}'`,
    'shuvix-workflow-on:',
    '  - trigger: session.prompt-accepted',
    '---',
    '',
    '```js workflow',
    opts.script ?? 'return event.promptText',
    '```',
    ''
  ].join('\n')

let app: E2EApp
let pane: WorkflowsPane
let note: RegistryNotePane
/** 内置 auto-title 的显示名（随界面语言，经 IPC 取） */
let autoTitleLabel = ''

const workflowsDir = (): string => join(app.home, '.shuvix', 'workflows')
const wfPath = (fileName: string): string => join(workflowsDir(), fileName)
const listWorkflows = (): Promise<WorkflowRow[]> => app.main.eval('window.api.workflow.list()')
const listInvalid = (): Promise<Array<{ fileName: string; error: string }>> =>
  app.main.eval('window.api.workflow.listInvalid()')

beforeAll(async () => {
  app = await launchApp()
  mkdirSync(workflowsDir(), { recursive: true })
  writeFileSync(wfPath('wf-user.md'), userWf('wf-user'))
  const settings = await app.openSettings('workflows')
  pane = await workflowsPane(settings)
  note = registryNotePane(settings)
})
afterAll(async () => {
  await app.stop()
})

describe('工作流设置页', () => {
  it('WS-1 内置 auto-title：行副标题是它的触发器；详情只读（没有笔记、输入框全禁用），给覆盖副本入口、没有删除', async () => {
    const builtin = (await listWorkflows()).find(
      (w) => w.name === 'auto-title' && w.source === 'builtin'
    )!
    autoTitleLabel = builtin.displayName
    expect(builtin.triggers.length).toBeGreaterThan(0)
    const row = (await pane.rows()).find((r) => r.name === autoTitleLabel && r.builtin)
    expect(row?.trigger).toBe(builtin.triggers.join(', '))

    await pane.selectRow(autoTitleLabel, 'builtin')
    expect(await pane.noteFile()).toBe('')
    const inputs = await pane.inputs()
    expect(inputs.count).toBeGreaterThan(0)
    expect(inputs.disabled).toBe(true)
    const icons = await pane.headerIcons()
    expect(icons.copy).toBe(true)
    expect(icons.trash).toBe(false)
  })

  it('WS-2 用户工作流的详情就是它的笔记：一份文件一条 __workflows__ 会话，没有保存按钮、删除在头部；载体项目不进项目列表', async () => {
    await pane.selectRow('wf-user')
    expect(await pane.noteFile()).toBe('wf-user.md')
    const notes = await registryNoteSessions(app.main, WORKFLOWS_PROJECT)
    expect(notes.map((n) => n.notebookPath)).toEqual(['wf-user.md'])

    const icons = await pane.headerIcons()
    expect(icons.save).toBe(false)
    expect(icons.trash).toBe(true)

    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    expect(projectIds).not.toContain(WORKFLOWS_PROJECT)
  })

  it('WS-3 经笔记写进脚本语法错：选中项翻成「无法解析」行，红框与 listInvalid 给出原因，list 里没有它，笔记不重开；写回合法版翻回来', async () => {
    await note.mark()
    const broken = userWf('wf-user', { script: 'return ((( oops' })
    expect(await noteWrite(app.main, 'workflow', 'wf-user.md', broken)).toEqual({ ok: true })

    await until(async () => (await pane.selectedInvalid()) === 'wf-user.md', 'invalid row selected')
    await until(
      async () => (await pane.reasonText()).includes('script syntax error'),
      'reason box above the note'
    )
    expect((await listInvalid()).find((f) => f.fileName === 'wf-user.md')?.error).toContain(
      'script syntax error'
    )
    expect((await listWorkflows()).some((w) => w.name === 'wf-user')).toBe(false)
    expect(await note.isMarked()).toBe(true)

    expect(await noteWrite(app.main, 'workflow', 'wf-user.md', userWf('wf-user'))).toEqual({
      ok: true
    })
    await until(
      async () => (await pane.rows()).some((r) => r.name === 'wf-user' && !r.builtin && r.selected),
      'normal row selected again'
    )
    expect(await pane.reasonText()).toBe('')
    expect(await note.isMarked()).toBe(true)
  })

  it('WS-4 覆盖 auto-title 再经笔记写坏：写坏后内置照常生效、不被遮蔽；删除走按文件名那一路，删完回到内置', async () => {
    await pane.selectRow(autoTitleLabel, 'builtin')
    const source = await app.main.eval<{ text?: string; error?: string }>(
      `window.api.workflow.getSource({ name: 'auto-title', source: 'builtin' })`
    )
    expect(source.error).toBeUndefined()

    expect(await pane.clickCreateOverride()).toBe('auto-title.md')
    expect(readFileSync(wfPath('auto-title.md'), 'utf8')).toBe(source.text)
    const overrideLabel = (await listWorkflows()).find(
      (w) => w.name === 'auto-title' && w.source === 'user'
    )!.displayName
    await until(
      async () =>
        (await pane.rows()).some((r) => r.name === overrideLabel && !r.builtin && r.selected),
      'override row selected'
    )

    const broken = userWf('auto-title', { script: 'return ((( oops' })
    expect(await noteWrite(app.main, 'workflow', 'auto-title.md', broken)).toEqual({ ok: true })
    const rows = (await listWorkflows()).filter((w) => w.name === 'auto-title')
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('builtin')
    expect(rows[0].overridden).toBeFalsy()

    // 等选中项翻成非法行再删：头部此刻才按文件名删（它已解析不出 name）
    await until(
      async () => (await pane.selectedInvalid()) === 'auto-title.md',
      'broken override selected as an invalid file'
    )
    await pane.clickDelete()
    expect((await pane.confirmDialog()).description).toContain('auto-title.md')
    await pane.confirmDialogConfirm()

    await until(() => !existsSync(wfPath('auto-title.md')), 'auto-title.md deleted')
    await until(
      async () =>
        (await pane.rows()).some((r) => r.name === autoTitleLabel && r.builtin && r.selected),
      'builtin auto-title selected'
    )
    expect(await pane.noteFile()).toBe('')
  })

  it('WS-5 「新建」两次：my-workflow.md、my-workflow-2.md 都是合法工作流，后建的那份被选中', async () => {
    expect(await pane.clickNew()).toBe('my-workflow.md')
    expect(await pane.clickNew()).toBe('my-workflow-2.md')

    const users = (await listWorkflows()).filter((w) => w.source === 'user').map((w) => w.name)
    expect(users).toEqual(expect.arrayContaining(['my-workflow', 'my-workflow-2']))
    const invalid = (await listInvalid()).map((f) => f.fileName)
    expect(invalid).not.toContain('my-workflow.md')
    expect(invalid).not.toContain('my-workflow-2.md')

    await until(
      async () => (await pane.rows()).some((r) => r.name === 'my-workflow-2' && r.selected),
      'second new row selected'
    )
    expect(await pane.noteFile()).toBe('my-workflow-2.md')
  })
})
