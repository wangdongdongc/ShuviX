/**
 * 作图分流的真模型探针 —— 不断言，跑一组「画一下 X」的请求，看真模型拿到作图技能之后：
 * 用的是哪种块（```svg / ```mermaid / ```interactive）、和题目该用的块对不对得上、花了多少、
 * mermaid 图 pele 解析得了没有、守没守技能里的 mermaid 契约（accTitle、不写颜色、至多一个 :::accent、
 * 节点预算），手画 SVG 写没写十六进制颜色。花了多少用字符数近似（图源码的字符数、整段回复的字符数）——
 * 会话视图里的消息与事件流都不带 token 用量。每题一个新会话（技能是「本会话第一张图前加载」，
 * 混在一个会话里后面几题就不再加载），最后写一份 markdown 报告 + 转写，并给每张图卡截一张图。
 *
 * 这是调作图技能（`resources/skills/<lang>/drawing/`）分流规则的回路：改技能 → 跑探针 → 读报告。
 * 拿旧版技能做对照时，在一份 HEAD 的 git worktree 里构建并跑同一个文件（`PROBE_LABEL=old`）。
 *
 * key **只从 env 文件来**（`SHUVIX_PROBE_KIMI_KEY`，文件缺省 `~/.shuvix-probe.env`，`SHUVIX_PROBE_ENV_FILE`
 * 可改），不碰真实实例的数据库；key 只经 IPC 种进隔离实例，不打印、不落盘。
 *
 * 跑：`electron-vite build` 之后，在 apps/desktop 下
 *   `npx vitest run --config vitest.config.probe.ts e2e/live/drawing.probe.ts`
 * 环境变量：`SHUVIX_PROBE_KIMI_MODEL`（缺省 kimi-for-coding）、`PROBE_LANG`（界面语言，缺省 zh —
 * 技能按界面语言取那一版）、`PROBE_ONLY`（逗号分隔的题号，只跑这几题）、`PROBE_LABEL`（报告里的标签）、
 * `PROBE_OUT`（报告目录，缺省系统临时目录下的 shuvix-drawing-probe-<label>）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { detectType, load, render } from 'pele/lazy'
import { sleep, until } from '../harness/cdp'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  createProject,
  eventRecorder,
  installAutoAllow,
  waitRendererReady,
  type EventRecorder
} from '../harness/seed'
import { sidebarPane } from '../harness/pages'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'

type Carrier = 'svg' | 'mermaid' | 'interactive'

interface Task {
  id: string
  /** 题目该用的块（作图技能分流表的答案） */
  expect: Carrier
  prompt: string
}

const TASKS: Task[] = [
  {
    id: 'flow',
    expect: 'mermaid',
    prompt:
      '画一下我们的 CI 流水线：提交后跑 lint 和单测，失败就通知作者；通过后构建，构建失败重试一次，再失败就通知作者；构建成功部署到 staging，staging 冒烟测试通过再上生产。'
  },
  {
    id: 'sequence',
    expect: 'mermaid',
    prompt: '画一下 OAuth 授权码登录的过程：用户、浏览器、我们的应用、授权服务器之间是怎么来回的。'
  },
  {
    id: 'state',
    expect: 'mermaid',
    prompt:
      '订单有这些状态：待支付、已支付、已发货、已完成、已取消、退款中、已退款。它们之间怎么流转？画出来。'
  },
  {
    id: 'er',
    expect: 'mermaid',
    prompt: '博客系统的数据模型：用户、文章、评论、标签，文章和标签是多对多。画个图。'
  },
  {
    id: 'gantt',
    expect: 'mermaid',
    prompt:
      '两周的发布计划：设计 3 天，开发 6 天（设计完开始），测试 3 天，发布 1 天，从 2026-11-02 开始。画一下排期。'
  },
  {
    id: 'timeline',
    expect: 'mermaid',
    prompt:
      '画一下 AI 编程助手的发展时间线：2021 Copilot 预览，2022 ChatGPT 发布，2023 GPT-4 与 Cursor 流行，2024 Claude 3.5 Sonnet 与 agent 模式，2025 Claude Code。'
  },
  {
    id: 'layers',
    expect: 'svg',
    prompt:
      '用一张图说明我们的三层架构：界面层、服务层、数据层，各层里大概有什么，重点标出服务层是这次改动的地方。'
  },
  {
    id: 'before-after',
    expect: 'svg',
    prompt:
      '画个重构前后对比：原来三个服务（订单、库存、支付）各自直接连数据库，现在都经过一个数据访问层再到数据库。'
  },
  {
    id: 'chart',
    expect: 'svg',
    prompt:
      '这几个月的营收：1月 120 万，2月 135 万，3月 98 万，4月 160 万，5月 172 万。画个图看趋势。'
  },
  {
    id: 'magnitude',
    expect: 'svg',
    prompt: '画张图说明 CPU 缓存、内存、SSD、网络往返的访问延迟大概差几个数量级（大致数字就行）。'
  }
]

