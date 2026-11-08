/**
 * 手册实测：让 AI 替用户新建 bot，看它为了搞清楚 ShuviX 的结构做了哪些会惊动权限审查的事 —— 真模型演练，不断言。
 *
 * 用户报告（2026-11-02）：创建 bot 时 agent 频繁尝试读整个主目录或 `~/.shuvix`（想搞清目录结构），以及从包里取枚举值
 * （`agentKind` 之类）。这里按用户那里的形状跑：打包后的目录布局（packagedStage）、自动审查开着、带日记 bot。
 *
 * 入口（`PROBE_SCENARIOS`，逗号分隔）：
 *   chat-none    临时会话，从没选过知识库（新会话的缺省）
 *   chat-off     临时会话，用户把知识库全取消了（显式的空列表）
 *   chat-manual  临时会话，显式勾上内置知识库 `shuvix`
 *   work-none    项目会话，从没选过知识库
 *   work-off     项目会话，用户把知识库全取消了
 *   notebook     侧栏新建 bot 打开的笔记本会话（手册是隐含的）
 *
 * 提示词（`PROBE_PROMPTS`）：sched = 定时 + 读会话 + 写主目录下的文件（要配套策略），simple = 只有人设；
 * reports / weekly = 手册示例没写到的定时场景（防止只测到照抄示例）。
 *
 * 对照组：`PROBE_RESOURCES_FROM` 指向另一份仓库目录（如 `git archive <ref>` 解出来的），手册与内置 agent 档案从那里摆。
 *
 * 每次运行一个新实例，报告写进 `PROBE_OUT` 目录：summary.md、summary.json、每次运行一份转写。
 *
 * 模型：`PROBE_PROVIDER=deepseek`（缺省）或 `kimi`；key 只从 `~/.shuvix-probe.env`（或环境变量）来。
 * 真实主目录：文件工具和点名它的命令都被 deny 策略挡住（隔离实例的 HOME 不是它），跑完比对真实 `~/.shuvix` 的文件清单。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { parseBotDefinitionFile } from '../../../../packages/agent-runtime/src/bot/botFile'
import { parsePolicyDefinitionFile } from '../../../../packages/agent-runtime/src/security/policyFile'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  asksRaisedIn,
  createProject,
  eventRecorder,
  securityDecisions,
  waitRendererReady,
  type EventRecorder,
  type SecurityDecisionEntry
} from '../harness/seed'
import { stagePackagedResources, type PackagedStage } from './packagedStage'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'
import {
  ENV_FILE,
  installPolicy,
  makeDebug,
  REAL_HOME,
  sendPrompt,
  settle
} from './redactionProbeShared'

const OUT = process.env.PROBE_OUT ?? mkdtempSync(join(tmpdir(), 'shuvix-bot-knowledge-probe-'))
const LANG = process.env.PROBE_LANG ?? 'zh'
const PROVIDER = (process.env.PROBE_PROVIDER ?? 'deepseek').toLowerCase()
const RUNS = Number(process.env.PROBE_RUNS ?? 1)
const AGREE = '可以，按你说的来。'

type Scenario = 'chat-none' | 'chat-off' | 'chat-manual' | 'work-none' | 'work-off' | 'notebook'
const SCENARIOS = (process.env.PROBE_SCENARIOS ?? 'chat-none,chat-manual,notebook')
  .split(',')
  .map((s) => s.trim()) as Scenario[]
const PROMPT_KEYS = (process.env.PROBE_PROMPTS ?? 'sched').split(',').map((s) => s.trim())

const PROMPTS: Record<string, { fresh: string; notebook: string }> = {
  sched: {
    fresh: '帮我创建一个 bot，每天早上 9 点看看我昨天的会话，把要点写进 ~/notes/daily-summary.md。',
    notebook:
      '把这个 bot 配成：每天早上 9 点看看我昨天的会话，把要点写进 ~/notes/daily-summary.md。'
  },
  simple: {
    fresh: '帮我创建一个 bot，叫书虫，陪我聊读书、记我的读书笔记偏好，说话简短一点。',
    notebook: '把这个 bot 配成：叫书虫，陪我聊读书、记我的读书笔记偏好，说话简短一点。'
  },
  // 下面两个是手册示例没写到的场景：只照抄示例过不了（工作日、目录读取、项目；只读会话、一周窗口）
  reports: {
    fresh:
      '帮我建一个 bot：工作日晚上 6 点在 tiny-cli 项目里跑，把 ~/Documents/reports 里当天新增的 md 文件汇总到 ~/Documents/weekly.md。',
    notebook:
      '把这个 bot 配成：工作日晚上 6 点在 tiny-cli 项目里跑，把 ~/Documents/reports 里当天新增的 md 文件汇总到 ~/Documents/weekly.md。'
  },
  // 和 ShuviX 无关的普通任务：看默认选中的说明书会不会把它们带偏（多余的 search、往只读库 submit）
  plain: {
    fresh:
      '帮我写个 Python 脚本，统计当前目录下 data.csv 的行数，写好后跑一下（文件没有就先造一个）。',
    notebook: '帮我写个 Python 脚本，统计当前目录下 data.csv 的行数。'
  },
  question: {
    fresh: 'TCP 三次握手为什么不是两次？简单说说。',
    notebook: 'TCP 三次握手为什么不是两次？简单说说。'
  },
  weekly: {
    fresh: '帮我建个 bot，每周五下午 5 点看看我这周的会话，给我一份周报，直接回复在会话里就行。',
    notebook:
      '把这个 bot 配成：每周五下午 5 点看看我这周的会话，给我一份周报，直接回复在会话里就行。'
  }
}

/** 一次工具调用或询问属于哪一类 —— 只为了统计；细节读转写 */
type Tag =
  | 'home-scan' // 列 ~ / ~/.shuvix 的结构
  | 'shuvix-read' // 读 ~/.shuvix 下的某个具体文件
  | 'pkg-dig' // 往应用包里找（app.asar、Resources、node_modules）
  | 'manual' // 查手册
  | 'cli' // shuvix 命令
  | 'write-bot'
  | 'write-policy'
  | 'other'

