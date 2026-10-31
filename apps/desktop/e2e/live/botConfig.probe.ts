/**
 * 让 AI 按用户的话配置 bot 与触发条件 —— 真模型演练，不断言，把每一份写出来的 bot 文件用产品自己的解析器、
 * bot 列表和 `when` 求值器打分，摊开给人读。
 *
 * 两个入口：
 *   A. 临时会话，用户勾上内置知识库 `shuvix`（ShuviX 系统说明），让它新建一个工作日 09:30、在项目 tiny-cli 里跑的 bot；
 *   B. 打开另一个 bot（小舟）的笔记本会话：B1 给这个 bot 加一条「每晚 21:00、今天有会话才跑」的定时；
 *      B2 在同一条会话里另建一个每周日 20:00、临时工作区里跑的 bot，且不动正开着的这一份。
 *
 * 每份文件看：bot 解析器零告警读回、bot 列表认它（不在非法 / 被遮蔽里）、绑定的 trigger / project / message，
 * 以及 `when` 在一张时刻表上的真值（`evaluateWhen`，`activeSessions` 换成桩）。
 *
 * 模型：`PROBE_PROVIDER=deepseek`（缺省，`SHUVIX_PROBE_COMPLETIONS_KEY` / `_MODEL`）或 `kimi`
 * （`SHUVIX_PROBE_KIMI_KEY`），key 只从 `~/.shuvix-probe.env`（或环境变量）来。界面语言缺省 zh（`PROBE_LANG`）。
 * 报告写到 `PROBE_OUT`。权限询问只放行不碰真实主目录的（`settle`），真实主目录另有拒绝策略兜底（`installRealHomeGuard`）。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { parseBotDefinitionFile } from '../../../../packages/agent-runtime/src/bot/botFile'
import {
  evaluateWhen,
  setWhenHostFunctions
} from '../../../../packages/agent-runtime/src/hook/when'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  asksRaisedIn,
  createProject,
  eventRecorder,
  waitRendererReady,
  writeBotMd,
  type EventRecorder
} from '../harness/seed'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'
import {
  ENV_FILE,
  installRealHomeGuard,
  makeDebug,
  REAL_HOME,
  sendPrompt,
  settle
} from './redactionProbeShared'

const OUT = process.env.PROBE_OUT ?? join(tmpdir(), 'shuvix-bot-config-probe.md')
const LANG = process.env.PROBE_LANG ?? 'zh'

/** 正开着的那份 bot（B 的入口） */
const OPEN_BOT = 'xiaozhou'
const OPEN_BOT_BODY = [
  '## 我是谁',
  '',
  '你是小舟，这个用户的编程搭子。说话随和、直接。',
  '',
  '## 我记得什么',
  '',
  '- 回答先给结论，短一点。'
].join('\n')

const PROMPT_A =
  '帮我新建一个 bot：名字叫 standup，显示名「站会助手」。它每个工作日（周一到周五）早上 9:30 自动跑一次，' +
  '在 tiny-cli 这个项目里跑，看看昨天以来这个项目里的会话，帮我列出今天站会要说的三点。周末不要跑。'
const PROMPT_B1 =
  '给这个 bot 加一个定时：每天晚上 9 点，如果我今天用过 ShuviX（今天有会话）就自动跑一次，' +
  '让它回顾今天的对话，把新发现的我的偏好记进它自己的文件。不用指定项目。'
const PROMPT_B2 =
  '另外再帮我新建一个 bot，名字叫 weekly，显示名「周报」，每周日晚上 8 点跑一次，在临时工作区里就行，' +
  '帮我总结这一周做了什么。别动现在这个 bot。'

interface WhenCase {
  label: string
  date: string
  time: string
  /** JS getDay：0 = 周日 */
  weekday: number
  /** activeSessions 的桩返回值 */
  active?: number
  expect: boolean
}

const local = (c: WhenCase): Record<string, unknown> => {
  const [hour, minute] = c.time.split(':').map(Number)
  return { date: c.date, time: c.time, weekday: c.weekday, hour, minute }
}

