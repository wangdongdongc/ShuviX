/**
 * agentSlotsOf —— 从管线 workflow 的 `shuvix-workflow-input` 读出 agent 槽位表。
 *
 * 约定（agentSlots.ts 文件头）：输入 schema 的 `properties.agents` 是一个 `type: object`，
 * 其 `required` 列出必填槽位，`properties` 逐槽位给出 `description`。这是读法的**单一出处**：
 * 设置页的槽位下拉与运行时读数都经它，免得两处各解一遍 schema。哪些槽位存在、哪些必填，
 * 管线文件说了算 —— 宿主没有缺省表。内置 bot-chat 的实际槽位在 builtinWorkflows.test.ts 钉。
 *
 * 用例先由契约枚举：
 *  AS-1 声明顺序 = properties 键序；required 标记来自 agents.required；description 透传
 *  AS-2 只在 required 里出现的槽位排在 properties 之后：required:true、无 description
 *  AS-3 无 inputSchema → []
 *  AS-4 schema 没有 agents / agents 不是对象 → []
 *  AS-5 description 缺失、非字符串或纯空白 → 不铺 description 键（不是 undefined 值）
 *  AS-6 required 里的非字符串条目忽略；properties 不是对象时只剩 required-only 槽位
 *  AS-7 同一槽位既在 properties 又在 required → 只出现一次
 */
import { describe, expect, it } from 'vitest'
import { agentSlotsOf } from '../agentSlots'

const withAgents = (agents: unknown): { inputSchema: Record<string, unknown> } => ({
  inputSchema: { type: 'object', properties: { bot: { type: 'object' }, agents } }
})

describe('agentSlotsOf', () => {
  it('AS-1 声明顺序 = properties 键序；required 来自 agents.required；description 透传', () => {
    const slots = agentSlotsOf(
      withAgents({
        type: 'object',
        required: ['task', 'intent'],
        properties: {
          intent: { type: 'string', description: 'Decides whether the bot speaks' },
          task: { type: 'string', description: '  Does the work  ' },
          recheck: { type: 'string', description: 'Optional re-judge' }
        }
      })
    )
    // 顺序是 properties 的键序（intent → task → recheck），不是 required 的顺序
    expect(slots).toStrictEqual([
      { role: 'intent', required: true, description: 'Decides whether the bot speaks' },
      // description 两端 trim（设置页当提示语用）
      { role: 'task', required: true, description: 'Does the work' },
      { role: 'recheck', required: false, description: 'Optional re-judge' }
    ])
  })

  it('AS-2 只在 required 里出现的槽位排在 properties 之后：required:true、无 description', () => {
    const slots = agentSlotsOf(
      withAgents({
        type: 'object',
        required: ['ghost', 'intent'],
        properties: { intent: { type: 'string', description: 'gate' } }
      })
    )
    expect(slots).toStrictEqual([
      { role: 'intent', required: true, description: 'gate' },
      { role: 'ghost', required: true }
    ])
  })

  it('AS-3 无 inputSchema → []（不接受入参的工作流没有槽位）', () => {
    expect(agentSlotsOf({ inputSchema: undefined })).toEqual([])
    expect(agentSlotsOf({})).toEqual([])
  })

  it.each([
    ['schema 没有 properties', { type: 'object' }],
    ['properties 里没有 agents', { type: 'object', properties: { bot: { type: 'object' } } }],
    ['agents 是字符串', { type: 'object', properties: { agents: 'nope' } }],
    ['agents 是 null', { type: 'object', properties: { agents: null } }],
    ['agents 是数字', { type: 'object', properties: { agents: 5 } }]
  ])('AS-4 %s → []', (_label, inputSchema) => {
    expect(agentSlotsOf({ inputSchema: inputSchema as Record<string, unknown> })).toEqual([])
  })

  it('AS-5 description 缺失 / 非字符串 / 纯空白 → 不铺 description 键', () => {
    const slots = agentSlotsOf(
      withAgents({
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string', description: 42 },
          c: { type: 'string', description: '   ' },
          d: 'not-an-object'
        }
      })
    )
    expect(slots).toStrictEqual([
      { role: 'a', required: false },
      { role: 'b', required: false },
      { role: 'c', required: false },
      { role: 'd', required: false }
    ])
    // 钉的是「键不存在」而不是「值为 undefined」—— 设置页按 `in` 判断要不要渲染提示行
    for (const slot of slots) expect(slot, slot.role).not.toHaveProperty('description')
  })

  it('AS-6 required 里的非字符串条目忽略；properties 不是对象时只剩 required-only 槽位', () => {
    expect(
      agentSlotsOf(
        withAgents({
          type: 'object',
          required: ['intent', 5, null, 'task'],
          properties: { intent: { type: 'string' } }
        })
      )
    ).toStrictEqual([
      { role: 'intent', required: true },
      { role: 'task', required: true }
    ])
    expect(
      agentSlotsOf(withAgents({ type: 'object', required: ['task'], properties: 'nope' }))
    ).toStrictEqual([{ role: 'task', required: true }])
    // required 不是数组 → 一律非必填
    expect(
      agentSlotsOf(
        withAgents({ type: 'object', required: 'task', properties: { task: { type: 'string' } } })
      )
    ).toStrictEqual([{ role: 'task', required: false }])
  })

  it('AS-7 同一槽位既在 properties 又在 required → 只出现一次（且带 description）', () => {
    const slots = agentSlotsOf(
      withAgents({
        type: 'object',
        required: ['task', 'task'],
        properties: { task: { type: 'string', description: 'work' } }
      })
    )
    expect(slots).toStrictEqual([{ role: 'task', required: true, description: 'work' }])
  })
})
