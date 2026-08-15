/**
 * agent 定义文件格式（IPC 层）：shuvix-tools 读写、shuvix-model 读写、通用 tools 忽略、
 * 新建/保存/删除的文件系统效果。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../harness/launch'
import { createAgentSession, writeAgentMd } from '../harness/seed'

let app: E2EApp

beforeAll(async () => {
  app = await launchApp()
  writeAgentMd(app, 'new-key', { description: 'uses shuvix-tools', tools: 'read, grep' })
  writeAgentMd(app, 'legacy-key', {
    description: 'uses legacy tools',
    rawLines: ['tools: read, grep']
  })
  // 手写一个当前解析不出来的模型值（隔离实例里没有任何已启用模型）
  writeAgentMd(app, 'unresolvable-model', {
    description: 'declares a model nobody has',
    tools: 'read, grep',
    model: 'no-such/model',
    body: 'UNRESOLVABLE MODEL BODY.'
  })
})
afterAll(async () => {
  await app.stop()
})

interface AgentRow {
  name: string
  source: string
  tools: string[]
  description: string
  model?: string
  instructionFiles: boolean
  projectPrompt: boolean
}

const listAgents = (): Promise<AgentRow[]> => app.main.eval('window.api.subAgent.list()')

describe('agent md 格式（纯 md 驱动）', () => {
  it('shuvix-tools 生效；通用 tools key 按未知 key 忽略（空白名单）', async () => {
    const list = await listAgents()
    expect(list.find((a) => a.name === 'new-key')?.tools).toEqual(['read', 'grep'])
    expect(list.find((a) => a.name === 'legacy-key')?.tools).toEqual([])
  })

  it('保存序列化写 shuvix-tools 与注入开关，无裸 tools key', async () => {
    const res = await app.main.eval<{ success: boolean }>(
      `window.api.subAgent.save({ originalName: 'new-key', agent: {
        name: 'new-key', displayName: 'new-key', description: 'd2', systemPrompt: 'B2.',
        tools: ['read'], instructionFiles: true, projectPrompt: false } })`
    )
    expect(res.success).toBe(true)
    const text = readFileSync(join(app.agentsDir, 'new-key.md'), 'utf8')
    expect(text).toContain('shuvix-tools: read')
    expect(text).toContain('shuvix-instruction-files: true')
    expect(text).not.toContain('shuvix-project-prompt')
    expect(text).not.toMatch(/^tools:/m)
  })

  it('shuvix-model 写路径：save 带值即写 key，再存空串即从文件消失', async () => {
    const save = (model: string): Promise<{ success: boolean }> =>
      app.main.eval(
        `window.api.subAgent.save({ originalName: 'unresolvable-model', agent: {
          name: 'unresolvable-model', displayName: 'unresolvable-model', description: 'd',
          systemPrompt: 'B.', tools: ['read'], model: ${JSON.stringify(model)},
          instructionFiles: false, projectPrompt: false } })`
      )
    const filePath = join(app.agentsDir, 'unresolvable-model.md')

    expect((await save('openai/gpt-x')).success).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toContain('shuvix-model: openai/gpt-x')
    expect((await listAgents()).find((a) => a.name === 'unresolvable-model')?.model).toBe(
      'openai/gpt-x'
    )

    // 空串 = 清除声明
    expect((await save('')).success).toBe(true)
    expect(readFileSync(filePath, 'utf8')).not.toContain('shuvix-model')
    expect((await listAgents()).find((a) => a.name === 'unresolvable-model')?.model).toBeUndefined()

    // 还原成手写的不可解析值，供下一条用例使用
    writeAgentMd(app, 'unresolvable-model', {
      description: 'declares a model nobody has',
      tools: 'read, grep',
      model: 'no-such/model',
      body: 'UNRESOLVABLE MODEL BODY.'
    })
  })

  it('声明不可用的模型 ≠ 档案非法：照常列出、tools/description 正常、可被切换', async () => {
    const row = (await listAgents()).find((a) => a.name === 'unresolvable-model')
    expect(row).toBeDefined()
    expect(row!.model).toBe('no-such/model')
    expect(row!.tools).toEqual(['read', 'grep'])
    expect(row!.description).toBe('declares a model nobody has')

    const { sid } = await createAgentSession(app.main)
    const res = await app.main.eval<{
      success: boolean
      applied?: { model?: unknown }
      modelUnavailable?: string
    }>(
      `window.api.session.updateAgentProfile({ id: ${JSON.stringify(sid)}, name: 'unresolvable-model' })`
    )
    expect(res.success).toBe(true)
    // 模型解析不出来 → 不写模型种子，原始声明值回传给前端提示
    expect(res.applied?.model).toBeUndefined()
    expect(res.modelUnavailable).toBe('no-such/model')
    const info = await app.main.eval<{ systemPrompt: string }>(
      `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`
    )
    expect(info.systemPrompt.startsWith('UNRESOLVABLE MODEL BODY.')).toBe(true)
  })

  it('新建：三字段必填 + 文件落盘；同名拒绝', async () => {
    const missing = await app.main.eval<{ success: boolean; error?: string }>(
      `window.api.subAgent.create({ agent: { name: 'x', displayName: 'x', description: '',
        systemPrompt: 'b', tools: [], instructionFiles: false, projectPrompt: false } })`
    )
    expect(missing.success).toBe(false)

    const created = await app.main.eval<{ success: boolean; name?: string }>(
      `window.api.subAgent.create({ agent: { name: 'made-by-ipc', displayName: 'made-by-ipc',
        description: 'd', systemPrompt: 'b', tools: [], instructionFiles: false, projectPrompt: false } })`
    )
    expect(created.success).toBe(true)
    expect(existsSync(join(app.agentsDir, 'made-by-ipc.md'))).toBe(true)

    const dup = await app.main.eval<{ success: boolean }>(
      `window.api.subAgent.create({ agent: { name: 'made-by-ipc', displayName: 'x',
        description: 'd', systemPrompt: 'b', tools: [], instructionFiles: false, projectPrompt: false } })`
    )
    expect(dup.success).toBe(false)
  })

  it('删除：文件消失且 list 即时反映（现扫，无需刷新 IPC）', async () => {
    const res = await app.main.eval<{ success: boolean }>(
      `window.api.subAgent.delete({ name: 'legacy-key' })`
    )
    expect(res.success).toBe(true)
    expect(existsSync(join(app.agentsDir, 'legacy-key.md'))).toBe(false)
    const list = await listAgents()
    expect(list.some((a) => a.name === 'legacy-key')).toBe(false)
  })
})
