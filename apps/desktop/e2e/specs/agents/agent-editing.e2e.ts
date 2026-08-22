/**
 * Agent 定义的**原文编辑链路**（`window.api.subAgent.getSource / createSource / saveSource`）。
 * 列表/注册表语义在 agents-registry.e2e.ts、GUI 表单写路径在 agent-md-format.e2e.ts，这里不重复。
 *
 * 契约与 policy 的原文编辑同形（见 policy-editing.e2e.ts），关注点也一致 ——
 * 「文件即事实」在读写两侧都成立：
 *   - getSource 逐字节回吐用户文件（注释/键序/空行原样）、按 frontmatter `name` 而非文件名
 *     定位 —— 原文编辑模型的前提；内置档案无文件，回写出的等价 md 必须自身合法，
 *     否则「创建覆盖副本」一开局就是坏文件；
 *   - create/save **非法一律拒绝写盘**且旧内容零损伤 —— 一份存在但非法的档案会被扫描
 *     静默跳过（不生效也不遮蔽内置），正是编辑器要消灭的失败模式；
 *   - 改名以 frontmatter `name` 为准、文件路径不变；
 *   - 落盘即生效：覆盖 default 后**下一个会话的系统提示词真的换人**，删除后复原。
 *
 * agent 侧与 policy 的差异都在这里：`{{shuvix:*}}` 会话变量必须原样留给 createAgent、
 * 工具名归一是读时投影（磁盘原文不被改写）、系统提示词可经 createAgentSession 直接断言。
 *
 * 断言全部走 IPC（window.api.subAgent.*）+ fs 直读，不碰任何 DOM。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createAgentSession } from '../../harness/seed'

let app: E2EApp

beforeAll(async () => {
  app = await launchApp()
})
afterAll(async () => {
  await app.stop()
})

type SourceResult = { text: string } | { error: string }
type WriteResult = { success: boolean; name?: string; error?: string }

interface AgentRow {
  name: string
  source: 'builtin' | 'user'
  description: string
  tools: string[]
  systemPrompt: string
  basePath: string
  overridden?: boolean
}

const mdText = (...lines: string[]): string => lines.join('\n')

/** 最小合法 agent md（frontmatter name 为准；文件名只是默认值） */
const simpleAgent = (opts: {
  name: string
  description?: string
  tools?: string
  body?: string
}): string =>
  mdText(
    '---',
    'shuvix: agent v1',
    `name: ${opts.name}`,
    `description: ${opts.description ?? 'e2e agent'}`,
    ...(opts.tools ? [`shuvix-tools: ${opts.tools}`] : []),
    '---',
    '',
    opts.body ?? 'Body.',
    ''
  )

/** 注入开关写成非布尔 → 解析器判整份非法（人读原因带键名 + rejected） */
const invalidAgent = (name: string): string =>
  mdText(
    '---',
    'shuvix: agent v1',
    `name: ${name}`,
    'shuvix-project-prompt: yes please',
    '---',
    '',
    'Invalid body.',
    ''
  )

const agentFiles = (): string[] =>
  existsSync(app.agentsDir) ? readdirSync(app.agentsDir).sort() : []
const readAgentFile = (fileName: string): string =>
  readFileSync(join(app.agentsDir, fileName), 'utf-8')
const hasAgentFile = (fileName: string): boolean => existsSync(join(app.agentsDir, fileName))
/** 绕过 IPC 直接把文件丢进目录（构造「文件名与 name 不一致」这类素材） */
const writeAgentFile = (fileName: string, text: string): void => {
  mkdirSync(app.agentsDir, { recursive: true })
  writeFileSync(join(app.agentsDir, fileName), text, 'utf-8')
}

const listAgents = (): Promise<AgentRow[]> => app.main.eval('window.api.subAgent.list()')
const getSource = (name: string, source: 'builtin' | 'user'): Promise<SourceResult> =>
  app.main.eval(`window.api.subAgent.getSource(${JSON.stringify({ name, source })})`)
const createSource = (text: string): Promise<WriteResult> =>
  app.main.eval(`window.api.subAgent.createSource(${JSON.stringify({ text })})`)
