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
import { deflateSync } from 'node:zlib'
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
  /** shuvix-instruction-files 逗号串（如 'AGENTS.md, CLAUDE.md'） */
  instructionFiles?: string
  projectAwareness?: boolean
  /**
   * shuvix-session-awareness —— **缺省 true**：种子代表「用户自己建的档案」，
   * 而 GUI 新建的初值就是会话感知开。要测「不声明会话感知的档案选不到 / 切不过去」
   * 时显式传 false。
   */
  sessionAwareness?: boolean
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
  if (seed.instructionFiles) lines.push(`shuvix-instruction-files: ${seed.instructionFiles}`)
  if (seed.projectAwareness) lines.push('shuvix-project-awareness: true')
  if (seed.sessionAwareness !== false) lines.push('shuvix-session-awareness: true')
  if (seed.rawLines) lines.push(...seed.rawLines)
  lines.push('---', '', seed.body ?? 'BODY.')
  const filePath = join(app.agentsDir, `${name}.md`)
  writeFileSync(filePath, lines.join('\n'))
  return filePath
}

export interface BotMdSeed {
  /** description 是 bot md 的必填项 —— 缺省给一句，测「缺 description」时显式传空串 */
  description?: string
  /** shuvix-tools 逗号串 */
  tools?: string
  model?: string
  displayName?: string
  /** shuvix-bot-respond：auto | mention-only */
  respond?: string
  /** `shuvix-bot-respond-to`：user（缺省，只答用户消息）| all（也答别的 bot 的消息） */
  respondTo?: string
  /** `shuvix-bot-pipeline` —— 指向哪份管线 workflow（缺省 bot-chat） */
  pipeline?: string
  /** `shuvix-bot-input` —— 铺进管线 input 的用户键 */
  botInput?: Record<string, string | number | boolean>
  /** `shuvix-bot-agents` —— 阶段角色覆盖（换掉门控/复核/任务段的 agent） */
  agents?: Record<string, string>
  /** shuvix-bot-notes */
  notes?: boolean
  greeting?: string
  suggestions?: string[]
  projectAwareness?: boolean
  body?: string
  /** 追加的原始 frontmatter 行（测未知键/类型错时用） */
  rawLines?: string[]
  /** 省略文件类型标记（bot md 与 agent md 同口径：读取可选） */
  omitMarker?: boolean
}

/**
 * 写一个 bot 定义文件到隔离实例的 ~/.shuvix/bots/<name>.md。
 *
 * bot 与 agent/policy/workflow 同为纯 md 驱动：文件落盘即被 `bot:list` 现扫看见，
 * 没有启用开关也没有旁路配置要一并种。
 */
export function writeBotMd(app: E2EApp, name: string, seed: BotMdSeed = {}): string {
  mkdirSync(app.botsDir, { recursive: true })
  const lines = ['---']
  if (!seed.omitMarker) lines.push('shuvix: bot v1')
  lines.push(`name: ${name}`)
  lines.push(`description: ${seed.description ?? `e2e seeded bot ${name}`}`)
  if (seed.displayName) lines.push(`shuvix-displayName: ${seed.displayName}`)
  if (seed.tools) lines.push(`shuvix-tools: ${seed.tools}`)
  if (seed.model) lines.push(`shuvix-model: ${seed.model}`)
  if (seed.respond) lines.push(`shuvix-bot-respond: ${seed.respond}`)
  if (seed.respondTo) lines.push(`shuvix-bot-respond-to: ${seed.respondTo}`)
  if (seed.pipeline) lines.push(`shuvix-bot-pipeline: ${seed.pipeline}`)
  if (seed.botInput) {
    lines.push('shuvix-bot-input:')
    for (const [k, v] of Object.entries(seed.botInput)) lines.push(`  ${k}: ${String(v)}`)
  }
  if (seed.agents) {
    lines.push('shuvix-bot-agents:')
    for (const [k, v] of Object.entries(seed.agents)) lines.push(`  ${k}: ${v}`)
  }
  if (seed.notes === false) lines.push('shuvix-bot-notes: false')
  if (seed.greeting) lines.push(`shuvix-bot-greeting: ${seed.greeting}`)
  if (seed.suggestions) {
    lines.push('shuvix-bot-suggestions:', ...seed.suggestions.map((s) => `  - ${s}`))
  }
  if (seed.projectAwareness) lines.push('shuvix-project-awareness: true')
  if (seed.rawLines) lines.push(...seed.rawLines)
  lines.push('---', '', seed.body ?? 'BOT BODY.')
  const filePath = join(app.botsDir, `${name}.md`)
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

// ── 最小 PNG 编码器（图片种子现造，不往仓库里塞二进制夹具） ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let c = 0xffffffff
  for (const b of body) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([len, body, crc])
}

