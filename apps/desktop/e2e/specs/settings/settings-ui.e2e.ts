/**
 * 设置页「智能体」tab 的 UI 呈现（薄 DOM 层，经 harness/pages 选择器）。
 * 运行时语义（覆盖生效/删除效果等）在 agents-registry.e2e.ts 走 IPC 断言。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
    // 内置档案随包发布、无文件：只读。控件**照常渲染**（槽位与可编辑态同为 2），
    // 只读通过禁用体现 —— 两种模式换的不是长相，只是可否交互
    expect(detail.togglesDisabled).toBe(true)
    expect(detail.slots).toBe(2)
    expect(detail.hasSaveButton).toBe(false)
    expect(detail.hasDeleteButton).toBe(false)
  })

  it('自定义详情：可编辑（模型/工具槽位、开关可用）+ 保存与删除', async () => {
    await pane.selectRow('my-agent')
    const detail = await pane.detail()
    expect(detail.slots).toBe(2) // model + tools 各挂一个真选择器
    expect(detail.togglesDisabled).toBe(false)
    expect(detail.hasSaveButton).toBe(true)
    expect(detail.hasDeleteButton).toBe(true)
  })
})