const saveSource = (originalName: string, text: string): Promise<WriteResult> =>
  app.main.eval(`window.api.subAgent.saveSource(${JSON.stringify({ originalName, text })})`)
const deleteAgent = (name: string): Promise<WriteResult> =>
  app.main.eval(`window.api.subAgent.delete(${JSON.stringify({ name })})`)

describe('agent md 原文 IPC —— 取原文 / 新建 / 覆写', () => {
  it('AE-1 首次 createSource 懒创建 agents 目录（此前 ~/.shuvix/agents 不存在）', async () => {
    // 本用例必须跑在任何 agent 文件写入之前 —— 目录是第一次写才建的
    expect(existsSync(app.agentsDir)).toBe(false)
    expect(await createSource(simpleAgent({ name: 'ae1-lazy-dir' }))).toEqual({
      success: true,
      name: 'ae1-lazy-dir'
    })
    expect(existsSync(app.agentsDir)).toBe(true)
    expect(agentFiles()).toEqual(['ae1-lazy-dir.md'])
  })

  const RAW_FIDELITY = mdText(
    '---',
    'shuvix: agent v1',
    '# 注释与非规范键序：getSource 必须逐字节回吐，不得被 serialize 规范化',
    'shuvix-tools: Read, grep',
    'name: ae2-raw',
    'description: raw fidelity',
    'shuvix-builtin: true',
    '---',
    '',
    'Body line one.',
    '',
    '',
    'Body line two, after two blank lines.',
    ''
  )

  it('AE-2 用户档案逐字节回吐（注释 / 非规范键序 / 未知键 / 正文空行原样），且按 name 而非文件名定位', async () => {
    // 文件名 ae2-file.md 与 frontmatter name: ae2-raw 刻意不一致
    writeAgentFile('ae2-file.md', RAW_FIDELITY)

    // 全等而非 toContain —— 原文编辑模型的整个前提就是「读回来的就是磁盘上的字节」
    expect(await getSource('ae2-raw', 'user')).toEqual({ text: RAW_FIDELITY })
    // 文件名不是标识：按 basename 查不到
    expect(await getSource('ae2-file', 'user')).toEqual({ error: 'Agent "ae2-file" not found' })
    // user 源不得回吐内置文本（否则「编辑用户档案」会静默变成编辑内置副本）
    expect(await getSource('coding', 'user')).toEqual({ error: 'Agent "coding" not found' })
    expect(await getSource('no-such-agent', 'builtin')).toEqual({
      error: 'Builtin agent "no-such-agent" not found'
    })
  })

  it('AE-3 内置回写等价 md：自身经 shuvixMd.validate 判合法，会话变量原样、无自述标记', async () => {
    const result = await getSource('default', 'builtin')
    expect('text' in result).toBe(true)
    const { text } = result as { text: string }

    // 「创建覆盖副本」的初值必须自身合法 —— 否则用户一开局拿到的就是不生效的坏文件
    const validation = await app.main.eval<{ status: string; messages: string[] }>(
      `window.api.shuvixMd.validate({ type: 'agent', text: ${JSON.stringify(text)} })`
    )
    expect(validation).toEqual({ status: 'valid', messages: [] })

    // 会话级变量在 createAgent 才替换 —— 副本里必须还是占位符，否则用户拿到的是别人的环境
    expect(text).toContain('{{shuvix:workingDirectory}}')
    // 序列化键集是固定白名单：复制一份内置去改不会自称内置
    expect(text).not.toContain('shuvix-builtin')
  })

  it('AE-4 createSource 落盘即被 subAgent.list 消费：磁盘原文一字不动，列表给归一后的工具名', async () => {
    const text = simpleAgent({
      name: 'ae4-normalized',
      tools: 'Read, GREP , read, MCP:Ctx7',
      body: 'AE4 body.'
    })
    expect(await createSource(text)).toEqual({ success: true, name: 'ae4-normalized' })
    // 不重序列化：写进去什么样，磁盘上就什么样
    expect(readAgentFile('ae4-normalized.md')).toBe(text)

    const row = (await listAgents()).find((a) => a.name === 'ae4-normalized')!
    expect(row.source).toBe('user')
    // 归一是读时投影：内置名小写、mcp: 前缀小写而 server 名保留大小写、去重保序
    expect(row.tools).toEqual(['read', 'grep', 'mcp:Ctx7'])
  })

  it('AE-5 非法 createSource 被拒且目录零新增（拒绝原因即解析器原文）', async () => {
    const before = agentFiles()
    const result = await createSource(invalidAgent('ae5-invalid'))
    expect(result.success).toBe(false)
    expect(result.error).toContain("'shuvix-project-prompt' must be a boolean")
    expect(result.error).toContain('the whole file is rejected')
    expect(agentFiles()).toEqual(before)
  })

  it('AE-6 saveSource 改名不搬家：文件路径不变，旧名查不到、新名回吐新原文', async () => {
    // 文件名与 name 刻意不一致，改名后文件名也不会跟着变
    writeAgentFile('ae6-file.md', simpleAgent({ name: 'ae6-src', body: 'AE6 v1.' }))
    const renamed = simpleAgent({ name: 'ae6-dst', tools: 'read', body: 'AE6 v2.' })
    expect(await saveSource('ae6-src', renamed)).toEqual({ success: true })

    expect(hasAgentFile('ae6-file.md')).toBe(true)
    expect(hasAgentFile('ae6-dst.md')).toBe(false)
    expect(readAgentFile('ae6-file.md')).toBe(renamed)

    const list = await listAgents()
    expect(list.some((a) => a.name === 'ae6-src')).toBe(false)
    expect(list.find((a) => a.name === 'ae6-dst')!.basePath).toBe(
      join(app.agentsDir, 'ae6-file.md')
    )
    expect(await getSource('ae6-src', 'user')).toEqual({ error: 'Agent "ae6-src" not found' })
    expect(await getSource('ae6-dst', 'user')).toEqual({ text: renamed })
  })

  it('AE-7 非法 saveSource 被拒且旧内容零损伤（磁盘逐字节不变、list 仍是旧内容）', async () => {
    const before = readAgentFile('ae6-file.md')
    const result = await saveSource('ae6-dst', invalidAgent('ae6-dst'))
    expect(result.success).toBe(false)
    expect(result.error).toContain("'shuvix-project-prompt' must be a boolean")
    expect(result.error).toContain('the whole file is rejected')

    expect(readAgentFile('ae6-file.md')).toBe(before)
    expect((await listAgents()).find((a) => a.name === 'ae6-dst')!.tools).toEqual(['read'])
  })

  it('AE-8 覆盖内置 default：下一个会话的系统提示词换成覆盖 body，delete 后复原', async () => {
    const override = simpleAgent({
      name: 'default',
      description: 'e2e override via createSource',
      tools: 'read',
      body: 'AE8 OVERRIDE BODY.'
    })
    expect(await createSource(override)).toEqual({ success: true, name: 'default' })
    const rows = (await listAgents()).filter((a) => a.name === 'default')
    expect(rows.map((r) => [r.source, !!r.overridden]).sort()).toEqual([
      ['builtin', true],
      ['user', false]
    ])

    // 落盘即生效：createAgentSession 的 systemPrompt 与实际发给 LLM 的完全一致
    const overridden = await createAgentSession(app.main, { title: 'ae8-overridden' })
    expect(overridden.systemPrompt.startsWith('AE8 OVERRIDE BODY.')).toBe(true)

    expect(await deleteAgent('default')).toEqual({ success: true })
    expect(hasAgentFile('default.md')).toBe(false)
    const restored = await createAgentSession(app.main, { title: 'ae8-restored' })
    expect(restored.systemPrompt.startsWith('AE8 OVERRIDE BODY.')).toBe(false)
  })

  it('AE-9 对内置名直接 saveSource（未先建覆盖副本）→ not found，磁盘不产生文件', async () => {
    // 内置档案无文件：必须先「创建覆盖副本」（createSource），save 无从定位
    expect(await saveSource('explore', simpleAgent({ name: 'explore' }))).toEqual({
      success: false,
      error: 'Agent "explore" not found'
    })
    expect(hasAgentFile('explore.md')).toBe(false)
    expect((await listAgents()).filter((a) => a.name === 'explore')).toHaveLength(1)
  })
})
