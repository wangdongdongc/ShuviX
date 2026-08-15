/**
 * 种子与常用流程助手 —— 把本仓 e2e 的固定习语收拢在一处：
 *
 *   - agent md 种子直接写 fake HOME 的 ~/.shuvix/agents（subAgent.list 每次现扫文件系统）；
 *   - 「创建 Agent 而不触发 LLM」用 `agent.getInfo(sid, { ensure: true })`（ensure 只做懒创建
 *     并回快照，不发任何请求）；
 *   - 「触发首条 prompt 的注入路径」允许 LLM 调用失败（隔离实例无 API key）——
 *     prompt 前的系统提示词组装 / 消息树写入已经发生，断言只看这些副作用。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CdpClient } from './cdp'
import { sleep } from './cdp'
import type { E2EApp } from './launch'

export interface AgentMdSeed {
  description?: string
  /** shuvix-tools 逗号串（如 'read, grep'） */
  tools?: string
  /** shuvix-model 原样值（`<providerId>/<modelId>` 或裸 `<modelId>`） */
  model?: string
  body?: string
  displayName?: string
  instructionFiles?: boolean
  projectPrompt?: boolean
  /** 追加的原始 frontmatter 行（测未知/废弃 key 时用） */
  rawLines?: string[]
}

/** 写一个 agent 定义文件到隔离实例的 ~/.shuvix/agents/<name>.md */
export function writeAgentMd(app: E2EApp, name: string, seed: AgentMdSeed = {}): string {
  mkdirSync(app.agentsDir, { recursive: true })
  // 与规范化写入口同形：文件类型标记居首（解析侧不作要求，见 definitionFile 的向后兼容说明）
  const lines = ['---', 'shuvix: agent v1', `name: ${name}`]
  if (seed.description) lines.push(`description: ${seed.description}`)
  if (seed.tools) lines.push(`shuvix-tools: ${seed.tools}`)
  if (seed.model) lines.push(`shuvix-model: ${seed.model}`)
  if (seed.displayName) lines.push(`shuvix-displayName: ${seed.displayName}`)
  if (seed.instructionFiles) lines.push('shuvix-instruction-files: true')
  if (seed.projectPrompt) lines.push('shuvix-project-prompt: true')
  if (seed.rawLines) lines.push(...seed.rawLines)
  lines.push('---', '', seed.body ?? 'BODY.')
  const filePath = join(app.agentsDir, `${name}.md`)
  writeFileSync(filePath, lines.join('\n'))
  return filePath
}

/**
 * 让一个模型出现在「可用模型目录」里 —— 档案模型解析（findAllEnabledModels）要求
 * **提供商 isEnabled=1 且模型 isEnabled=1**，而内置提供商的种子数据是 isEnabled=0，
 * 不先启用则目录为空、任何 shuvix-model 都解析不出来。
 * 手动 addModel 插入的模型即 isEnabled=1，故只需额外启用提供商。
 */
export async function seedEnabledModel(
  main: CdpClient,
  opts: { providerId: string; modelId: string }
): Promise<void> {
  await main.eval(
    `(async () => {
      await window.api.provider.toggleEnabled({ id: ${JSON.stringify(opts.providerId)}, isEnabled: true })
      await window.api.provider.addModel(${JSON.stringify(opts)})
    })()`
  )
}

/** 造一个自定义提供商（id 为 uuidv7，插入即 isEnabled=1），返回其 id */
export function seedCustomProvider(
  main: CdpClient,
  opts: { name: string; baseUrl?: string; apiKey?: string; apiProtocol?: string }
): Promise<string> {
  return main.eval(
    `window.api.provider.add(${JSON.stringify({
      name: opts.name,
      baseUrl: opts.baseUrl ?? 'https://example.invalid/v1',
      apiKey: opts.apiKey ?? '',
      apiProtocol: opts.apiProtocol ?? 'openai-completions'
    })}).then((p) => p.id)`
  )
}

/**
 * 写一个全局 skill（`~/.shuvix/skills/<name>/SKILL.md`），返回文件路径。
 *
 * 全局 skill 缺省即启用（`.config.json` 的 disabled 列表里没有就是启用）。种它是为了让
 * `skill:<name>` 成为**真实可用**的工具名 —— 会话工具集在读取时会经 filterAvailableTools
 * 剔除不存在的条目，光往会话树里写一个查无此人的名字是断言不到的。
 */
export function seedSkill(app: E2EApp, name: string, description = 'e2e seeded skill'): string {
  const dir = join(app.home, '.shuvix', 'skills', name)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'SKILL.md')
  writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\nSKILL BODY.\n`)
  return filePath
}

export interface ProjectSeed {
  name: string
  path: string
  systemPrompt?: string
  envVars?: Array<{ key: string; value: string }>
}

/** 经 IPC 创建项目（path 目录需已存在；envVars 走 settings.tool） */
export async function createProject(main: CdpClient, seed: ProjectSeed): Promise<{ id: string }> {
  return main.eval(
    `window.api.project.create(${JSON.stringify({
      name: seed.name,
      path: seed.path,
      ...(seed.systemPrompt !== undefined ? { systemPrompt: seed.systemPrompt } : {}),
      ...(seed.envVars
        ? { tool: { envVars: seed.envVars.map((v) => ({ ...v, sensitive: false })) } }
        : {})
    })})`
  )
}

/**
 * 创建会话并让 Agent 完成创建（不触发 LLM），返回运行时信息。
 * 系统提示词断言的标准入口：info.systemPrompt 与实际发给 LLM 的完全一致。
 */
export async function createAgentSession(
  main: CdpClient,
  opts: { projectId?: string; title?: string } = {}
): Promise<{ sid: string; systemPrompt: string }> {
  return main.eval(
    `(async () => {
      const s = await window.api.session.create(${JSON.stringify({
        title: opts.title ?? 'e2e',
        ...(opts.projectId ? { projectId: opts.projectId } : {})
      })})
      const sid = s.id
      const info = await window.api.agent.getInfo(sid, { ensure: true })
      return { sid, systemPrompt: info.systemPrompt }
    })()`
  )
}

/** 发送 prompt 并容忍 LLM 失败（无 API key），等事件落定后返回消息列表 */
export async function promptAndListMessages(
  main: CdpClient,
  sid: string,
  text = 'hi'
): Promise<Array<{ content?: unknown; metadata?: Record<string, unknown> }>> {
  await main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined)`
  )
  await sleep(1500)
  return main.eval(`window.api.message.list(${JSON.stringify(sid)})`)
}
