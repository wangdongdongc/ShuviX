/**
 * fork 之后立刻接着对话，几个会话的提示词缓存丢不丢 —— 真模型探针（2026-11-08）。
 *
 * 起因：用户在考虑做「agent 把自己 fork 成几份并行做不同的事」，先要知道 fork 之后马上并行对话时，每个会话的
 * 缓存有没有损失。代码这一侧（冻结的系统提示词、沿用的锁、共用的临时目录）有测试，但测试用的是替身工具，
 * 也从没有真模型报过命中，这里两件都量：
 *   - 命中：每次请求服务商报回的缓存读 token（消息上的 usage），和「不 fork、在源会话里接着说」的对照比。
 *     服务商只会对逐字节相同的前缀报命中，所以命中到上一次请求的整段 = 系统提示词、工具、历史都一样；
 *   - agent 本身：各会话内存里 agent 的系统提示词、工具（名字、发给模型的描述、参数名，按次序）、模型逐个比
 *     （`agent.getInfo`）—— 用的是真实的内置工具。请求体本身拿不到：LLM 请求日志自 pi-durable 起没有写入方，
 *     内置 provider 又不认自定义地址，没法在中间加一层记录。
 *
 * 一次运行（`PROBE_RUNS` 次，每次一个新实例）：
 *   1. 临时会话 S（chat 基座）里说三轮，建一段历史；
 *   2. 整段 fork 三份 F1–F3；
 *   3. 第一轮并行：S、F1、F2、F3 同一时刻各发一个不同的问题 —— S 是对照；
 *   4. 第二轮并行：四个会话各追问一句（分叉之后各自的缓存是否接得上）；
 *   5. 从第二轮回复（A2）fork 两份 R1、R2，并行各发一句 —— 从回复 fork 的情形。
 *
 * 不断言（真模型、真服务商，结果不确定），只写报告：`<PROBE_OUT>/report.md`、`results.json`。
 *
 * 模型：`PROBE_MODELS`（逗号分隔，缺省 deepseek,kimi），key 只从 `~/.shuvix-probe.env` 或环境变量来：
 *   - deepseek：`SHUVIX_PROBE_COMPLETIONS_KEY` / `_MODEL`（openai-completions，自动磁盘缓存）
 *   - kimi：`SHUVIX_PROBE_KIMI_KEY` / `SHUVIX_PROBE_KIMI_MODEL`（kimi-coding，anthropic-messages）
 *   - anthropic：`SHUVIX_PROBE_ANTHROPIC_KEY` / `_MODEL`
 *   - openai：`SHUVIX_PROBE_OPENAI_KEY` / `_MODEL`（`prompt_cache_key`：整段 fork 共用一个）
 *
 * 提示词都让模型别用工具、短答，一轮通常就是一次请求；万一调了工具，只看每一轮的第一次请求。
 *
 *   npx electron-vite build
 *   PROBE_MODELS=deepseek,kimi npx vitest run --config vitest.config.probe.ts e2e/live/forkCache.probe.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import { launchApp, type E2EApp } from '../harness/launch'
import { waitRendererReady } from '../harness/seed'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'
import { ENV_FILE, installRealHomeGuard } from './redactionProbeShared'

const REPO_ROOT = resolve(process.cwd(), '../..')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), `shuvix-fork-cache-${STAMP}`)
const RUNS = Math.max(1, Number(process.env.PROBE_RUNS ?? '2'))
const TURN_TIMEOUT_MS = 6 * 60 * 1000

interface ModelSpec {
  keyEnv: string
  modelEnv: string
  fallbackModel?: string
  providerId: string
  providerName: string
  apiProtocol: string
}

const MODELS: Record<string, ModelSpec> = {
  deepseek: {
    keyEnv: 'SHUVIX_PROBE_COMPLETIONS_KEY',
    modelEnv: 'SHUVIX_PROBE_COMPLETIONS_MODEL',
    providerId: 'deepseek',
    providerName: 'deepseek',
    apiProtocol: 'openai-completions'
  },
  kimi: {
    keyEnv: 'SHUVIX_PROBE_KIMI_KEY',
    modelEnv: 'SHUVIX_PROBE_KIMI_MODEL',
    fallbackModel: 'kimi-for-coding',
    providerId: 'kimi-coding',
    providerName: 'kimi',
    apiProtocol: 'anthropic-messages'
  },
  anthropic: {
    keyEnv: 'SHUVIX_PROBE_ANTHROPIC_KEY',
    modelEnv: 'SHUVIX_PROBE_ANTHROPIC_MODEL',
    fallbackModel: 'claude-haiku-5-5',
    providerId: 'anthropic',
    providerName: 'anthropic',
    apiProtocol: 'anthropic-messages'
  },
  openai: {
    keyEnv: 'SHUVIX_PROBE_OPENAI_KEY',
    modelEnv: 'SHUVIX_PROBE_OPENAI_MODEL',
    fallbackModel: 'gpt-5.5',
    providerId: 'openai',
    providerName: 'openai',
    apiProtocol: 'openai-responses'
  }
}

const RULE = '不要使用任何工具，直接用中文回答，150 字左右。'
const BUILD = [
  `${RULE}讲讲 SQLite 的 WAL 模式是怎么工作的。`,
  `${RULE}WAL 模式下，检查点（checkpoint）什么时候发生？`,
  `${RULE}那它和回滚日志（rollback journal）模式相比，各自适合什么场景？`
]
const ROUND_A: Record<string, string> = {
  S: `${RULE}WAL 文件会无限增长吗？`,
  F1: `${RULE}多个进程同时读写同一个 SQLite 库要注意什么？`,
  F2: `${RULE}SQLite 的 busy_timeout 是做什么的？`,
  F3: `${RULE}什么情况下不该用 SQLite？`
}
const ROUND_B = `${RULE}把你上一条回答压缩成一句话。`
const ROUND_C: Record<string, string> = {
  R1: `${RULE}检查点会阻塞写入吗？`,
  R2: `${RULE}能手动触发检查点吗？怎么做？`
}

interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface Row {
  run: number
  model: string
  label: string
  round: 'build' | 'A' | 'B' | 'C'
  /** 本轮第一次请求的用量 */
  usage: Usage | null
  /** 提示词总量 = 未命中输入 + 缓存读 + 缓存写 */
  prompt: number | null
  /** 拿来比的那次请求（它的提示词总量），与它比命中了多少 */
  reference: string
  referencePrompt: number | null
  /** 本轮这一次请求一共调了几次模型（>1 = 模型用了工具） */
  calls: number
  error?: string
}