// 2026-11-02 周一 … 2026-11-08 周日
const CASES_A: WhenCase[] = [
  { label: '周一 09:30', date: '2026-11-02', time: '09:30', weekday: 1, active: 3, expect: true },
  { label: '周五 09:30', date: '2026-11-06', time: '09:30', weekday: 5, active: 0, expect: true },
  { label: '周六 09:30', date: '2026-11-07', time: '09:30', weekday: 6, active: 3, expect: false },
  { label: '周日 09:30', date: '2026-11-08', time: '09:30', weekday: 0, active: 3, expect: false },
  { label: '周一 09:31', date: '2026-11-02', time: '09:31', weekday: 1, active: 3, expect: false },
  { label: '周一 21:30', date: '2026-11-02', time: '21:30', weekday: 1, active: 3, expect: false }
]
const CASES_B1: WhenCase[] = [
  {
    label: '周一 21:00，今天 2 条会话',
    date: '2026-11-02',
    time: '21:00',
    weekday: 1,
    active: 2,
    expect: true
  },
  {
    label: '周一 21:00，今天没会话',
    date: '2026-11-02',
    time: '21:00',
    weekday: 1,
    active: 0,
    expect: false
  },
  {
    label: '周日 21:00，今天 1 条会话',
    date: '2026-11-08',
    time: '21:00',
    weekday: 0,
    active: 1,
    expect: true
  },
  {
    label: '周一 20:59，今天 2 条会话',
    date: '2026-11-02',
    time: '20:59',
    weekday: 1,
    active: 2,
    expect: false
  },
  {
    label: '周一 09:00，今天 2 条会话',
    date: '2026-11-02',
    time: '09:00',
    weekday: 1,
    active: 2,
    expect: false
  }
]
const CASES_B2: WhenCase[] = [
  { label: '周日 20:00', date: '2026-11-08', time: '20:00', weekday: 0, active: 0, expect: true },
  { label: '周六 20:00', date: '2026-11-07', time: '20:00', weekday: 6, active: 2, expect: false },
  { label: '周一 20:00', date: '2026-11-02', time: '20:00', weekday: 1, active: 2, expect: false },
  { label: '周日 20:01', date: '2026-11-08', time: '20:01', weekday: 0, active: 2, expect: false },
  { label: '周日 08:00', date: '2026-11-08', time: '08:00', weekday: 0, active: 2, expect: false }
]

let app: E2EApp
let events: EventRecorder
let key = ''
const redact = (text: string): string => (key ? text.split(key).join('<redacted>') : text)

beforeAll(async () => {
  const env = collectProbeEnv(
    process.env,
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
  )
  const provider = (process.env.PROBE_PROVIDER ?? 'deepseek').toLowerCase()
  app = await launchApp()
  await waitRendererReady(app.main)
  if (provider === 'kimi') {
    key = env.SHUVIX_PROBE_KIMI_KEY ?? ''
    if (!key) throw new Error(`SHUVIX_PROBE_KIMI_KEY not found (env or ${ENV_FILE})`)
    await seedRealModel(app.main, {
      providerId: 'kimi-coding',
      providerName: 'kimi',
      apiKey: key,
      apiProtocol: 'anthropic-messages',
      modelId: env.SHUVIX_PROBE_KIMI_MODEL ?? 'kimi-for-coding'
    })
  } else {
    key = env.SHUVIX_PROBE_COMPLETIONS_KEY ?? ''
    const modelId = env.SHUVIX_PROBE_COMPLETIONS_MODEL ?? ''
    if (!key || !modelId) throw new Error(`deepseek key / model not found (env or ${ENV_FILE})`)
    await seedRealModel(app.main, {
      providerId: 'deepseek',
      providerName: 'deepseek',
      apiKey: key,
      apiProtocol: 'openai-completions',
      modelId
    })
  }
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
  )
  await installRealHomeGuard(app, resolve(process.cwd(), '../..'))
  events = eventRecorder(app.main)
  await events.install()
}, 180_000)

afterAll(async () => {
  await app?.stop()
})

