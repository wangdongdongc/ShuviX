/**
 * bot 基座提示词的真模型演练 —— 不断言，跑几轮对话并把转写、bot 文件的变化摊开给人读。
 *
 * 看的是 2026-10-30 那次调整（减弱项目管理倾向、加强持续记录并整理用户偏好）在真模型上的效果：
 *   - 一个多步的活（修 bug + 整理 + 补测试）它是自己干、还是拆给子会话 / 写工单；
 *   - 用户说出偏好、纠正它之后，它有没有**当场**把偏好记进自己那份文件，记的是不是带范围的、分好类的；
 *   - 「行，先这样」这种没有新东西的一轮，文件是不是没被乱动；
 *   - 新开一条会话，它会不会不等人问就照着记忆办（短答、pnpm）；
 *   - 换到项目之外的会话，只在「这个仓库」成立的偏好会不会被乱套。
 *
 * 模型：`PROBE_PROVIDER=kimi`（缺省，`SHUVIX_PROBE_KIMI_KEY`）或 `deepseek`
 * （`SHUVIX_PROBE_COMPLETIONS_KEY` / `_MODEL`），key 只从 `~/.shuvix-probe.env`（或环境变量）来。
 * 界面语言缺省 zh（`PROBE_LANG` 换），因为 bot 档案按语言挑正文。报告写到 `PROBE_OUT`。
 *
 * 权限询问只放行不碰这台电脑真实主目录的（`settle`，见 redactionProbeShared.ts —— 2026-10-19 的事故）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  createBotSession,
  createProject,
  eventRecorder,
  waitRendererReady,
  writeBotMd,
  type EventRecorder
} from '../harness/seed'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'
import { ENV_FILE, makeDebug, REAL_HOME, sendPrompt, settle } from './redactionProbeShared'

const OUT = process.env.PROBE_OUT ?? join(tmpdir(), 'shuvix-bot-probe.md')
const LANG = process.env.PROBE_LANG ?? 'zh'
const BOT = 'xiaozhou'

const BOT_BODY = [
  '## 我是谁',
  '',
  '你是小舟，这个用户的编程搭子。说话随和、直接。',
  '',
  '## 我记得什么',
  '',
  '（这一段归它自己。它会把了解到的你的偏好按主题整理在这里，并随对话不断更新。）'
].join('\n')

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

const PACKAGE_JSON = JSON.stringify(
  { name: 'tiny-cli', version: '0.1.0', type: 'module', scripts: {} },
  null,
  2
)

interface Turn {
  /** 报告里的小标题 */
  label: string
  /** 'A' / 'B' 在项目里，'C' 是项目外的临时会话 */
  session: 'A' | 'B' | 'C'
  text: string
}

const TURNS: Turn[] = [
  {
    label: 'A1 多步的活（修 bug + 整理 + 补测试）',
    session: 'A',
    text: '帮我看看 src/args.ts 里的 parseArgs，有个 bug：`--name=foo` 解析出来是空的。顺便把这个模块整理一下，再补上测试。'
  },
  {
    label: 'A2 明说偏好（短答、先结论、pnpm）',
    session: 'A',
    text: '你话有点多。以后回答短一点，先说结论，别列一堆小标题。还有这个仓库用 pnpm，别给我写 npm 的命令。'
  },
  {
    label: 'A3 纠正（这个仓库用 vitest）',
    session: 'A',
    text: '测试框架不对，我们这儿用 vitest，不是 jest。改一下。'
  },
  { label: 'A4 没有新东西', session: 'A', text: '行，先这样。' },
  {
    label: 'B1 新会话：会不会照着记忆办',
    session: 'B',
    text: '想给这个项目加个 lint，怎么弄？'
  },
  {
    label: 'C1 项目外的会话：范围有没有乱套',
    session: 'C',
    text: '随便问一下，Python 里怎么读一个 JSON 文件？'
  }
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
  const provider = (process.env.PROBE_PROVIDER ?? 'kimi').toLowerCase()
  app = await launchApp()
  await waitRendererReady(app.main)
  if (provider === 'deepseek') {
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
  } else {
    key = env.SHUVIX_PROBE_KIMI_KEY ?? ''
    if (!key) throw new Error(`SHUVIX_PROBE_KIMI_KEY not found (env or ${ENV_FILE})`)
    await seedRealModel(app.main, {
      providerId: 'kimi-coding',
      providerName: 'kimi',
      apiKey: key,
      apiProtocol: 'anthropic-messages',
      modelId: env.SHUVIX_PROBE_KIMI_MODEL ?? 'kimi-for-coding'
    })
  }
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
  )
  events = eventRecorder(app.main)
  await events.install()
}, 180_000)

afterAll(async () => {
  await app?.stop()
})

