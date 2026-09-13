/**
 * 设置页「智能体」tab 的 UI 呈现（薄 DOM 层，经 harness/pages 选择器）。
 *
 * 自定义档案的详情**就是这份 md 的笔记本会话**（隐藏项目 `__agents__`，自动保存，没有保存按钮）；
 * 内置档案没有文件，是等价 md 的只读查看，「创建覆盖副本」落一份同名用户文件再打开它的笔记。
 * 列表的选中项按**文件名**认：改名、写坏、修好，开着的都是同一份笔记（mark / isMarked 钉的是
 * 「没被卸载重开」）。写到一半解析不过的档案不进注册表（同名内置照常生效），列在「无法解析」
 * 分组里 —— 这个 tab 没有另起的原因框，解析器的判定由笔记里属性卡的横幅给出。
 * 运行时语义（覆盖生效 / 删除效果等）在 agents-registry.e2e.ts 走 IPC 断言。
 *
 * 用例间有顺序依赖：同一个设置窗口一路点下去（openSettings 对已存在的窗口只聚焦、不切 tab）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  agentsPane,
  registryNotePane,
  sidebarPane,
  type AgentsPane,
  type RegistryNotePane
} from '../../harness/pages'
import {
  REGISTRY_NOTE_PROJECT_IDS,
  noteWrite,
  registryNoteSessions,
  waitRendererReady,
  writeAgentMd
} from '../../harness/seed'

const AGENTS_PROJECT = REGISTRY_NOTE_PROJECT_IDS.agent

interface AgentRow {
  name: string
  displayName: string
  source: 'builtin' | 'user'
  overridden?: boolean
}

let app: E2EApp
let pane: AgentsPane
let note: RegistryNotePane
/** 内置 explore 的显示名（随界面语言本地化，经 IPC 取） */
let exploreLabel = ''
/** explore 覆盖副本（用户行）的显示名 —— 取自副本自己的 frontmatter，经 IPC 取 */
let overrideLabel = ''
/** 内置 explore 的等价 md（覆盖副本的初值） */
let exploreSource = ''

const agentPath = (fileName: string): string => join(app.agentsDir, fileName)
const listAgents = (): Promise<AgentRow[]> => app.main.eval('window.api.subAgent.list()')

/** 注入开关写成非布尔 → 解析器判整份非法（人读原因带键名 + rejected） */
const invalidAgent = (name: string): string =>
  [
    '---',
    'shuvix: agent v1',
    `name: ${name}`,
    'shuvix-project-awareness: yes please',
    '---',
    '',
    'Invalid body.',
    ''
  ].join('\n')

beforeAll(async () => {
  app = await launchApp()
  writeAgentMd(app, 'my-agent', { description: 'user agent', tools: 'read' })
  const settings = await app.openSettings('agents')
  pane = await agentsPane(settings)
  note = registryNotePane(settings)
})
afterAll(async () => {
  await app.stop()
})

