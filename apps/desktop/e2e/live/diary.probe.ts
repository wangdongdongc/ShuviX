/**
 * 日记 bot 的真模型演练 —— 不断言，把它傍晚那一轮的回复与建议摊开给人读，看建议对用户有没有用。
 *
 * 2026-10-31 日报 bot 改成日记 bot：只看今天的会话和昨天有没有日记，先给建议、不直接动手。这里：
 *   1. 用真模型过一遍「今天」：修了一个 bug（做完了）、README 只列了提纲（说了明天再改）、周五要交的季度总结
 *      （有期限）、一个顺口问的 Python 问题（不值得提）；
 *   2. 走真的内置分钟定时器叫醒随应用提供的 daily.md（把 `when` 改成下一分钟，id 与路径不变，
 *      所以 daily-bot-access 照样认它）—— 场景 A 昨天没有日记，场景 B 昨天的日记写了「明天要做」；
 *   3. 场景 B 里采纳一条写日记的建议，看它写进今天的日记的是什么。
 *
 * 报告里给每一轮：工具调用、询问次数、回复、建议，以及 bot 这一轮有没有写文件（daily / tracking 目录前后对比）。
 *
 * 模型：`PROBE_PROVIDER=deepseek`（缺省，`SHUVIX_PROBE_COMPLETIONS_KEY` / `_MODEL`）或 `kimi`
 * （`SHUVIX_PROBE_KIMI_KEY`），key 只从 `~/.shuvix-probe.env`（或环境变量）来。界面语言缺省 zh
 * （`PROBE_LANG` 换）。报告写到 `PROBE_OUT`。
 *
 * 权限询问只放行不碰这台电脑真实主目录的（`settle`，见 redactionProbeShared.ts —— 2026-10-19 的事故）。
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
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { BUILTIN_BOT_SEEDS } from '../../../../packages/agent-runtime/src/bot/builtinBots'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  asksRaisedIn,
  createProject,
  eventRecorder,
  sessionsBoundTo,
  waitRendererReady,
  type EventRecorder
} from '../harness/seed'
import { until } from '../harness/cdp'
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

const OUT = process.env.PROBE_OUT ?? join(tmpdir(), 'shuvix-diary-probe.md')
const LANG = (process.env.PROBE_LANG ?? 'zh') as 'zh' | 'en' | 'ja'
const DAILY_WHEN = "event.local.time == '18:00' && activeSessions(event.local.date) > 0"

/** 被修的那份代码：`--name=foo` 解析成空串（split 之后取错了下标） */
const ARGS_TS = `export interface Args {
  [key: string]: string | boolean
}

export function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    if (a.includes('=')) {
      const parts = a.slice(2).split('=')
      out[parts[0]] = parts[2] ?? ''
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[i + 1]
      i++
    } else {
      out[a.slice(2)] = true
    }
  }
  return out
}
`

interface DayTurn {
  label: string
  /** 在项目 tiny-cli 里，还是项目外的临时会话 */
  inProject: boolean
  text: string
}

/** 「今天」的四条会话 */
const DAY: DayTurn[] = [
  {
    label: 'S1 修 bug（做完）',
    inProject: true,
    text: 'src/args.ts 里 parseArgs 有个 bug：`--name=foo` 解析出来是空串。帮我修一下，改完就行，不用写测试。'
  },
  {
    label: 'S2 README 提纲（明天再改）',
    inProject: true,
    text: '帮我给 tiny-cli 列一个 README 的提纲就行，正文我明天自己再细改，今天先不写文件。'
  },
  {
    label: 'S3 季度总结（11 月 6 日截止）',
    inProject: false,
    text: '我下周五（11 月 6 日）之前要交 Q3 的季度总结，帮我想想大概该写哪几块，先给个框架，我还没开始写。'
  },
  {
    label: 'S4 顺口一问',
    inProject: false,
    text: 'Python 里怎么读一个 JSON 文件？一句话告诉我就行。'
  }
]