function tagOf(tool: string, text: string, home: string): Tag {
  const t = text.split(home).join('~')
  // 2026-11-08 起说明书按条目名经 knowledge 工具读（库目录不给 agent）；按路径读的旧形状照旧认
  if (tool === 'knowledge') return 'manual'
  if (/Resources\/knowledge\//.test(t)) return 'manual'
  if (/ShuviX\.app|app\.asar|Contents\/Resources|node_modules|\basar\b|\bstrings\b/.test(t))
    return 'pkg-dig'
  if (/(^|[\s"'])shuvix\s+\w/.test(t) && /bash|powershell/.test(tool)) return 'cli'
  const write = /^(write|edit)$/.test(tool)
  if (write && /\.shuvix\/bots\//.test(t)) return 'write-bot'
  if (write && /\.shuvix\/policies\//.test(t)) return 'write-policy'
  // 目录级：末尾是 ~、~/.shuvix 或它的一层子目录，或命令在列它们
  if (/~\/?(["'\s]|$)|\$HOME\/?(["'\s]|$)/.test(t) && /^(ls|glob|grep|bash|read)$/.test(tool))
    return 'home-scan'
  if (/\.shuvix\/?(["'\s]|$)|\.shuvix\/[\w-]+\/?(["'\s]|$)/.test(t) && !write) return 'home-scan'
  if (/\.shuvix\//.test(t) && !write) return 'shuvix-read'
  if (/\b(find|tree|ls)\b[^|;&]*(~|\$HOME|\/Users\/)/.test(t)) return 'home-scan'
  return 'other'
}

interface ToolCall {
  tool: string
  args: string
  isError: boolean
  tag: Tag
}

interface RunRecord {
  scenario: Scenario
  prompt: string
  run: number
  provider: string
  seconds: number
  turns: number
  toolCalls: ToolCall[]
  /** 主 agent（不算审查员自己）碰到的 ask / deny */
  gates: Array<{
    tool: string
    object: string
    effect: string
    winning: string
    review?: string
    user?: string
    tag: Tag
  }>
  cards: number
  botFiles: string[]
  botVerdicts: string[]
  policyFiles: string[]
  policyVerdicts: string[]
  lastReply: string
}

const records: RunRecord[] = []
let stage: PackagedStage
let realShuvixBefore: string[] = []

const listRealShuvix = (): string[] => {
  const root = join(REAL_HOME, '.shuvix')
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const dir of ['', 'bots', 'policies', 'agents', 'hooks']) {
    const d = join(root, dir)
    if (existsSync(d)) out.push(...readdirSync(d).map((n) => join(dir, n)))
  }
  return out.sort()
}

beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
  stage = stagePackagedResources(process.env.PROBE_RESOURCES_FROM)
  realShuvixBefore = listRealShuvix()
}, 120_000)

afterAll(() => {
  stage?.cleanup()
  const after = listRealShuvix()
  const added = after.filter((n) => !realShuvixBefore.includes(n))
  writeFileSync(
    join(OUT, 'real-home-check.txt'),
    added.length ? `NEW IN REAL ~/.shuvix:\n${added.join('\n')}\n` : 'real ~/.shuvix unchanged\n'
  )
})

/** 文件工具 + 点名真实主目录的命令一律拒绝：隔离实例的 HOME 不是它，文件工具读它不问、审查员也可能放行命令 */
async function installGuard(app: E2EApp): Promise<void> {
  const home = `'${REAL_HOME.replace(/'/g, "\\'")}'`
  await installPolicy(
    app,
    'local-home-guard',
    [
      '---',
      'shuvix: policy v1',
      'name: local-home-guard',
      'description: Keeps this environment inside its own home folder.',
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      'shuvix-policy-rules:',
      '  - effect: deny',
      '    object.type: [path]',
      '    action: [read, write]',
      `    match: inDir(object.path, ${home})`,
      `    prompt: This environment's home folder is ${app.home}; use ~ or paths under it.`,
      '  - effect: deny',
      '    object.type: [command]',
      '    action: [execute]',
      `    match: object.command.contains(${home})`,
      `    prompt: This environment's home folder is ${app.home}; use ~ or paths under it.`,
      '---',
      ''
    ].join('\n')
  )
}

async function seedModel(app: E2EApp): Promise<string> {
  const env = collectProbeEnv(
    process.env,
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
  )
  if (PROVIDER === 'kimi') {
    const key = env.SHUVIX_PROBE_KIMI_KEY ?? ''
    if (!key) throw new Error(`SHUVIX_PROBE_KIMI_KEY not found (env or ${ENV_FILE})`)
    await seedRealModel(app.main, {
      providerId: 'kimi-coding',
      providerName: 'kimi',
      apiKey: key,
      apiProtocol: 'anthropic-messages',
      modelId: env.SHUVIX_PROBE_KIMI_MODEL ?? 'kimi-for-coding'
    })
    return key
  }
  const key = env.SHUVIX_PROBE_COMPLETIONS_KEY ?? ''
  const modelId = env.SHUVIX_PROBE_COMPLETIONS_MODEL ?? ''
  if (!key || !modelId) throw new Error(`deepseek key / model not found (env or ${ENV_FILE})`)
  await seedRealModel(app.main, {
    providerId: 'deepseek',
    providerName: 'deepseek',
    apiKey: key,
    apiProtocol: 'openai-completions',
    modelId
  })
  return key
}

async function openSession(app: E2EApp, scenario: Scenario): Promise<string> {
  // 所有入口都有这个项目（提示词可能点名它）；只有 work-none 的会话在项目里
  const path = join(app.home, 'code', 'tiny-cli')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), '{ "name": "tiny-cli", "version": "0.1.0" }\n')
  const project = await createProject(app.main, { name: 'tiny-cli', path })
  if (scenario === 'notebook') {
    const created = await app.main.eval<{ fileName?: string; error?: string }>(
      `window.api.bot.createNew()`
    )
    if (!created.fileName) throw new Error(`bot.createNew failed: ${created.error}`)
    const note = await app.main.eval<{ id: string }>(
      `window.api.bot.openNote(${JSON.stringify({ fileName: created.fileName })})`
    )
    return note.id
  }
  const selectBases = async (sid: string, knowledgeBases: string[]): Promise<void> => {
    await app.main.eval(
      `window.api.session.updateKnowledgeBases(${JSON.stringify({ id: sid, knowledgeBases })})`
    )
  }
  if (scenario === 'work-none' || scenario === 'work-off') {
    const sid = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: '新对话', projectId: project.id })}).then((s) => s.id)`
    )
    if (scenario === 'work-off') await selectBases(sid, [])
    return sid
  }
  const sid = await app.main.eval<string>(
    `window.api.session.create({ title: '新对话' }).then((s) => s.id)`
  )
  if (scenario === 'chat-manual') await selectBases(sid, ['shuvix'])
  if (scenario === 'chat-off') await selectBases(sid, [])
  return sid
}

interface Block {
  type: string
  text?: string
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
  isError?: boolean
}
interface Msg {
  role: string
  content: string
  blocks?: Block[]
}

const messagesOf = (app: E2EApp, sid: string): Promise<Msg[]> =>
  app.main.eval<Msg[]>(`window.api.message.list(${JSON.stringify(sid)})`)

function transcript(msgs: Msg[]): string {
  const out: string[] = []
  for (const m of msgs) {
    if (m.role === 'user') {
      out.push(`>>> USER: ${m.content}`)
      continue
    }
    if (m.role !== 'assistant') {
      out.push(`### ${m.role}: ${m.content}`)
      continue
    }
    for (const b of m.blocks ?? []) {
      if (b.type === 'text' && b.text?.trim()) out.push(`<<< ASSISTANT:\n${b.text}`)
      if (b.type === 'thinking' && b.text?.trim()) out.push(`(thinking) ${b.text}`)
      if (b.type !== 'tool') continue
      const args = JSON.stringify(b.args ?? {})
      out.push(`[TOOL] ${b.toolName} ${args.length > 2500 ? `${args.slice(0, 2500)}…` : args}`)
      const result = String(b.result ?? '')
      out.push(
        `[RESULT]${b.isError ? ' (ERROR)' : ''} ${result.length > 1200 ? `${result.slice(0, 1200)}…` : result}`
      )
    }
  }
  return out.join('\n\n')
}

const mdIn = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!existsSync(dir)) return out
  for (const n of readdirSync(dir)) {
    if (!n.startsWith('.') && n.endsWith('.md')) out[n] = readFileSync(join(dir, n), 'utf8')
  }
  return out
}

const argSummary = (b: Block): string => {
  const a = b.args ?? {}
  const value = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? ''
  const extra = [
    a.action,
    a.base,
    a.path && a.pattern ? a.path : undefined,
    a.dangerouslyDisableSandbox ? 'UNSANDBOXED' : undefined
  ]
    .filter(Boolean)
    .join(' ')
  return `${extra ? `${extra} ` : ''}${String(value)}`.trim()
}

const looksLikeQuestion = (reply: string): boolean =>
  /[?？]\s*$/.test(reply.trim()) || /(要不要|是否需要|需要我|你同意|同意的话|确认一下)/.test(reply)

function renderSummary(): string {
  const lines = [`# 手册实测：新建 bot（${PROVIDER}，界面语言 ${LANG}）`, '']
  lines.push(
    '| 入口 | 提示词 | # | 秒 | 工具 | 询问 | 审查放行 | 审查拒绝 | 到人 | home-scan | shuvix-read | pkg-dig | manual | bot | 策略 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  for (const r of records) {
    const count = (tag: Tag): number => r.toolCalls.filter((c) => c.tag === tag).length
    const asks = r.gates.filter((g) => g.effect === 'ask')
    lines.push(
      `| ${r.scenario} | ${r.prompt} | ${r.run} | ${r.seconds} | ${r.toolCalls.length} | ${asks.length} | ` +
        `${asks.filter((g) => g.review === 'allow').length} | ${asks.filter((g) => g.review === 'deny').length} | ${r.cards} | ` +
        `${count('home-scan')} | ${count('shuvix-read')} | ${count('pkg-dig')} | ${count('manual')} | ` +
        `${r.botFiles.length ? r.botVerdicts.join(' ') : '无'} | ${r.policyFiles.length ? r.policyVerdicts.join(' ') : '无'} |`
    )
  }
  for (const r of records) {
    lines.push('', `## ${r.scenario} / ${r.prompt} / #${r.run}`, '', '### 询问与拒绝', '')
    for (const g of r.gates) {
      lines.push(
        `- [${g.tag}] ${g.effect} ${g.tool} \`${g.object.replace(/\s+/g, ' ').slice(0, 180)}\` ← ${g.winning}` +
          `${g.review ? ` 审查:${g.review}` : ''}${g.user ? ` 人:${g.user}` : ''}`
      )
    }
    lines.push('', '### 工具调用', '')
    for (const c of r.toolCalls) {
      lines.push(
        `- [${c.tag}]${c.isError ? ' (失败)' : ''} ${c.tool} \`${c.args.replace(/\s+/g, ' ').slice(0, 200)}\``
      )
    }
    lines.push('', '### 回复', '', r.lastReply)
  }
  return lines.join('\n')
}

for (const promptKey of PROMPT_KEYS) {
  for (const scenario of SCENARIOS) {
    for (let run = 1; run <= RUNS; run++) {
      it(
        `${scenario} / ${promptKey} / #${run}`,
        async () => {
          const label = `${scenario}-${promptKey}-r${run}`
          const debug = makeDebug(OUT)
          const app = (await launchApp({
            autoReview: true,
            builtinBots: true,
            env: { SHUVIX_E2E_STAGED_RESOURCES: stage.resources }
          })) as E2EApp
          let key = ''
          try {
            await waitRendererReady(app.main)
            key = await seedModel(app)
            await app.main.eval(
              `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
            )
            await installGuard(app)
            const events: EventRecorder = eventRecorder(app.main)
            await events.install()

            const botsDir = join(app.home, '.shuvix', 'bots')
            const policiesDir = join(app.home, '.shuvix', 'policies')
            const sid = await openSession(app, scenario)
            const botsBefore = mdIn(botsDir)
            const policiesBefore = mdIn(policiesDir)

            const started = Date.now()
            const text =
              scenario === 'notebook' ? PROMPTS[promptKey].notebook : PROMPTS[promptKey].fresh
            let turns = 0
            const send = async (message: string): Promise<void> => {
              turns++
              await sendPrompt(app, sid, message)
              await settle({
                app,
                events,
                sid,
                label,
                answer: () => AGREE,
                debug,
                quietMs: 15_000
              })
            }
            await send(text)
            // 这一轮停下来问用户：按同意往下走（最多两次）
            for (let i = 0; i < 2; i++) {
              const msgs = await messagesOf(app, sid)
              const reply = [...msgs]
                .reverse()
                .find((m) => m.role === 'assistant' && (m.content || '').trim())?.content
              if (!reply || !looksLikeQuestion(reply)) break
              await send(AGREE)
            }

            const msgs = await messagesOf(app, sid)
            const toolCalls: ToolCall[] = msgs.flatMap((m) =>
              (m.blocks ?? [])
                .filter((b) => b.type === 'tool')
                .map((b) => {
                  const args = argSummary(b)
                  return {
                    tool: b.toolName ?? '?',
                    args,
                    isError: Boolean(b.isError),
                    tag: tagOf(b.toolName ?? '', args, app.home)
                  }
                })
            )
            const decisions: SecurityDecisionEntry[] = securityDecisions(app).filter(
              (d) =>
                d.effect !== 'allow' &&
                d.subject?.profileName !== 'permission-reviewer' &&
                d.sessionId === sid
            )
            const botsAfter = mdIn(botsDir)
            const policiesAfter = mdIn(policiesDir)
            const changedBots = Object.keys(botsAfter).filter((n) => botsAfter[n] !== botsBefore[n])
            const newPolicies = Object.keys(policiesAfter).filter(
              (n) => policiesAfter[n] !== policiesBefore[n]
            )
            const botVerdicts = changedBots.map((n) => {
              const warns: string[] = []
              const parsed = parseBotDefinitionFile(botsAfter[n], n.replace(/\.md$/, ''), (w) =>
                warns.push(w)
              )
              if (!parsed) return `拒绝(${warns[0] ?? ''})`
              return `ok/绑定${parsed.bindings?.length ?? 0}${warns.length ? '/告警' : ''}`
            })
            const policyVerdicts = newPolicies.map((n) =>
              parsePolicyDefinitionFile(policiesAfter[n], n.replace(/\.md$/, ''))
                ? 'ok'
                : '解析不过'
            )
            records.push({
              scenario,
              prompt: promptKey,
              run,
              provider: PROVIDER,
              seconds: Math.round((Date.now() - started) / 1000),
              turns,
              toolCalls,
              gates: decisions.map((d) => ({
                tool: d.toolName,
                object: d.objectSummary,
                effect: d.effect,
                winning: d.winning,
                review: d.review?.decision,
                user: d.userResponse,
                tag: tagOf(d.toolName, d.objectSummary, app.home)
              })),
              cards: await asksRaisedIn(events, sid),
              botFiles: changedBots,
              botVerdicts,
              policyFiles: newPolicies,
              policyVerdicts,
              lastReply:
                [...msgs].reverse().find((m) => m.role === 'assistant' && (m.content || '').trim())
                  ?.content ?? ''
            })
            const redact = (t: string): string => (key ? t.split(key).join('<redacted>') : t)
            const files = [
              ...changedBots.map((n) => [n, botsAfter[n]]),
              ...newPolicies.map((n) => [n, policiesAfter[n]])
            ]
              .map(([n, t]) => `## ${n}\n\n\`\`\`md\n${t.trimEnd()}\n\`\`\``)
              .join('\n\n')
            writeFileSync(
              join(OUT, `${label}.md`),
              redact(
                `# ${label}\n\n${files}\n\n# 转写\n\n\`\`\`text\n${transcript(msgs)}\n\`\`\`\n`
              )
            )
            const redactedSummary = redact(renderSummary())
            writeFileSync(join(OUT, 'summary.md'), redactedSummary)
            writeFileSync(join(OUT, 'summary.json'), redact(JSON.stringify(records, null, 2)))
            console.log(`[${label}] done → ${OUT}`)
          } finally {
            await app.stop()
          }
        },
        30 * 60 * 1000
      )
    }
  }
}