/** 一条会话的转写（文字 + 工具调用；bot 文件的 edit 原样保留，别的工具结果截断） */
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
          out.push('[RESULT]' + (b.isError ? ' (ERROR)' : '') + ' ' + (result.length > 600 ? result.slice(0, 600) + '…' : result))
        }
      }
      return out.join('\\n\\n')
    })()
  `)
}

/** 这条会话里的工具调用名（含 session 的 action），按先后 */
async function toolCallsOf(sid: string): Promise<string[]> {
  return app.main.eval<string[]>(`
    (async () => {
      const msgs = await window.api.message.list(${JSON.stringify(sid)})
      const out = []
      for (const m of msgs) for (const b of m.blocks ?? []) {
        if (b.type !== 'tool') continue
        const a = b.args ?? {}
        const where = a.path ?? a.file_path ?? a.filePath ?? ''
        out.push(b.toolName + (a.action ? ':' + a.action : '') + (where ? ' ' + where : ''))
      }
      return out
    })()
  `)
}

it(
  'bot: preferences are recorded and organized, work is not project-managed',
  async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'probe-bot-'))
    mkdirSync(join(workdir, 'src'), { recursive: true })
    writeFileSync(join(workdir, 'src', 'args.ts'), ARGS_TS)
    writeFileSync(join(workdir, 'package.json'), PACKAGE_JSON)
    const project = await createProject(app.main, { name: 'tiny-cli', path: workdir })
    const botFile = writeBotMd(app, BOT, {
      displayName: '小舟',
      description: '编程搭子',
      body: BOT_BODY
    })

    const reportDir = mkdtempSync(join(tmpdir(), 'probe-bot-report-'))
    const debug = makeDebug(reportDir)
    const sessions: Record<Turn['session'], string> = {
      A: await createBotSession(app.main, { bot: BOT, title: '小舟 A', projectId: project.id }),
      B: '',
      C: ''
    }
    const systemPrompt = await app.main.eval<string>(
      `window.api.agent.getInfo(${JSON.stringify(sessions.A)}, { ensure: true }).then((i) => i.systemPrompt)`
    )

    const report: string[] = [
      `# bot 提示词演练（${process.env.PROBE_PROVIDER ?? 'kimi'}，界面语言 ${LANG}）`,
      '',
      `- 系统提示词含「记住这个人」一节：${systemPrompt.includes('## 记住这个人') || systemPrompt.includes('## Remembering this person') ? '是' : '**否**'}`,
      `- 系统提示词点名子会话动作：${/create-sub-session|prompt-session/.test(systemPrompt) ? '**是**' : '否'}`,
      '',
      '## 起始 bot 文件',
      '',
      '```md',
      readFileSync(botFile, 'utf8'),
      '```'
    ]

    let before = readFileSync(botFile, 'utf8')
    for (const turn of TURNS) {
      if (!sessions[turn.session]) {
        sessions[turn.session] = await createBotSession(app.main, {
          bot: BOT,
          title: `小舟 ${turn.session}`,
          ...(turn.session === 'C' ? {} : { projectId: project.id })
        })
      }
      const sid = sessions[turn.session]
      const callsBefore = (await toolCallsOf(sid)).length
      await sendPrompt(app, sid, turn.text)
      const questions = await settle({
        app,
        events,
        sid,
        label: turn.label,
        answer: () => '你自己判断就行。',
        debug
      })
      const calls = (await toolCallsOf(sid)).slice(callsBefore)
      const after = readFileSync(botFile, 'utf8')
      report.push(
        '',
        `## ${turn.label}`,
        '',
        `> ${turn.text}`,
        '',
        `- 工具调用：${calls.length ? calls.map((c) => '`' + c.replace(botFile, '<bot 文件>') + '`').join(', ') : '（无）'}`,
        `- 用 ask 问了 ${questions} 次`,
        `- bot 文件：${after === before ? '没变' : '**改了**'}`
      )
      if (after !== before) report.push('', '```md', after, '```')
      before = after
    }

    for (const [name, sid] of Object.entries(sessions)) {
      if (!sid) continue
      report.push('', `## 转写：会话 ${name}`, '', '```text', await transcriptOf(sid), '```')
    }
    // 子会话（不该有）
    const kids = await app.main.eval<Array<{ id: string; title: string; parentId?: string }>>(
      `window.api.session.list().then((ss) => ss.filter((s) => s.parentId).map((s) => ({ id: s.id, title: s.title, parentId: s.parentId })))`
    )
    report.splice(
      4,
      0,
      `- 开出的子会话：${kids.length ? kids.map((k) => k.title).join('、') : '无'}`
    )

    const text = redact(report.join('\n'))
    if (text.includes(`${REAL_HOME}/.shuvix`))
      debug('report mentions the real ~/.shuvix — check it')
    writeFileSync(OUT, text)
    console.log(`bot probe report: ${OUT}\ndebug log: ${join(reportDir, 'debug.log')}`)
  },
  45 * 60 * 1000
)