describe('智能体设置页', () => {
  it('ST-1 列表：内置 + 自定义合并展示、无覆盖徽标；解析不过的文件重扫后进「无法解析」分组而不混进正常行', async () => {
    const rows = await pane.rows()
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(rows.some((r) => r.displayName === 'my-agent')).toBe(true)
    expect(rows.every((r) => !r.overriddenBadge)).toBe(true)

    writeFileSync(agentPath('st1-broken.md'), invalidAgent('st1-broken'))
    await pane.refresh()
    expect(await pane.invalidRows()).toContain('st1-broken.md')
    expect((await pane.rows()).some((r) => r.displayName === 'st1-broken')).toBe(false)
  })

  it('ST-2 内置详情：md 原文 + 属性卡，只读靠禁用体现（控件形态与可编辑态一致）；没有笔记，给覆盖副本入口', async () => {
    const first = (await pane.rows())[0]
    expect(first.builtin).toBe(true) // 内置恒置顶
    await pane.selectRow(first.displayName, 'builtin')

    const detail = await pane.detail()
    expect(detail.cardBadge).toBe('ShuviX agent · v1')
    // 字段行按契约键断言（locale-free）：描述与两项注入声明都在卡上
    expect(detail.fieldKeys).toContain('description')
    expect(detail.fieldKeys).toContain('shuvix-instruction-files')
    expect(detail.fieldKeys).toContain('shuvix-project-awareness')
    // 内置档案随包发布、无文件：控件**照常渲染**（槽位与可编辑态同为 3），只读通过禁用体现
    expect(detail.togglesDisabled).toBe(true)
    expect(detail.slots).toBe(3)
    expect(detail.hasSaveButton).toBe(false)
    expect(detail.hasDeleteButton).toBe(false)
    expect(await pane.noteFile()).toBe('')
    expect((await pane.headerIcons()).copy).toBe(true)
  })

  it('ST-3 自定义详情就是这份文件的笔记：可编辑（三个槽位、开关可用），没有保存按钮，删除在头部', async () => {
    await pane.selectRow('my-agent')
    expect(await pane.noteFile()).toBe('my-agent.md')

    const detail = await pane.detail()
    expect(detail.slots).toBe(3) // model + tools + instruction-files 各挂一个真控件
    expect(detail.toggles).toBeGreaterThan(0)
    expect(detail.togglesDisabled).toBe(false)
    expect(detail.hasSaveButton).toBe(false)
    expect(detail.hasDeleteButton).toBe(true)

    const notes = await registryNoteSessions(app.main, AGENTS_PROJECT)
    expect(notes.filter((n) => n.notebookPath === 'my-agent.md')).toHaveLength(1)
  })

  it('ST-4 「添加」按模板落一份 my-agent-2.md（名字避开已有的 my-agent），选中并打开它的笔记', async () => {
    expect(await pane.clickNew()).toBe('my-agent-2.md')
    expect(existsSync(agentPath('my-agent-2.md'))).toBe(true)
    expect((await listAgents()).find((a) => a.name === 'my-agent-2')?.source).toBe('user')
    await until(
      async () => (await pane.rows()).some((r) => r.displayName === 'my-agent-2' && r.selected),
      'new agent row selected'
    )
    expect(await pane.noteFile()).toBe('my-agent-2.md')
  })

  it('ST-5 内置「创建覆盖副本」：同名用户文件逐字节等于内置等价 md 并被选中；内置行划线带覆盖徽标、不再给覆盖入口', async () => {
    const builtin = (await listAgents()).find(
      (a) => a.name === 'explore' && a.source === 'builtin'
    )!
    exploreLabel = builtin.displayName
    const source = await app.main.eval<{ text?: string; error?: string }>(
      `window.api.subAgent.getSource({ name: 'explore', source: 'builtin' })`
    )
    expect(source.error).toBeUndefined()
    exploreSource = source.text!

    await pane.selectRow(exploreLabel, 'builtin')
    expect(await pane.clickCreateOverride()).toBe('explore.md')
    expect(readFileSync(agentPath('explore.md'), 'utf8')).toBe(exploreSource)

    overrideLabel = (await listAgents()).find(
      (a) => a.name === 'explore' && a.source === 'user'
    )!.displayName
    await until(async () => {
      const rows = await pane.rows()
      return (
        rows.some((r) => r.displayName === overrideLabel && !r.builtin && r.selected) &&
        rows.some(
          (r) => r.displayName === exploreLabel && r.builtin && r.struck && r.overriddenBadge
        )
      )
    }, 'override row selected, builtin row struck')
    expect(await pane.noteFile()).toBe('explore.md')

    // 被遮蔽的内置不再给覆盖入口（再建一份只会撞名）
    await pane.selectRow(exploreLabel, 'builtin')
    expect((await pane.headerIcons()).copy).toBe(false)
  })

  it('ST-6 覆盖副本写坏（写路径 IPC）：选中项翻成「无法解析」行、笔记不重开、卡片横幅给原因、内置恢复生效；写回合法版再翻回来', async () => {
    await pane.selectRow(overrideLabel, 'user')
    await note.mark()

    expect(await noteWrite(app.main, 'agent', 'explore.md', invalidAgent('explore'))).toEqual({
      ok: true
    })
    await until(async () => (await pane.selectedInvalid()) === 'explore.md', 'invalid row selected')
    expect(await pane.headerTitle()).toBe('explore.md')
    // 原因在笔记里属性卡的横幅上 —— 这个 tab 不另起原因框
    await until(
      async () => (await note.bannerText()).includes('must be a boolean'),
      'card banner shows the parser verdict'
    )
    expect(await pane.reasonText()).toBe('')
    // 非法文件不遮蔽内置
    const shadowed = (await listAgents()).filter((a) => a.name === 'explore')
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0].source).toBe('builtin')
    expect(shadowed[0].overridden).toBeFalsy()
    expect(await note.isMarked()).toBe(true)

    expect(await noteWrite(app.main, 'agent', 'explore.md', exploreSource)).toEqual({ ok: true })
    await until(
      async () =>
        (await pane.rows()).some(
          (r) => r.displayName === overrideLabel && !r.builtin && r.selected
        ),
      'override row selected again'
    )
    expect(
      (await listAgents()).find((a) => a.name === 'explore' && a.source === 'builtin')?.overridden
    ).toBe(true)
    expect(await note.isMarked()).toBe(true)
  })

  it('ST-7 头部删除 → 确认后文件没了：恢复生效的内置 explore 被选中（无覆盖徽标），详情里没有笔记，文件不被写回', async () => {
    await pane.clickDelete()
    expect((await pane.confirmDialog()).open).toBe(true)
    await pane.confirmDialogConfirm()

    await until(() => !existsSync(agentPath('explore.md')), 'explore.md deleted')
    await until(
      async () =>
        (await pane.rows()).some((r) => r.displayName === exploreLabel && r.builtin && r.selected),
      'restored builtin selected'
    )
    const restored = (await pane.rows()).filter((r) => r.displayName === exploreLabel)
    expect(restored).toHaveLength(1)
    expect(restored[0].overriddenBadge).toBe(false)
    expect(restored[0].struck).toBe(false)
    expect(await pane.noteFile()).toBe('')
    await sleep(700)
    expect(existsSync(agentPath('explore.md'))).toBe(false)
  })

  it('ST-8 笔记会话在主窗里隐身：项目列表没有 __agents__，侧栏会话列表里没有这些笔记', async () => {
    await waitRendererReady(app.main)
    const notes = await registryNoteSessions(app.main, AGENTS_PROJECT)
    // 会话本身在（session.list 看得见，删文件也不级联）—— 隐身是列表层的过滤
    expect(notes.map((n) => n.notebookPath)).toEqual(
      expect.arrayContaining(['my-agent.md', 'my-agent-2.md', 'explore.md'])
    )
    const projectIds = await app.main.eval<string[]>(
      `window.api.project.list().then((ps) => ps.map((p) => p.id))`
    )
    expect(projectIds).not.toContain(AGENTS_PROJECT)

    // 先让一条普通会话上屏作对照，免得「列表为空」让否定断言空转
    await app.main.eval(`window.api.session.create({ title: 'st8-visible-session' })`)
    const sidebar = sidebarPane(app.main)
    await until(
      async () => (await sidebar.titles()).includes('st8-visible-session'),
      'control session listed in the sidebar'
    )
    const titles = await sidebar.titles()
    for (const n of notes) expect(titles, n.notebookPath).not.toContain(n.title)
  })
})