/** 一条会话的转写（文字 + 工具调用；工具结果截断） */
async function transcriptOf(sid: string): Promise<string> {
  return app.main.eval<string>(`
    (async () => {
      const msgs = await window.api.message.list(${JSON.stringify(sid)})
      const out = []
      for (const m of msgs) {
        if (m.role === 'user') { out.push('>>> USER: ' + m.content); continue }
        if (m.role !== 'assistant') { out.push('### ' + m.role + ': ' + m.content); continue }
        for (const b of m.blocks ?? []) {
          if (b.type === 'text' && b.text?.trim()) out.push('<<< ASSISTANT:\\n' + b.text)
          if (b.type !== 'tool') continue
          const args = JSON.stringify(b.args ?? {})
          out.push('[TOOL] ' + b.toolName + ' ' + (args.length > 2500 ? args.slice(0, 2500) + '…' : args))
          const result = String(b.result ?? '')
          out.push('[RESULT]' + (b.isError ? ' (ERROR)' : '') + ' ' + (result.length > 900 ? result.slice(0, 900) + '…' : result))
        }
      }
      return out.join('\\n\\n')
    })()
  `)
}

/** 工具调用（名字 + action + 路径 / query），按先后 */
async function toolCallsOf(sid: string): Promise<string[]> {
  return app.main.eval<string[]>(`
    (async () => {
      const msgs = await window.api.message.list(${JSON.stringify(sid)})
      const out = []
      for (const m of msgs) for (const b of m.blocks ?? []) {
        if (b.type !== 'tool') continue
        const a = b.args ?? {}
        const where = a.path ?? a.file_path ?? a.filePath ?? a.query ?? a.base ?? ''
        out.push(b.toolName + (a.action ? ':' + a.action : '') + (where ? ' ' + where : ''))
      }
      return out
    })()
  `)
}

async function lastReplyOf(sid: string): Promise<string> {
  return app.main.eval<string>(`
    window.api.message.list(${JSON.stringify(sid)}).then((msgs) => {
      const a = msgs.filter((m) => m.role === 'assistant' && (m.content || '').trim())
      return a.length ? a[a.length - 1].content : ''
    })
  `)
}

const botsDir = (): string => join(app.home, '.shuvix', 'bots')

function botFiles(): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(botsDir())) return out
  for (const name of readdirSync(botsDir())) {
    if (name.startsWith('.') || !name.endsWith('.md')) continue
    out[name] = readFileSync(join(botsDir(), name), 'utf8')
  }
  return out
}

interface Expectation {
  /** 期望的 bot 名（frontmatter name） */
  name: string
  displayName?: string
  project?: string
  cases: WhenCase[]
}