const ENV_FILE = process.env.SHUVIX_PROBE_ENV_FILE ?? join(homedir(), '.shuvix-probe.env')
const LABEL = process.env.PROBE_LABEL ?? 'current'
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), `shuvix-drawing-probe-${LABEL}`)
const LANG = process.env.PROBE_LANG ?? 'zh'
const ONLY = (process.env.PROBE_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

let app: E2EApp
let events: EventRecorder
let projectId = ''
let key = ''
let modelId = ''

const redact = (text: string): string => (key ? text.split(key).join('<redacted>') : text)

beforeAll(async () => {
  const env = collectProbeEnv(
    process.env,
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
  )
  key = env.SHUVIX_PROBE_KIMI_KEY ?? ''
  if (!key) throw new Error(`SHUVIX_PROBE_KIMI_KEY not found (env or ${ENV_FILE})`)
  modelId = env.SHUVIX_PROBE_KIMI_MODEL ?? 'kimi-for-coding'

  app = await launchApp()
  await waitRendererReady(app.main)
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
  )
  await seedRealModel(app.main, {
    providerId: 'kimi-coding',
    providerName: 'kimi',
    apiKey: key,
    apiProtocol: 'anthropic-messages',
    modelId
  })
  const workdir = mkdtempSync(join(tmpdir(), 'probe-draw-'))
  projectId = (await createProject(app.main, { name: 'ProbeDraw', path: workdir })).id
  events = eventRecorder(app.main)
  await events.install()
  await installAutoAllow(app.main)
  mkdirSync(OUT, { recursive: true })
}, 180_000)

afterAll(async () => {
  await app?.stop()
})

// ─── 读一轮的结果 ──────────────────────────────────────────────

interface Fence {
  carrier: string
  code: string
}

interface MermaidCheck {
  ok: boolean
  type?: string
  error?: string
  nodes?: number
  accTitle: boolean
  frontmatterTitle: boolean
  ownColors: boolean
  accents: number
  lines: number
}

interface SvgCheck {
  lines: number
  hex: boolean
  viewBox640: boolean
}

interface Row {
  task: Task
  loadedSkill: boolean
  readReferences: string[]
  fences: Fence[]
  /** 回复里所有图块源码的字符数 */
  figureChars: number
  /** 整段回复（不含工具调用）的字符数 */
  replyChars: number
  mermaid: MermaidCheck[]
  svg: SvgCheck[]
  match: boolean
  error?: string
}

const FENCE_RE = /```(svg|mermaid|interactive)\n([\s\S]*?)\n```/g

async function checkMermaid(code: string): Promise<MermaidCheck> {
  const base = {
    accTitle: /^\s*accTitle\s*:/m.test(code),
    frontmatterTitle: /^---\n[\s\S]*?^title\s*:/m.test(code),
    ownColors:
      /^\s*(style|linkStyle)\s/m.test(code) ||
      /^\s*classDef\s+\S+\s+.*(fill|stroke|color)\s*:/m.test(code) ||
      /%%\{/.test(code) ||
      /#[0-9a-f]{3,8}\b/i.test(code),
    accents: (code.match(/:::accent\b/g) ?? []).length,
    lines: code.split('\n').length
  }
  try {
    await load(detectType(code))
    const r = render(code, { links: false, images: false })
    return {
      ...base,
      ok: true,
      type: r.type,
      nodes: (r.svg.match(/class="pele-node[ "]/g) ?? []).length
    }
  } catch (e) {
    return { ...base, ok: false, error: String((e as Error).message).split('\n')[0] }
  }
}