/**
 * 写一张 PNG 图片种子，返回文件路径。
 *
 * `incompressible: true` → 噪声像素 + deflate level 0，几乎压不动：这是造 **>1MB** 样本
 * （走 read 的「缩放重编码 + 派生图落盘」分支）唯一便宜的办法 —— 纯色图哪怕几千像素宽，
 * 压完也只有几百字节，永远够不着 1MB 阈值。默认（纯色 + 最高压缩）则是「未超限直出」的样本。
 */
export function writePng(
  filePath: string,
  opts: { width: number; height: number; incompressible?: boolean }
): string {
  const { width: w, height: h, incompressible = false } = opts
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3
      raw[o] = incompressible ? (x * 2654435761 + y * 40503) & 0xff : 200
      raw[o + 1] = incompressible ? (x * 97 + y * 31337) & 0xff : 40
      raw[o + 2] = incompressible ? (x * 1103515245 + y * 12345) & 0xff : 40
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  writeFileSync(
    filePath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw, { level: incompressible ? 0 : 9 })),
      pngChunk('IEND', Buffer.alloc(0))
    ])
  )
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
        ['general.defaultModel', ${modelId}]
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
 *
 * `waitFor` 是**流式游标**语义：每次返回该 (type, sessionId) 的**下一条**事件，
 * 不会重复返回已经等到过的那条。一个 it 里跑两轮对话时这是唯一正确的语义 ——
 * 老实现按整个缓冲区 `find`，第二次 `waitFor('agent_end')` 会秒回上一轮的事件，
 * 于是紧随其后的 `chat.waitIdle()` 在「新一轮还没起流」的空窗期（实测 6~33ms）里
 * 判定为空闲，断言就跑在了本轮任何消息落库之前（chat-history 回退用例的偶发失败）。
 * 需要绕过游标时用 `mark()` 取当前序号，再显式传 `since`。
 */
export interface EventRecorder {
  install(): Promise<void>
  clear(): Promise<void>
  all<T = RecordedEvent>(): Promise<T[]>
  /** 事件类型序列（去掉高频 delta 后更好读；传 true 保留 delta） */
  types(withDeltas?: boolean): Promise<string[]>
  count(type: string): Promise<number>
  /** 当前事件序号（单调递增，不随 clear 归零）—— 作为 `waitFor` 的 `since` 起点 */
  mark(): Promise<number>
  /** 等该 (type, sessionId) 的下一条事件；`since` 显式指定起点。超时抛错 */
  waitFor<T = RecordedEvent>(
    type: string,
    opts?: { timeoutMs?: number; sessionId?: string; since?: number }
  ): Promise<T>
}

/** 收集到的事件（只声明 spec 会读的字段，其余原样保留） */
export interface RecordedEvent {
  type: string
  sessionId: string
  [key: string]: unknown
}

const RECORDER_KEY = '__shuvixE2eEvents'
const SEQ_KEY = '__shuvixE2eSeq'
/** 缓冲区里存的是 `{ seq, e }` 包装：序号单调递增且不随 clear 归零，游标才有意义 */
const BUF = `(window.${RECORDER_KEY} ?? [])`

