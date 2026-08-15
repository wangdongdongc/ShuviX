/**
 * 设置页「智能体」tab 的 UI 呈现（薄 DOM 层，经 harness/pages 选择器）。
 * 运行时语义（覆盖生效/删除效果等）在 agents-registry.e2e.ts 走 IPC 断言。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../harness/launch'
import { agentsPane, type AgentsPane } from '../harness/pages'
import { writeAgentMd } from '../harness/seed'

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

  it('内置详情：描述字段标签、两个注入开关、无删除按钮', async () => {
    const detail = await pane.detail()
    expect(detail.labels).toContain('Description')
    expect(detail.labels.some((l) => /When to use/i.test(l))).toBe(false)
    expect(detail.injectionToggles).toBe(2)
    expect(detail.hasDeleteButton).toBe(false)
  })

  it('自定义详情：有删除按钮', async () => {
    await pane.selectRow('my-agent')
    const detail = await pane.detail()
    expect(detail.hasDeleteButton).toBe(true)
  })
})