const checkSvg = (code: string): SvgCheck => ({
  lines: code.split('\n').length,
  hex: /#[0-9a-f]{3,8}\b/i.test(code.replace(/url\(#[^)]*\)/g, '').replace(/href="#[^"]*"/g, '')),
  viewBox640: /viewBox="0 0 640 /.test(code)
})

interface DumpedMessage {
  role: string
  content?: string
  blocks?: Array<{ type: string; toolName?: string; args?: unknown; result?: unknown }>
}

async function runTask(task: Task): Promise<{ row: Row; transcript: string; sid: string }> {
  const title = `draw ${task.id}`
  const sid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )
  await app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(task.prompt)} })`
  )
  // 等这一轮真正落定：事件安静 8s（自动续跑会再起轮，单看一次 agent_end 不够）
  let last = -1
  let quietSince = Date.now()
  await until(
    async () => {
      const n = (await events.all()).length
      if (n !== last) {
        last = n
        quietSince = Date.now()
        return false
      }
      return Date.now() - quietSince > 8000
    },
    `${task.id} went quiet`,
    10 * 60 * 1000
  )
  const msgs = await app.main.eval<DumpedMessage[]>(
    `window.api.message.list(${JSON.stringify(sid)})`
  )
  const out: string[] = []
  let loadedSkill = false
  const readReferences: string[] = []
  let replyText = ''
  for (const m of msgs) {
    if (m.role === 'user') {
      out.push(`\n>>> USER:\n${m.content ?? ''}`)
      continue
    }
    if (m.role !== 'assistant') {
      out.push(`\n### ${m.role}: ${m.content ?? ''}`)
      continue
    }
    if (m.content?.trim()) {
      out.push(`\n<<< ASSISTANT:\n${m.content}`)
      replyText += `\n${m.content}`
    }
    for (const b of m.blocks ?? []) {
      if (b.type !== 'tool') continue
      const args = JSON.stringify(b.args ?? {})
      if (/skill/i.test(b.toolName ?? '') && args.includes('drawing')) loadedSkill = true
      const ref = /references\/([\w-]+\.md)/.exec(args)
      if (ref) readReferences.push(ref[1])
      const result = String(b.result ?? '')
      out.push(`\n  [TOOL] ${b.toolName} ${args}`)
      out.push(
        `  [RESULT] ${result.length > 400 ? `${result.slice(0, 400)}… (${result.length} chars)` : result}`
      )
    }
  }
  const fences = [...replyText.matchAll(FENCE_RE)].map((m) => ({ carrier: m[1], code: m[2] }))
  const mermaid = await Promise.all(
    fences.filter((f) => f.carrier === 'mermaid').map((f) => checkMermaid(f.code))
  )
  const svg = fences.filter((f) => f.carrier === 'svg').map((f) => checkSvg(f.code))
  const match = fences.length > 0 && fences.every((f) => f.carrier === task.expect)
  return {
    row: {
      task,
      loadedSkill,
      readReferences,
      fences,
      figureChars: fences.reduce((n, f) => n + f.code.length, 0),
      replyChars: replyText.trim().length,
      mermaid,
      svg,
      match
    },
    transcript: out.join('\n'),
    sid
  }
}