export function eventRecorder(main: CdpClient): EventRecorder {
  /** `${type}|${sessionId}` → 已等到的最大序号（下一次 waitFor 从它之后开始找） */
  const cursors = new Map<string, number>()

  const install = async (): Promise<void> => {
    await main.eval(
      `(() => {
        if (window.${RECORDER_KEY}) return true
        window.${RECORDER_KEY} = []
        window.${SEQ_KEY} = 0
        window.api.agent.onEvent((e) => window.${RECORDER_KEY}.push({ seq: ++window.${SEQ_KEY}, e }))
        return true
      })()`
    )
  }
  const all = <T>(): Promise<T[]> => main.eval<T[]>(`${BUF}.map((w) => w.e)`)

  return {
    install,
    clear: async () => {
      cursors.clear()
      await main.eval(`${BUF}.length = 0`)
    },
    all,
    mark: () => main.eval<number>(`window.${SEQ_KEY} ?? 0`),
    types: (withDeltas = false) =>
      main.eval<string[]>(
        `${BUF}
          .map((w) => w.e.type)
          .filter((t) => ${withDeltas} || !t.endsWith('_delta'))`
      ),
    count: (type) =>
      main.eval<number>(`${BUF}.filter((w) => w.e.type === ${JSON.stringify(type)}).length`),
    waitFor: async <T>(
      type: string,
      opts: { timeoutMs?: number; sessionId?: string; since?: number } = {}
    ): Promise<T> => {
      const key = `${type}|${opts.sessionId ?? '*'}`
      const since = opts.since ?? cursors.get(key) ?? 0
      const cond = opts.sessionId
        ? `w.e.type === ${JSON.stringify(type)} && w.e.sessionId === ${JSON.stringify(opts.sessionId)}`
        : `w.e.type === ${JSON.stringify(type)}`
      const hit = await until(
        () =>
          main.eval<{ seq: number; e: T } | null>(
            `${BUF}.find((w) => w.seq > ${since} && ${cond}) ?? null`
          ),
        `chat event ${type}`,
        opts.timeoutMs ?? 30_000
      )
      cursors.set(key, hit.seq)
      return hit.e
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
  opts: { projectId?: string; title?: string; notebookPath?: string } = {}
): Promise<{ sid: string; systemPrompt: string }> {
  return main.eval(
    `(async () => {
      const s = await window.api.session.create(${JSON.stringify({
        title: opts.title ?? 'e2e',
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.notebookPath ? { notebookPath: opts.notebookPath } : {})
      })})
      const sid = s.id
      const info = await window.api.agent.getInfo(sid, { ensure: true })
      return { sid, systemPrompt: info.systemPrompt }
    })()`
  )
}

/**
 * 创建一个聊天会话（`settings.bots` 非空 = 无根会话），返回 sid。
 *
 * 与 `createAgentSession` 的关键差别是**只 create、不 getInfo**：聊天会话没有根 Agent，
 * `agent.getInfo(sid, { ensure: true })` 恒为 null，读它的 `.systemPrompt` 直接抛。
 *
 * `session:create` 现在是 async 且内部 await 了 `seedGreetings` —— 它 resolve 时开场白
 * 已在树上，调用方不需要 sleep。
 */
export async function createBotSession(
  main: CdpClient,
  opts: { bots: string[]; title?: string; projectId?: string }
): Promise<string> {
  return main.eval(
    `window.api.session.create(${JSON.stringify({
      bots: opts.bots,
      title: opts.title ?? 'e2e-bots',
      ...(opts.projectId ? { projectId: opts.projectId } : {})
    })}).then((s) => s.id)`
  )
}

/**
 * 给聊天会话发一条消息并返回消息列表。
 *
 * 与 `promptAndListMessages` 的关键差别是**不需要 `.catch()`**：聊天会话的 prompt
 * 根本不碰 LLM（botService 只落盘 + 广播），它若 reject 就是真 bug。
 */
export async function promptBotSession(
  main: CdpClient,
  sid: string,
  text: string
): Promise<
  Array<{ id: string; role?: string; content?: unknown; metadata?: Record<string, unknown> }>
> {
  await main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )
  return main.eval(`window.api.message.list(${JSON.stringify(sid)})`)
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