const pad = (n: number): string => String(n).padStart(2, '0')
const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

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
  // 让产品自己写 daily.md（并把它记成「ShuviX 写的那份」—— daily-bot-access 只认那一份）
  app = await launchApp({ builtinBots: true })
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
          out.push('[RESULT]' + (b.isError ? ' (ERROR)' : '') + ' ' + (result.length > 1200 ? result.slice(0, 1200) + '…' : result))
        }
      }
      return out.join('\\n\\n')
    })()
  `)
}

/** 这条会话里的工具调用（名字 + session 的 action + 路径），按先后 */
async function toolCallsOf(sid: string): Promise<string[]> {
  return app.main.eval<string[]>(`
    (async () => {
      const msgs = await window.api.message.list(${JSON.stringify(sid)})
      const out = []
      for (const m of msgs) for (const b of m.blocks ?? []) {
        if (b.type !== 'tool') continue
        const a = b.args ?? {}
        const where = a.path ?? a.file_path ?? a.filePath ?? a.session_id ?? ''
        out.push(b.toolName + (a.action ? ':' + a.action : '') + (where ? ' ' + where : ''))
      }
      return out
    })()
  `)
}

interface Suggestion {
  messageId: string
  toolCallId: string
  index: number
  title: string
  message: string
  detail?: string
}

/** 这条会话里所有成功落定的 suggest 调用里的提议 */
async function suggestionsOf(sid: string): Promise<Suggestion[]> {
  return app.main.eval<Suggestion[]>(`
    (async () => {
      const msgs = await window.api.message.list(${JSON.stringify(sid)})
      const out = []
      for (const m of msgs) {
        if (m.role !== 'assistant') continue
        for (const b of m.blocks ?? []) {
          if (b.type !== 'tool' || b.toolName !== 'suggest' || b.isError) continue
          const items = (b.args && b.args.suggestions) || []
          items.forEach((s, index) => out.push({ messageId: m.id, toolCallId: b.toolCallId, index, title: s.title, message: s.message, detail: s.detail }))
        }
      }
      return out
    })()
  `)
}

/** 最后一条助手消息的正文（回复） */
async function lastReplyOf(sid: string): Promise<string> {
  return app.main.eval<string>(`
    window.api.message.list(${JSON.stringify(sid)}).then((msgs) => {
      const a = msgs.filter((m) => m.role === 'assistant' && (m.content || '').trim())
      return a.length ? a[a.length - 1].content : ''
    })
  `)
}

/** 一个目录下的文件与内容（不在 = 空） */
function snapshotDir(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {}
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    try {
      out[name] = readFileSync(join(dir, name), 'utf8')
    } catch {
      /* 目录 */
    }
  }
  return out
}

function diffDirs(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...names].filter((n) => before[n] !== after[n])
}

it(
  'diary bot: evening run summarizes today and makes useful suggestions',
  async () => {
    const reportDir = mkdtempSync(join(tmpdir(), 'probe-diary-report-'))
    const debug = makeDebug(reportDir)
    const dailyDir = join(app.home, '.shuvix', 'daily')
    const trackingDir = join(app.home, '.shuvix', 'tracking')
    const dailyFile = join(app.home, '.shuvix', 'bots', 'daily.md')
    if (!existsSync(dailyFile)) throw new Error('daily.md was not seeded')

    const workdir = mkdtempSync(join(tmpdir(), 'probe-diary-'))
    mkdirSync(join(workdir, 'src'), { recursive: true })
    writeFileSync(join(workdir, 'src', 'args.ts'), ARGS_TS)
    writeFileSync(
      join(workdir, 'package.json'),
      JSON.stringify({ name: 'tiny-cli', version: '0.1.0', type: 'module' }, null, 2)
    )
    const project = await createProject(app.main, { name: 'tiny-cli', path: workdir })

    const report: string[] = [
      `# 日记 bot 演练（${process.env.PROBE_PROVIDER ?? 'deepseek'}，界面语言 ${LANG}）`,
      ''
    ]

    // ── 1. 今天 ──────────────────────────────────────────────────────────────────────
    report.push('## 今天的会话', '')
    for (const turn of DAY) {
      const sid = await app.main.eval<string>(
        `window.api.session.create(${JSON.stringify({
          title: turn.label,
          ...(turn.inProject ? { projectId: project.id } : {})
        })}).then((s) => s.id)`
      )
      await sendPrompt(app, sid, turn.text)
      await settle({ app, events, sid, label: turn.label, answer: () => '你自己判断就行。', debug })
      const reply = await lastReplyOf(sid)
      report.push(
        `### ${turn.label}`,
        '',
        `> ${turn.text}`,
        '',
        `- 工具调用：${(await toolCallsOf(sid)).map((c) => '`' + c + '`').join(', ') || '（无）'}`,
        `- 回复（截断）：${reply.replace(/\s+/g, ' ').slice(0, 240)}`,
        ''
      )
    }
    report.push(
      `- 修完之后的 src/args.ts 第 11 行：\`${readFileSync(join(workdir, 'src', 'args.ts'), 'utf8')
        .split('\n')[10]
        ?.trim()}\``
    )

    // ── 2. 傍晚的两轮 ─────────────────────────────────────────────────────────────────
    const today = new Date()
    const yesterday = dayKey(new Date(today.getTime() - 24 * 3600 * 1000))
    const seed = BUILTIN_BOT_SEEDS.find((s) => s.name === 'daily')!

    /** 把 daily.md 换成这一语言的出厂文本，只把触发时刻改成下一分钟；等定时器叫醒它、跑完 */
    async function fireDiary(label: string): Promise<string> {
      const target = new Date(Math.ceil((Date.now() + 45_000) / 60_000) * 60_000)
      const hhmm = `${pad(target.getHours())}:${pad(target.getMinutes())}`
      const text = seed
        .render(LANG)
        .replace(
          `when: ${DAILY_WHEN}`,
          `when: event.local.time == '${hhmm}' && activeSessions(event.local.date) > 0`
        )
      if (!text.includes(`'${hhmm}'`)) throw new Error('when line not found in the render')
      writeFileSync(dailyFile, text)
      await app.main.eval(`window.api.bot.list().then(() => true)`)
      const before = await sessionsBoundTo(app.main, 'daily')
      debug(`${label}: waiting for the ${hhmm} firing`)
      const sid = await until(
        async () => (await sessionsBoundTo(app.main, 'daily')).find((id) => !before.includes(id)),
        `${label}: the triggered diary run`,
        target.getTime() - Date.now() + 90_000
      )
      await settle({
        app,
        events,
        sid,
        label,
        answer: () => '你自己判断就行。',
        debug,
        quietMs: 20_000
      })
      return sid
    }

    async function reportRun(label: string, sid: string, writes: string[]): Promise<Suggestion[]> {
      const suggestions = await suggestionsOf(sid)
      report.push(
        '',
        `## ${label}`,
        '',
        `- 工具调用：${(await toolCallsOf(sid)).map((c) => '`' + c + '`').join(', ') || '（无）'}`,
        `- 询问：${await asksRaisedIn(events, sid)} 次`,
        `- 这一轮改动的日记 / 跟踪项文件：${writes.length ? '**' + writes.join('、') + '**' : '无'}`,
        '',
        '### 回复',
        '',
        await lastReplyOf(sid),
        '',
        `### 建议（${suggestions.length} 条）`,
        ''
      )
      for (const s of suggestions) {
        report.push(`${s.index + 1}. **${s.title}**`, `   - message：${s.message}`)
        if (s.detail) report.push(`   - detail：${s.detail}`)
      }
      return suggestions
    }

    // 场景 A：昨天没有日记
    let dailyBefore = snapshotDir(dailyDir)
    let trackingBefore = snapshotDir(trackingDir)
    const runA = await fireDiary('A 傍晚（昨天没写日记）')
    await reportRun(`场景 A：昨天（${yesterday}）没有日记`, runA, [
      ...diffDirs(dailyBefore, snapshotDir(dailyDir)).map((n) => `daily/${n}`),
      ...diffDirs(trackingBefore, snapshotDir(trackingDir)).map((n) => `tracking/${n}`)
    ])

    // 场景 B：昨天写了，带「明天要做」
    mkdirSync(dailyDir, { recursive: true })
    const yesterdayDiary = [
      '---',
      'shuvix: daily v1',
      '---',
      '',
      '## 今天做了什么',
      '',
      '- 给 tiny-cli 起了个头，写了参数解析 parseArgs',
      '- 发现 `--name=foo` 会解析成空串，还没修',
      '',
      '## 明天',
      '',
      '- 修 parseArgs 的 bug',
      '- 写 README',
      '- 季度总结开个头',
      ''
    ].join('\n')
    writeFileSync(join(dailyDir, `${yesterday}.md`), yesterdayDiary)
    dailyBefore = snapshotDir(dailyDir)
    trackingBefore = snapshotDir(trackingDir)
    const runB = await fireDiary('B 傍晚（昨天写了日记）')
    const suggestionsB = await reportRun(
      `场景 B：昨天（${yesterday}）的日记写了「明天」三件事`,
      runB,
      [
        ...diffDirs(dailyBefore, snapshotDir(dailyDir)).map((n) => `daily/${n}`),
        ...diffDirs(trackingBefore, snapshotDir(trackingDir)).map((n) => `tracking/${n}`)
      ]
    )
    report.splice(
      report.indexOf('## 今天的会话'),
      0,
      '## 昨天的日记（场景 B）',
      '',
      '```md',
      yesterdayDiary,
      '```',
      ''
    )

    // ── 3. 采纳一条写日记的建议 ────────────────────────────────────────────────────────
    const pick =
      suggestionsB.find(
        (s) =>
          /日记|diary|日記/i.test(s.title + s.message) &&
          /今天|today|今日/.test(s.title + s.message)
      ) ?? suggestionsB.find((s) => /日记|diary|日記/i.test(s.title + s.message))
    report.push('', '## 采纳一条写日记的建议（场景 B）', '')
    if (!pick) {
      report.push('（没有写日记的建议，跳过）')
    } else {
      const todayFile = join(dailyDir, `${dayKey(today)}.md`)
      const result = await app.main.eval<unknown>(
        `window.api.suggestion.accept(${JSON.stringify({
          sessionId: runB,
          messageId: pick.messageId,
          toolCallId: pick.toolCallId,
          index: pick.index
        })})`
      )
      debug(`accept → ${JSON.stringify(result)}`)
      const asksBefore = await asksRaisedIn(events, runB)
      await settle({
        app,
        events,
        sid: runB,
        label: 'B accept',
        answer: () => '你自己判断就行。',
        debug,
        quietMs: 20_000
      })
      report.push(
        `- 采纳的是第 ${pick.index + 1} 条：**${pick.title}**`,
        `- accept 结果：\`${JSON.stringify(result)}\``,
        `- 采纳之后的询问：${(await asksRaisedIn(events, runB)) - asksBefore} 次`,
        `- 昨天的日记：${readFileSync(join(dailyDir, `${yesterday}.md`), 'utf8') === yesterdayDiary ? '没动' : '**被改了**'}`,
        '',
        '### 今天的日记',
        '',
        '```md',
        existsSync(todayFile) ? readFileSync(todayFile, 'utf8') : '（没有写）',
        '```',
        '',
        '### 采纳后的回复',
        '',
        await lastReplyOf(runB)
      )
    }

    report.push('', '## 转写：场景 A', '', '```text', await transcriptOf(runA), '```')
    report.push('', '## 转写：场景 B（含采纳）', '', '```text', await transcriptOf(runB), '```')

    const text = redact(report.join('\n'))
    if (text.includes(`${REAL_HOME}/.shuvix`))
      debug('report mentions the real ~/.shuvix — check it')
    writeFileSync(OUT, text)
    console.log(`diary probe report: ${OUT}\ndebug log: ${join(reportDir, 'debug.log')}`)
  },
  45 * 60 * 1000
)