/** 给一份 bot 文件打分；回报告行 */
async function grade(fileName: string, want: Expectation): Promise<string[]> {
  const path = join(botsDir(), fileName)
  if (!existsSync(path)) return [`- **文件不在**：${fileName}`]
  const raw = readFileSync(path, 'utf8')
  const warns: string[] = []
  const parsed = parseBotDefinitionFile(raw, fileName.replace(/\.md$/, ''), (m) => warns.push(m))
  const lines: string[] = ['', '```md', raw.trimEnd(), '```', '']
  if (!parsed) {
    lines.push(`- **解析器拒绝整份文件**：${warns.join(' / ')}`)
    return lines
  }
  const list = await app.main.eval<{
    bots: Array<{ name: string; fileName: string; shadowed?: boolean }>
    invalid: Array<{ fileName: string; error: string }>
  }>(`window.api.bot.list()`)
  const inList = list.bots.find((b) => b.fileName === fileName)
  const invalid = list.invalid.find((f) => f.fileName === fileName)
  lines.push(
    `- 解析：${warns.length ? '**有告警** ' + warns.join(' / ') : '零告警'}；name \`${parsed.name}\`${parsed.name === want.name ? '' : ' **（期望 ' + want.name + '）**'}；显示名 \`${parsed.displayName}\`${want.displayName && parsed.displayName !== want.displayName ? ' **（期望 ' + want.displayName + '）**' : ''}`,
    `- bot 列表：${invalid ? '**非法** ' + invalid.error : inList ? (inList.shadowed ? '**被遮蔽**' : '认了') : '**不在列表里**'}`
  )
  const bindings = parsed.bindings ?? []
  lines.push(`- 绑定 ${bindings.length} 条${bindings.length === 1 ? '' : ' **（期望 1 条）**'}`)
  for (const [i, b] of bindings.entries()) {
    lines.push(
      `  - #${i} trigger \`${b.trigger}\`${b.trigger === 'timer.fired' ? '' : ' **✗**'}；project \`${b.project ?? '（临时）'}\`${(b.project ?? undefined)?.toLowerCase() === want.project?.toLowerCase() ? '' : ' **✗（期望 ' + (want.project ?? '临时') + '）**'}`,
      `  - when：\`${b.when ?? '（缺省 = 每分钟都命中）'}\``,
      `  - message：${b.message}`
    )
    let wrong = 0
    for (const c of want.cases) {
      let got: string
      try {
        setWhenHostFunctions({ activeSessions: () => c.active ?? 0 })
        const v =
          b.when === undefined
            ? true
            : evaluateWhen(b.when, {
                event: {
                  sourceId: 'timer:builtin:minute',
                  firedAt: `${c.date}T${c.time}:00.000Z`,
                  local: local(c),
                  trigger: 'timer.fired'
                },
                env: {}
              })
        got = String(v)
        if (v !== c.expect) wrong++
      } catch (e) {
        got = `求值出错：${e instanceof Error ? e.message : e}`
        wrong++
      }
      const ok = got === String(c.expect)
      lines.push(
        `    - ${ok ? '✓' : '**✗**'} ${c.label}${c.active === undefined ? '' : `（activeSessions=${c.active}）`} → ${got}（期望 ${c.expect}）`
      )
    }
    lines.push(`  - 时刻表：${wrong === 0 ? '全对' : `**错 ${wrong} / ${want.cases.length}**`}`)
  }
  return lines
}