/** 打开那个会话，把它的每张图卡截下来（截不到不算失败） */
async function shoot(title: string, file: string): Promise<number> {
  try {
    const sidebar = sidebarPane(app.main)
    await sidebar.clickNewChat()
    await until(async () => (await sidebar.titles()).includes(title), `row ${title}`, 15_000)
    if (!(await sidebar.openSession(title))) return 0
    await sleep(2500)
    const rects = await app.main.eval<
      Array<{ x: number; y: number; width: number; height: number }>
    >(`(() => {
      const cards = [...document.querySelectorAll('[data-figure-surface="card"], .markdown-body .my-2.rounded-lg')]
        .filter((el, i, all) => all.findIndex((o) => o.contains(el) && o !== el) === -1)
      return cards.map((el) => {
        el.scrollIntoView({ block: 'start' })
        const r = el.getBoundingClientRect()
        return { x: r.left, y: Math.max(0, r.top), width: r.width, height: Math.min(r.height, innerHeight - Math.max(0, r.top)) }
      })
    })()`)
    let n = 0
    for (const [i, rect] of rects.entries()) {
      // 每张卡重新滚进视口再截（上面一次性算的矩形在滚动后已过期）
      const fresh = await app.main.eval<{
        x: number
        y: number
        width: number
        height: number
      } | null>(`(() => {
        const cards = [...document.querySelectorAll('[data-figure-surface="card"], .markdown-body .my-2.rounded-lg')]
          .filter((el, i, all) => all.findIndex((o) => o.contains(el) && o !== el) === -1)
        const el = cards[${i}]
        if (!el) return null
        el.scrollIntoView({ block: 'start' })
        const r = el.getBoundingClientRect()
        return { x: r.left, y: Math.max(0, r.top), width: r.width, height: Math.min(r.height, innerHeight - Math.max(0, r.top)) }
      })()`)
      const clip = fresh ?? rect
      if (clip.width < 10 || clip.height < 10) continue
      await sleep(300)
      const shot = await app.main.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        clip: { ...clip, scale: 1 }
      })
      writeFileSync(`${file}-${i}.png`, Buffer.from(shot.data, 'base64'))
      n++
    }
    return n
  } catch {
    return 0
  }
}

const cell = (v: unknown): string => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')

it('drawing carriers on a real model', async () => {
  const tasks = ONLY.length ? TASKS.filter((t) => ONLY.includes(t.id)) : TASKS
  const rows: Row[] = []
  const transcripts: string[] = []
  for (const task of tasks) {
    try {
      const { row, transcript } = await runTask(task)
      rows.push(row)
      transcripts.push(
        `\n${'='.repeat(78)}\n${task.id} (expect ${task.expect})\n${'='.repeat(78)}${transcript}`
      )
      await shoot(`draw ${task.id}`, join(OUT, task.id))
    } catch (e) {
      rows.push({
        task,
        loadedSkill: false,
        readReferences: [],
        fences: [],
        figureChars: 0,
        replyChars: 0,
        mermaid: [],
        svg: [],
        match: false,
        error: String((e as Error).message)
      })
    }
  }

  const lines: string[] = [
    `# Drawing probe — ${LABEL}`,
    '',
    `model: ${modelId} · language: ${LANG} · ${new Date().toISOString()}`,
    '',
    '| task | expect | got | match | skill | refs | figure chars | reply chars | mermaid | svg |',
    '|---|---|---|---|---|---|---|---|---|---|'
  ]
  for (const r of rows) {
    const got = r.fences.map((f) => f.carrier).join(', ') || (r.error ? 'ERROR' : '—')
    const mer = r.mermaid
      .map(
        (m) =>
          `${m.ok ? `ok ${m.type} ${m.nodes}n` : `FAIL ${m.error}`}${m.accTitle ? '' : ' no-accTitle'}${m.frontmatterTitle ? ' fm-title' : ''}${m.ownColors ? ' COLORS' : ''}${m.accents ? ` accent×${m.accents}` : ''}`
      )
      .join('; ')
    const svg = r.svg
      .map((s) => `${s.lines} lines${s.hex ? ' HEX' : ''}${s.viewBox640 ? '' : ' not-640'}`)
      .join('; ')
    lines.push(
      `| ${r.task.id} | ${r.task.expect} | ${cell(got)} | ${r.match ? '✓' : '✗'} | ${r.loadedSkill ? '✓' : '✗'} | ${cell(r.readReferences.join(' ') || '—')} | ${r.figureChars} | ${r.replyChars} | ${cell(mer || '—')} | ${cell(svg || '—')} |`
    )
  }
  const figures = rows.reduce((n, r) => n + r.figureChars, 0)
  const replies = rows.reduce((n, r) => n + r.replyChars, 0)
  lines.push(
    '',
    `matched ${rows.filter((r) => r.match).length}/${rows.length} · skill loaded ${rows.filter((r) => r.loadedSkill).length}/${rows.length} · figure chars ${figures} · reply chars ${replies}`
  )
  const report = join(OUT, 'report.md')
  writeFileSync(report, redact(lines.join('\n')))
  writeFileSync(join(OUT, 'transcripts.txt'), redact(transcripts.join('\n')))
  writeFileSync(join(OUT, 'rows.json'), redact(JSON.stringify(rows, null, 2)))
  console.log(`report: ${report}`)
})