interface AgentCheck {
  run: number
  model: string
  pair: string
  system: boolean
  tools: boolean
  model_: boolean
  note?: string
}

interface Snapshot {
  id: string
  role: string
  usage?: Usage
}

const promptOf = (u: Usage | null | undefined): number | null =>
  u ? u.input + u.cacheRead + u.cacheWrite : null

async function messagesOf(app: E2EApp, sid: string): Promise<Snapshot[]> {
  return app.main.eval<Snapshot[]>(`
    window.api.message.list(${JSON.stringify(sid)}).then((msgs) => msgs.map((m) => {
      const u = m.metadata && m.metadata.usage
      return {
        id: m.id,
        role: m.role,
        usage: u ? { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0 } : undefined
      }
    }))
  `)
}

/** 每一轮（按用户消息切）的助手消息用量：[[第一次请求, 第二次, …], …] */
function turnsOf(messages: Snapshot[]): Usage[][] {
  const turns: Usage[][] = []
  for (const m of messages) {
    if (m.role === 'user') turns.push([])
    else if (m.role === 'assistant' && m.usage && turns.length > 0) turns.at(-1)!.push(m.usage)
  }
  return turns
}

async function promptAll(app: E2EApp, sends: Array<{ sid: string; text: string }>): Promise<void> {
  const call = app.main.eval(`
    Promise.all(${JSON.stringify(sends)}.map((s) =>
      window.api.agent.prompt({ sessionId: s.sid, text: s.text })))
  `)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('turn timed out')), TURN_TIMEOUT_MS)
  })
  try {
    await Promise.race([call, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fork(app: E2EApp, sid: string, messageId?: string): Promise<string> {
  const params = messageId ? { sessionId: sid, messageId } : { sessionId: sid }
  for (let attempt = 0; attempt < 15; attempt++) {
    const result = await app.main.eval<{ success: boolean; sessionId?: string; reason?: string }>(
      `window.api.session.fork(${JSON.stringify(params)})`
    )
    if (result.success && result.sessionId) return result.sessionId
    if (result.reason !== 'busy') throw new Error(`fork refused: ${result.reason}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('fork stayed busy')
}

interface AgentInfo {
  systemPrompt: string
  model: { id: string }
  tools: Array<{ name: string; description: string; parameters: string[] }>
}

const infoOf = (app: E2EApp, sid: string): Promise<AgentInfo | null> =>
  app.main.eval<AgentInfo | null>(`window.api.agent.getInfo(${JSON.stringify(sid)})`)

function compareAgents(
  a: AgentInfo | null,
  b: AgentInfo | null
): Omit<AgentCheck, 'run' | 'model' | 'pair'> {
  if (!a || !b) {
    return { system: false, tools: false, model_: false, note: 'agent not found' }
  }
  const tools = (info: AgentInfo): string =>
    JSON.stringify(info.tools.map((t) => [t.name, t.description, t.parameters]))
  const toolsEqual = tools(a) === tools(b)
  let note: string | undefined
  if (!toolsEqual) {
    const names = (info: AgentInfo): string => info.tools.map((t) => t.name).join(',')
    note =
      names(a) === names(b)
        ? `same names, different descriptions: ${a.tools
            .filter((t, i) => JSON.stringify(t) !== JSON.stringify(b.tools[i]))
            .map((t) => t.name)
            .join(',')}`
        : `${names(a)} vs ${names(b)}`
  }
  return {
    system: a.systemPrompt === b.systemPrompt,
    tools: toolsEqual,
    model_: a.model.id === b.model.id,
    ...(note ? { note } : {})
  }
}

async function runOnce(
  run: number,
  name: string,
  spec: ModelSpec,
  key: string,
  modelId: string,
  rows: Row[],
  checks: AgentCheck[]
): Promise<void> {
  const app = await launchApp()
  try {
    await waitRendererReady(app.main)
    await seedRealModel(app.main, {
      providerId: spec.providerId,
      providerName: spec.providerName,
      apiKey: key,
      apiProtocol: spec.apiProtocol,
      modelId
    })
    await installRealHomeGuard(app, REPO_ROOT)

    // 非缺省标题：自动起标题不跑，fork 时源会话也没有它的任务
    const S = await app.main.eval<string>(
      `window.api.session.create({ title: 'fork cache probe' }).then((s) => s.id)`
    )
    for (const text of BUILD) await promptAll(app, [{ sid: S, text }])

    const built = await messagesOf(app, S)
    const assistantIds = (() => {
      // 每一轮的最后一条助手消息
      const ids: string[] = []
      let last: string | undefined
      for (const m of built) {
        if (m.role === 'user') {
          if (last) ids.push(last)
          last = undefined
        } else if (m.role === 'assistant') last = m.id
      }
      if (last) ids.push(last)
      return ids
    })()
    const A2 = assistantIds[1]

    const forks: Record<string, string> = { S }
    for (const label of ['F1', 'F2', 'F3']) forks[label] = await fork(app, S)

    await promptAll(
      app,
      Object.entries(ROUND_A).map(([label, text]) => ({ sid: forks[label], text }))
    )
    await promptAll(
      app,
      Object.keys(ROUND_A).map((label) => ({ sid: forks[label], text: ROUND_B }))
    )

    for (const label of ['R1', 'R2']) forks[label] = await fork(app, S, A2)
    await promptAll(
      app,
      Object.entries(ROUND_C).map(([label, text]) => ({ sid: forks[label], text }))
    )

    // ─── 用量 ───
    const turns: Record<string, Usage[][]> = {}
    for (const [label, sid] of Object.entries(forks)) {
      turns[label] = turnsOf(await messagesOf(app, sid))
    }
    const sTurns = turns.S
    const lastOf = (turn: Usage[] | undefined): Usage | null => turn?.at(-1) ?? null
    const firstOf = (turn: Usage[] | undefined): Usage | null => turn?.[0] ?? null
    const push = (
      label: string,
      round: Row['round'],
      turn: Usage[] | undefined,
      reference: string,
      ref: Usage | null
    ): void => {
      const usage = firstOf(turn)
      rows.push({
        run,
        model: name,
        label,
        round,
        usage,
        prompt: promptOf(usage),
        reference,
        referencePrompt: promptOf(ref),
        calls: turn?.length ?? 0
      })
    }
    // 建历史的三轮：每一轮对上一轮最后一次请求
    BUILD.forEach((_, i) =>
      push(
        `S·build${i + 1}`,
        'build',
        sTurns[i],
        i === 0 ? '—' : `S·build${i}`,
        i === 0 ? null : lastOf(sTurns[i - 1])
      )
    )
    // fork 之后第一轮：都对 S 在 fork 之前的最后一次请求（S 自己是对照）
    const beforeFork = lastOf(sTurns[2])
    for (const label of ['S', 'F1', 'F2', 'F3']) {
      push(`${label}·A`, 'A', turns[label][3], 'S·build3', beforeFork)
    }
    for (const label of ['S', 'F1', 'F2', 'F3']) {
      push(`${label}·B`, 'B', turns[label][4], `${label}·A`, lastOf(turns[label][3]))
    }
    // 从 A2 fork：对 S 在 A2 之前的最后一次请求（build2）；S 当年接着说（build3）的命中也在表里
    for (const label of ['R1', 'R2']) {
      push(`${label}·C`, 'C', turns[label][2], 'S·build2', lastOf(sTurns[1]))
    }

    // ─── agent 本身 ───
    const sInfo = await infoOf(app, S)
    for (const label of ['F1', 'F2', 'F3', 'R1', 'R2']) {
      checks.push({
        run,
        model: name,
        pair: `S vs ${label}`,
        ...compareAgents(sInfo, await infoOf(app, forks[label]))
      })
    }
  } catch (error) {
    rows.push({
      run,
      model: name,
      label: 'run',
      round: 'build',
      usage: null,
      prompt: null,
      reference: '-',
      referencePrompt: null,
      calls: 0,
      error: String(error)
    })
  } finally {
    await app.stop()
  }
}

const pct = (a: number | null | undefined, b: number | null | undefined): string =>
  a == null || !b ? '-' : `${Math.round((a / b) * 100)}%`

function renderReport(rows: Row[], checks: AgentCheck[], meta: Record<string, string>): string {
  const lines: string[] = ['# fork 之后立刻并行对话的缓存', '']
  for (const [k, v] of Object.entries(meta)) lines.push(`- ${k}：${v}`)
  lines.push('', '## agent 本身（ShuviX 这一侧）', '')
  lines.push('| 运行 | 模型 | 比较 | 系统提示词 | 工具 | 模型 | 备注 |')
  lines.push('|---|---|---|---|---|---|---|')
  const yes = (b: boolean): string => (b ? '相同' : '**不同**')
  for (const c of checks) {
    lines.push(
      `| ${c.run} | ${c.model} | ${c.pair} | ${yes(c.system)} | ${yes(c.tools)} | ${yes(c.model_)} | ${c.note ?? ''} |`
    )
  }
  lines.push('', '## 命中（服务商报回的缓存读）', '')
  lines.push(
    '「参照」是这一轮之前、内容上可以整段复用的那次请求；「命中/参照」= 本次缓存读 ÷ 参照的提示词总量，接近 100% 就是之前那一段全部命中。'
  )
  lines.push('')
  lines.push(
    '| 运行 | 模型 | 请求 | 提示词总量 | 缓存读 | 缓存写 | 未命中 | 参照 | 参照总量 | 命中/参照 | 本轮请求数 |'
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    if (r.error) {
      lines.push(`| ${r.run} | ${r.model} | ERROR | ${r.error.replace(/\|/g, '/')} |||||||| |`)
      continue
    }
    const u = r.usage
    lines.push(
      `| ${r.run} | ${r.model} | ${r.label} | ${r.prompt ?? '-'} | ${u?.cacheRead ?? '-'} | ${u?.cacheWrite ?? '-'} | ${u?.input ?? '-'} | ${r.reference} | ${r.referencePrompt ?? '-'} | ${pct(u?.cacheRead, r.referencePrompt)} | ${r.calls} |`
    )
  }
  return lines.join('\n') + '\n'
}

it(
  'fork cache: do forks that continue right away keep their prompt cache',
  async () => {
    const env = collectProbeEnv(
      process.env,
      existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
    )
    const names = (process.env.PROBE_MODELS ?? 'deepseek,kimi').split(',').map((s) => s.trim())
    const targets = names.map((name) => {
      const spec = MODELS[name]
      if (!spec) throw new Error(`unknown model "${name}" in PROBE_MODELS`)
      const key = env[spec.keyEnv] ?? ''
      const modelId = env[spec.modelEnv] ?? spec.fallbackModel ?? ''
      if (!key || !modelId)
        throw new Error(`${spec.keyEnv} / ${spec.modelEnv} not set (${ENV_FILE})`)
      return { name, spec, key, modelId }
    })
    mkdirSync(OUT, { recursive: true })
    const rows: Row[] = []
    const checks: AgentCheck[] = []
    const meta = {
      模型: targets.map((t) => `${t.name} = ${t.modelId}（${t.spec.apiProtocol}）`).join('，'),
      每个模型运行: String(RUNS)
    }
    const flush = (): void => {
      writeFileSync(join(OUT, 'report.md'), renderReport(rows, checks, meta))
      writeFileSync(join(OUT, 'results.json'), JSON.stringify({ rows, checks }, null, 2))
    }
    for (let run = 1; run <= RUNS; run++) {
      for (const target of targets) {
        await runOnce(run, target.name, target.spec, target.key, target.modelId, rows, checks)
        flush()
        console.log(`run ${run} ${target.name} done → ${join(OUT, 'report.md')}`)
      }
    }
  },
  90 * 60 * 1000
)