it(
  'bot config: the AI writes bots and trigger bindings as the user asked',
  async () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'probe-bot-config-report-'))
    const debug = makeDebug(reportDir)
    const workdir = mkdtempSync(join(tmpdir(), 'probe-bot-config-'))
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ name: 'tiny-cli', version: '0.1.0' }, null, 2)
    )
    await createProject(app.main, { name: 'tiny-cli', path: workdir })
    const openBotFile = writeBotMd(app, OPEN_BOT, {
      displayName: '小舟',
      description: '编程搭子',
      body: OPEN_BOT_BODY
    })
    const openBotFileName = `${OPEN_BOT}.md`
    const openBotBefore = readFileSync(openBotFile, 'utf8')
    await app.main.eval(`window.api.bot.list().then(() => true)`)

    const report: string[] = [
      `# AI 配置 bot 与触发条件（${process.env.PROBE_PROVIDER ?? 'deepseek'}，界面语言 ${LANG}）`,
      ''
    ]

    async function turn(
      label: string,
      sid: string,
      text: string
    ): Promise<{ calls: string[]; asks: number }> {
      const callsBefore = (await toolCallsOf(sid)).length
      const asksBefore = await asksRaisedIn(events, sid)
      await sendPrompt(app, sid, text)
      await settle({
        app,
        events,
        sid,
        label,
        answer: () => '你自己判断就行。',
        debug,
        quietMs: 15_000
      })
      return {
        calls: (await toolCallsOf(sid)).slice(callsBefore),
        asks: (await asksRaisedIn(events, sid)) - asksBefore
      }
    }

    const consulted = (calls: string[]): string =>
      calls.some((c) => /knowledge|bot-md/.test(c)) ? '查了' : '**没查**'

    // ── A：临时会话 + 勾上 shuvix 知识库 ──────────────────────────────────────────────────
    const sidA = await app.main.eval<string>(
      `window.api.session.create({ title: 'A 临时会话' }).then((s) => s.id)`
    )
    await app.main.eval(
      `window.api.session.updateKnowledgeBases(${JSON.stringify({ id: sidA, knowledgeBases: ['shuvix'] })})`
    )
    const beforeA = botFiles()
    const a = await turn('A 新建 standup', sidA, PROMPT_A)
    const afterA = botFiles()
    const newA = Object.keys(afterA).filter((n) => !(n in beforeA))
    report.push(
      '## A：临时会话，勾上「ShuviX 系统说明」知识库',
      '',
      `> ${PROMPT_A}`,
      '',
      `- 工具调用：${a.calls.map((c) => '`' + c + '`').join(', ') || '（无）'}`,
      `- 手册：${consulted(a.calls)}；询问 ${a.asks} 次`,
      `- 新文件：${newA.join('、') || '**无**'}`,
      '',
      '### 回复',
      '',
      await lastReplyOf(sidA)
    )
    report.push(
      ...(await grade(newA.find((n) => /standup/i.test(n)) ?? newA[0] ?? 'standup.md', {
        name: 'standup',
        displayName: '站会助手',
        project: 'tiny-cli',
        cases: CASES_A
      }))
    )

    // ── B：另一个 bot 的笔记本会话 ────────────────────────────────────────────────────────
    const note = await app.main.eval<{ id: string }>(
      `window.api.bot.openNote(${JSON.stringify({ fileName: openBotFileName })})`
    )
    const sidB = note.id
    const b1 = await turn('B1 给小舟加定时', sidB, PROMPT_B1)
    const afterB1 = readFileSync(openBotFile, 'utf8')
    report.push(
      '',
      '## B1：打开小舟的笔记本，给这个 bot 加定时',
      '',
      `> ${PROMPT_B1}`,
      '',
      `- 工具调用：${b1.calls.map((c) => '`' + c + '`').join(', ') || '（无）'}`,
      `- 手册：${consulted(b1.calls)}；询问 ${b1.asks} 次`,
      `- 小舟的人设与记忆：${afterB1.includes('你是小舟，这个用户的编程搭子') && afterB1.includes('回答先给结论') ? '保留' : '**被改了**'}`,
      '',
      '### 回复',
      '',
      await lastReplyOf(sidB)
    )
    report.push(
      ...(await grade(openBotFileName, { name: OPEN_BOT, displayName: '小舟', cases: CASES_B1 }))
    )

    const beforeB2 = botFiles()
    const b2 = await turn('B2 另建 weekly', sidB, PROMPT_B2)
    const afterB2 = botFiles()
    const newB2 = Object.keys(afterB2).filter((n) => !(n in beforeB2))
    report.push(
      '',
      '## B2：同一个笔记本里另建一个 bot',
      '',
      `> ${PROMPT_B2}`,
      '',
      `- 工具调用：${b2.calls.map((c) => '`' + c + '`').join(', ') || '（无）'}`,
      `- 手册：${consulted(b2.calls)}；询问 ${b2.asks} 次`,
      `- 新文件：${newB2.join('、') || '**无**'}`,
      `- 小舟这一轮：${afterB2[openBotFileName] === afterB1 ? '没动' : '**被改了**'}（起始与 B1 之后的差异见上）`,
      '',
      '### 回复',
      '',
      await lastReplyOf(sidB)
    )
    report.push(
      ...(await grade(newB2.find((n) => /weekly/i.test(n)) ?? newB2[0] ?? 'weekly.md', {
        name: 'weekly',
        displayName: '周报',
        cases: CASES_B2
      }))
    )
    report.push('', `- 起始的小舟：`, '', '```md', openBotBefore.trimEnd(), '```')

    report.push('', '## 转写：A', '', '```text', await transcriptOf(sidA), '```')
    report.push('', '## 转写：B（B1 + B2）', '', '```text', await transcriptOf(sidB), '```')

    const text = redact(report.join('\n'))
    if (text.includes(`${REAL_HOME}/.shuvix`))
      debug('report mentions the real ~/.shuvix — check it')
    writeFileSync(OUT, text)
    console.log(`bot config probe report: ${OUT}\ndebug log: ${join(reportDir, 'debug.log')}`)
  },
  45 * 60 * 1000
)
