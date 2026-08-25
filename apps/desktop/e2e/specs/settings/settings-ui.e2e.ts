/**
 * 设置页「智能体」tab 的 UI 呈现（薄 DOM 层，经 harness/pages 选择器）。
 * 运行时语义（覆盖生效/删除效果等）在 agents-registry.e2e.ts 走 IPC 断言。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { agentsPane, type AgentsPane } from '../../harness/pages'
import { writeAgentMd } from '../../harness/seed'

let app: E2EApp
let pane: AgentsPane

beforeAll(async () => {
  app = await launchApp()
  writeAgentMd(app, 'my-agent', { description: 'user agent', tools: 'read' })
  pane = await agentsPane(await app.openSettings('agents'))
})
afterAll(async () => {
  await app.stop()
})

describe('智能体设置页', () => {
  it('列表：内置 + 自定义合并展示，行内无启停 Toggle 形态的徽标', async () => {
    const rows = await pane.rows()
    expect(rows.length).toBeGreaterThanOrEqual(6)
    expect(rows.some((r) => r.displayName === 'my-agent')).toBe(true)
    expect(rows.every((r) => !r.overriddenBadge)).toBe(true)
  })

  it('内置详情：md 原文 + 属性卡；只读靠禁用体现（控件形态与可编辑态一致）', async () => {
    const detail = await pane.detail()
    expect(detail.cardBadge).toBe('ShuviX agent · v1')
    // 字段行按契约键断言（locale-free）：描述与两个注入开关都在卡上
    expect(detail.fieldKeys).toContain('description')
    expect(detail.fieldKeys).toContain('shuvix-instruction-files')
    expect(detail.fieldKeys).toContain('shuvix-project-prompt')
    // 内置档案随包发布、无文件：只读。控件**照常渲染**（槽位与可编辑态同为 3），
    // 只读通过禁用体现 —— 两种模式换的不是长相，只是可否交互
    expect(detail.togglesDisabled).toBe(true)
    expect(detail.slots).toBe(3)
    expect(detail.hasSaveButton).toBe(false)
    expect(detail.hasDeleteButton).toBe(false)
  })

  it('自定义详情：可编辑（模型/工具/指令文件槽位、开关可用）+ 保存与删除', async () => {
    await pane.selectRow('my-agent')
    const detail = await pane.detail()
    expect(detail.slots).toBe(3) // model + tools + instruction-files 各挂一个真控件
    expect(detail.togglesDisabled).toBe(false)
    expect(detail.hasSaveButton).toBe(true)
    expect(detail.hasDeleteButton).toBe(true)
  })
})

/**
 * 新建对话框的滚动回归。
 *
 * 对话框卡片是 `h-[85vh] flex flex-col`，编辑器靠 `flex-1 min-h-0 overflow-y-auto` 自滚；
 * 中间那层容器一旦不是 flex 列，那两个类全部失效 —— 编辑器高度撑成整份文档的高度，
 * 长档案（内置 md 几千字）直接从对话框底下溢出去，保存按钮还在，内容却翻不到。
 * 修复前实测：卡片 527px、编辑器 clientHeight 5405px、下溢 4928px。
 *
 * 素材必须是**长文档**才照得出问题，故走「创建覆盖副本」入口（预填整份内置 md），
 * 而不是新建模板那十来行。
 */
describe('新建对话框：长档案可滚不溢出', () => {
  // 断言中途失败会把对话框留在屏上，下一条就会在「开着的对话框里」跑（内容还是上一份 md）。
  // 兜底关掉，让失败停在真正出问题的那一条上。
  afterEach(async () => {
    await pane.closeCreateDialog()
  })

  it('DLG-E-1 卡片零溢出 + 编辑器被容纳在卡内且真的能滚', async () => {
    // 前一条用例把选中行切到了 my-agent（自定义档案没有「创建覆盖副本」入口），
    // 这里必须先切回内置行
    const rows = await pane.rows()
    await pane.selectRow(rows[0].displayName) // 内置恒置顶
    expect((await pane.detail()).hasSaveButton).toBe(false)

    await pane.openCreateDialog('override')
    const m = await pane.createDialogMetrics()

    // ① 素材有效性：文档确实比可视区高出一大截，否则下面几条全是空断言
    expect(m.scrollerScrollHeight - m.scrollerClientHeight).toBeGreaterThan(500)
    // ② 卡片自身零溢出（85vh 的那层不该被内容撑开）
    expect(m.cardScrollHeight - m.cardClientHeight).toBeLessThanOrEqual(1)
    // ③ 编辑器被容纳在卡内：既不比卡高，底边也没越过卡底
    expect(m.scrollerClientHeight).toBeLessThanOrEqual(m.cardClientHeight)
    expect(m.scrollerBottom).toBeLessThanOrEqual(m.cardBottom + 1)
    // ④ 真的能滚：拉到底到位、复位回零（`overflow: visible` 时 scrollTop 恒为 0）
    const bottom = await pane.scrollCreateDialogToBottom()
    expect(bottom).toBeGreaterThan(0)
    expect(bottom).toBeGreaterThanOrEqual(m.scrollerScrollHeight - m.scrollerClientHeight - 2)
    expect(await pane.scrollCreateDialogToTop()).toBe(0)
    // ⑤ 布局契约：自滚的是**装着编辑器**的那一层
    expect(['auto', 'scroll']).toContain(m.scrollerOverflowY)
    expect(m.scrollerHasEditor).toBe(true)

    await pane.closeCreateDialog()

    // 短文档入口同样成立（不溢出、编辑器在滚动体内）—— 两个入口共用一套布局
    await pane.openCreateDialog('add')
    const short = await pane.createDialogMetrics()
    expect(short.cardScrollHeight - short.cardClientHeight).toBeLessThanOrEqual(1)
    expect(short.scrollerClientHeight).toBeLessThanOrEqual(short.cardClientHeight)
    expect(short.scrollerBottom).toBeLessThanOrEqual(short.cardBottom + 1)
    expect(['auto', 'scroll']).toContain(short.scrollerOverflowY)
    expect(short.scrollerHasEditor).toBe(true)
    await pane.closeCreateDialog()
  })

  it('DLG-E-2 预填模板本身就是合法档案：打开「添加」直接保存即落盘', async () => {
    // 模板的 name 恰好是 my-agent，与 beforeAll 种的那份同名 —— 不先让位就会撞
    // 「已存在」，于是「模板合法吗」这件事根本测不到（错误被重名掩盖）
    const removed = await app.main.eval<{ success: boolean }>(
      `window.api.subAgent.delete({ name: 'my-agent' })`
    )
    expect(removed.success).toBe(true)

    await pane.openCreateDialog('add')
    // 保存成功才会自行关闭 —— 模板里任何一个键写错都停在这里
    await pane.saveCreateDialog()

    const names = await app.main.eval<string[]>(
      `window.api.subAgent.list().then((rows) => rows.map((r) => r.name))`
    )
    expect(names).toContain('my-agent')
  })
})
