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
import { sleep, until } from './cdp'
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

/**
 * 把 `startFakeProvider()` 起的假提供商接进隔离实例，并设为**新会话的默认模型**
 * （连带标题模型 —— 不设的话 `generateTitle` 早退，自动标题链路测不到）。
 *
 * `maxInputTokens` 给足 200k：模型 contextWindow 由它决定，而自动压缩阈值是
 * `contextWindow - 16384`；给小了会让脚本里那几百 token 的 usage 触发压缩。
 */
export async function seedFakeProvider(
  main: CdpClient,
  opts: { baseUrl: string; modelId: string; name?: string }
): Promise<{ providerId: string }> {
  const args = JSON.stringify({ name: opts.name ?? 'E2E Fake', baseUrl: opts.baseUrl })
  const modelId = JSON.stringify(opts.modelId)
  return main.eval(
    `(async () => {
      const args = ${args}
      const p = await window.api.provider.add({
        name: args.name,
        baseUrl: args.baseUrl,
        apiKey: 'e2e',
        apiProtocol: 'openai-completions'
      })
      await window.api.provider.addModel({ providerId: p.id, modelId: ${modelId} })
      const row = (await window.api.provider.listModels(p.id)).find((m) => m.modelId === ${modelId})
      if (row) {
        await window.api.provider.updateModelCapabilities({
          id: row.id,
          capabilities: { maxInputTokens: 200000, maxOutputTokens: 4096, vision: true }
        })
      }
      for (const [key, value] of [
        ['general.defaultProvider', p.id],
        ['general.defaultModel', ${modelId}],
        ['general.titleProvider', p.id],
        ['general.titleModel', ${modelId}]
      ]) {
        await window.api.settings.set({ key, value })
      }
      return { providerId: p.id }
    })()`
  )
}

/**
 * 等 React 真正挂载（`launchApp` 只等到 preload 的 `window.api`，此后还有 ~1.5s 才上屏）。
 *
 * ⚠️ **不要用 `location.reload()` 让渲染端重新初始化**：主进程的 `will-navigate`
 * 守卫（`src/main/index.ts`，防止应用变成浏览器）会 `preventDefault` 掉它，页面被卸载
 * 后不再重建 —— 表现就是「整页再也不渲染」。要让渲染端拿到新种的模型/会话，走 UI 自己的
 * 刷新入口（`sidebarPane.clickNewChat()` 会 `setSessions(await session.list())`）。
 */
export async function waitRendererReady(main: CdpClient): Promise<void> {
  await until(() => main.eval<boolean>('!!window.api'), 'window.api ready')
  await until(
    () => main.eval<boolean>('document.querySelectorAll("button").length > 0'),
    'renderer mounted'
  )
}

/**
 * 页内 ChatEvent 收集器 —— 断言「链路发了什么」的主接缝（优先于 DOM）。
 *
 * 装在渲染进程里旁挂 `window.api.agent.onEvent`，与 `useAgentEvents` 并行接收，
 * 不干扰应用自身的处理。收集器是**全局**的（不分会话），断言前按 `sessionId` 过滤；
 * 每个 it 开头 `clear()` 一次，免得上一条用例的事件混进序列断言。
 */
export interface EventRecorder {
  install(): Promise<void>
  clear(): Promise<void>
  all<T = RecordedEvent>(): Promise<T[]>
  /** 事件类型序列（去掉高频 delta 后更好读；传 true 保留 delta） */
  types(withDeltas?: boolean): Promise<string[]>
  count(type: string): Promise<number>
  /** 等到某类事件出现（返回**首条**匹配事件）；超时抛错 */
  waitFor<T = RecordedEvent>(
    type: string,
    opts?: { timeoutMs?: number; sessionId?: string }
  ): Promise<T>
}

/** 收集到的事件（只声明 spec 会读的字段，其余原样保留） */
export interface RecordedEvent {
  type: string
  sessionId: string
  [key: string]: unknown
}

const RECORDER_KEY = '__shuvixE2eEvents'

export function eventRecorder(main: CdpClient): EventRecorder {
  const install = async (): Promise<void> => {
    await main.eval(
      `(() => {
        if (window.${RECORDER_KEY}) return true
        window.${RECORDER_KEY} = []
        window.api.agent.onEvent((e) => window.${RECORDER_KEY}.push(e))
        return true
      })()`
    )
  }
  const all = <T>(): Promise<T[]> => main.eval<T[]>(`window.${RECORDER_KEY} ?? []`)

  return {
    install,
    clear: () => main.eval(`(window.${RECORDER_KEY} ?? []).length = 0`),
    all,
    types: (withDeltas = false) =>
      main.eval<string[]>(
        `(window.${RECORDER_KEY} ?? [])
          .map((e) => e.type)
          .filter((t) => ${withDeltas} || !t.endsWith('_delta'))`
      ),
    count: (type) =>
      main.eval<number>(
        `(window.${RECORDER_KEY} ?? []).filter((e) => e.type === ${JSON.stringify(type)}).length`
      ),
    waitFor: async <T>(
      type: string,
      opts: { timeoutMs?: number; sessionId?: string } = {}
    ): Promise<T> => {
      const cond = opts.sessionId
        ? `e.type === ${JSON.stringify(type)} && e.sessionId === ${JSON.stringify(opts.sessionId)}`
        : `e.type === ${JSON.stringify(type)}`
      const found = await until(
        () => main.eval<T | null>(`(window.${RECORDER_KEY} ?? []).find((e) => ${cond}) ?? null`),
        `chat event ${type}`,
        opts.timeoutMs ?? 30_000
      )
      return found
    }
  }
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
