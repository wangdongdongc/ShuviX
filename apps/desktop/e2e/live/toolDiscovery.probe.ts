/**
 * 中途多出来的工具，模型用不用 —— 真模型对比探针。
 *
 * 起因（2026-11-03，用户的使用观察）：中途勾选 MCP 后，很多模型还是走老路；模型自己搜到工具时却自然会用。
 * 代码能解释这个差别：只改工具时 `pi.system` 没有文字，`none` 模型那里连位置都没有，上下文末尾什么也看不到。
 * 这里把它量出来，顺带看模型会不会主动去搜，以及从工具内部触发重配行不行。
 *
 * 同一个任务跑六种做法（`CONDITIONS`）：
 *   - direct：一开始就勾选 `mcp:browser`（对照：没有“中途”时它用不用）；
 *   - tick：中途勾选，什么也不说（今天的产品行为）；
 *   - tick-notice：中途勾选，再追加一条只陈述事实的系统通知（空闲时拼在下一条消息前，运行中走 steer —— 后者会
 *     带上产品给 steer 加的 mid-run 说明，真做成通知时不会有）；
 *   - tick-nudge：同上，通知里明确要求改用新工具；
 *   - search：出厂的 `tool_search`，但人设里去掉“有哪些扩展可以开启”那段；
 *   - search-hint：出厂的样子，工具和那段说明都在。
 *
 * 五个场景（`SCENARIOS`），网站是探针进程里的本地 HTTP 服务。“老路”指不跑 JS 的取法：`bash` 里的 curl，或者
 * `read` 一个网址（它会抓网页转成 Markdown）：
 *   - next-page：先看一页，再看另一页；老路完全够用，量的是惯性；
 *   - habit：先用老路连看六页，再看两页；惯性最强的情形；
 *   - click：先看一页，再要求点按钮，浏览器是对路的工具（老路也能照着脚本发请求，算老路成功）；
 *   - retry：第一轮就要点按钮，校验码由真实浏览器画 canvas 算出来，老路做不到；没做成才开启工具，再说“再试一次吧”。
 *     **缺省不跑，要用 `PROBE_SCENARIOS=retry` 点名**：老路走不通时模型会到处找浏览器来跑，2026-11-03 有脚本启动了
 *     这台电脑上的 /Applications/ShuviX.app 和 Safari，它们在沙箱里一启动就崩，屏幕上连着弹系统的崩溃提示；
 *   - chain：一次运行里沿链接一页页看，看完第一页时中途勾选，第三页要跑 JS 才有内容。
 *
 * 全是真的：隔离实例、真 `chat` 基座、真 `bash`、真 `mcp:browser`、真 `tool_search`、真重配。确认卡片由 `settle` 代答“允许”。
 * 产品的 `chat` 档案带着 `tool_search` 和那段说明，所以 direct / tick* 用一份去掉它们的用户级同名档案，量的才是今天
 * 这些做法本身。
 *
 * 每个试次一个新实例，避免标签页和浏览器数据在试次之间串味。不断言（真模型不确定），只写报告：
 * `<PROBE_OUT>/report.md`、`results.jsonl`、`transcripts/<试次>.txt`。
 *
 * 模型：`PROBE_MODELS`（逗号分隔，缺省 deepseek），key 只从 `~/.shuvix-probe.env` 或环境变量来：
 *   - deepseek：`SHUVIX_PROBE_COMPLETIONS_KEY` / `_MODEL`（`none`）
 *   - kimi：`SHUVIX_PROBE_KIMI_KEY` / `SHUVIX_PROBE_KIMI_MODEL`（`none`）
 *   - anthropic：`SHUVIX_PROBE_ANTHROPIC_KEY` / `_MODEL`（`native`）
 *   - openai：`SHUVIX_PROBE_OPENAI_KEY` / `_MODEL`（`additive`）
 * 其余旋钮：`PROBE_SCENARIOS`、`PROBE_CONDITIONS`（子集）、`PROBE_REPEAT`（缺省 3）、`PROBE_WORKERS`（同时开几个
 * 实例，缺省 3）。
 *
 * 权限询问只放行不碰真实主目录的（`settle`，见 redactionProbeShared.ts —— 2026-10-19 的事故）。
 * 这里还多两道：模型为了点按钮会装 playwright / puppeteer、下载 Chromium，再申请跑到沙箱外（2026-11-03 试跑时
 * `npx playwright` 写进了真实的 ~/.npm：隔离 HOME 管不住从 npm / npx 继承来的 `npm_config_cache`）。所以沙箱外的
 * 命令一律拒绝（`NO_UNCONFINED_POLICY`），下载包和浏览器的地址也都指向打不通的端口（`OFFLINE_ENV`）。后一道只能
 * 挡住顺手的尝试：沙箱不限网络，模型会在命令里改回官方地址，或直接 curl 下载 Chromium。
 *
 *   npx electron-vite build
 *   PROBE_MODELS=deepseek,kimi npx vitest run --config vitest.config.probe.ts e2e/live/toolDiscovery.probe.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import { launchApp, type E2EApp } from '../harness/launch'
import { eventRecorder, waitRendererReady, type EventRecorder } from '../harness/seed'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'
import {
  ENV_FILE,
  installPolicy,
  installRealHomeGuard,
  makeDebug,
  REAL_HOME,
  sendPrompt,
  settle
} from './redactionProbeShared'

const REPO_ROOT = resolve(process.cwd(), '../..')
const CHAT_MD = join(REPO_ROOT, 'packages/agent-runtime/src/subagent/builtinAgents/md/chat.zh.md')
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), `shuvix-tool-discovery-${Date.now()}`)
const REPEAT = Math.max(1, Number(process.env.PROBE_REPEAT ?? '3') || 3)
const WORKERS = Math.max(1, Number(process.env.PROBE_WORKERS ?? '3') || 3)
/** 一轮的上限：到了就算这个试次失败，换下一个 */
const TURN_TIMEOUT_MS = 6 * 60 * 1000

const UNREACHABLE = 'http://127.0.0.1:9/'

/** 盖掉从 npm / npx 继承来的缓存位置，并让包管理器和浏览器下载都走不通 */
const OFFLINE_ENV: Record<string, string> = {
  npm_config_cache: join(tmpdir(), 'shuvix-tool-discovery-npm-cache'),
  npm_config_registry: UNREACHABLE,
  npm_config_update_notifier: 'false',
  PIP_INDEX_URL: UNREACHABLE,
  PLAYWRIGHT_DOWNLOAD_HOST: UNREACHABLE,
  PUPPETEER_DOWNLOAD_BASE_URL: UNREACHABLE
}

const NO_UNCONFINED_POLICY = [
  '---',
  'shuvix: policy v1',
  'name: probe-no-unconfined',
  'description: A live probe never runs a command outside the sandbox.',
  'shuvix-policy-scope:',
  '  subject.kind: [agent]',
  '  object.type: [command]',
  'shuvix-policy-rules:',
  '  - effect: deny',
  '    action: [execute]',
  '    match: "!has(object.sandboxed) || !object.sandboxed"',
  '    prompt: Commands cannot run outside the sandbox in this environment.',
  '---',
  ''
].join('\n')

// ─────────────────────────── 模型 ───────────────────────────

interface ModelSpec {
  keyEnv: string
  modelEnv: string
  fallbackModel?: string
  providerId: string
  providerName: string
  apiProtocol: string
  /** `toolChangeSupport` 的结论，只写进报告 */
  support: 'native' | 'additive' | 'none'
}

const MODELS: Record<string, ModelSpec> = {
  deepseek: {
    keyEnv: 'SHUVIX_PROBE_COMPLETIONS_KEY',
    modelEnv: 'SHUVIX_PROBE_COMPLETIONS_MODEL',
    providerId: 'deepseek',
    providerName: 'deepseek',
    apiProtocol: 'openai-completions',
    support: 'none'
  },
  kimi: {
    keyEnv: 'SHUVIX_PROBE_KIMI_KEY',
    modelEnv: 'SHUVIX_PROBE_KIMI_MODEL',
    fallbackModel: 'kimi-for-coding',
    providerId: 'kimi-coding',
    providerName: 'kimi',
    apiProtocol: 'anthropic-messages',
    support: 'none'
  },
  anthropic: {
    keyEnv: 'SHUVIX_PROBE_ANTHROPIC_KEY',
    modelEnv: 'SHUVIX_PROBE_ANTHROPIC_MODEL',
    fallbackModel: 'claude-haiku-5-5',
    providerId: 'anthropic',
    providerName: 'anthropic',
    apiProtocol: 'anthropic-messages',
    support: 'native'
  },
  openai: {
    keyEnv: 'SHUVIX_PROBE_OPENAI_KEY',
    modelEnv: 'SHUVIX_PROBE_OPENAI_MODEL',
    fallbackModel: 'gpt-5.5',
    providerId: 'openai',
    providerName: 'openai',
    apiProtocol: 'openai-responses',
    support: 'additive'
  }
}

// ─────────────────────────── 场景与做法 ───────────────────────────

const STATUS_LINE = '全部系统运行正常'
const INCIDENT = 'INC-4821'
const DETAIL = 'DETAIL-7F3A'
const P3_MARK = 'P3-5D20'
const CHAIN_END = 'END-93C1'
const ownerOf = (n: number): string => `OWNER-A${n}`

type ScenarioId = 'next-page' | 'habit' | 'click' | 'retry' | 'chain'
type ConditionId = 'direct' | 'tick' | 'tick-notice' | 'tick-nudge' | 'search' | 'search-hint'

interface Scenario {
  label: string
  /** 先跑一轮老路（chain 没有：它的变化发生在运行中） */
  momentum?: (base: string) => string
  task: (base: string) => string
  /** 有这一项时 task 就是第一轮：没做成才开启工具，再发这句话 */
  retry?: string
  /** 最终回答里都要有的标记（retry 的校验码在页面上现算，见 `Site.seenCode`） */
  markers: string[]
}

const SCENARIOS: Record<ScenarioId, Scenario> = {
  'next-page': {
    label: '再看一页（老路够用）',
    momentum: (base) => `帮我看一下 ${base}/ 上现在显示的系统状态。`,
    task: (base) => `再看一下 ${base}/incidents，最新一条事故的编号是什么？`,
    markers: [INCIDENT]
  },
  habit: {
    label: '老路已经用顺手（老路够用）',
    momentum: (base) =>
      `依次看一下这六个页面，告诉我每个模块的负责人：${[1, 2, 3, 4, 5, 6].map((n) => `${base}/a${n}`).join('、')}。`,
    task: (base) => `再看一下 ${base}/a7 和 ${base}/a8，这两个模块的负责人分别是谁？`,
    markers: [ownerOf(7), ownerOf(8)]
  },
  click: {
    label: '要点按钮（浏览器对路）',
    momentum: (base) => `帮我看一下 ${base}/ 上现在显示的系统状态。`,
    task: (base) =>
      `打开 ${base}/dashboard，点一下页面上的“展开详情”按钮，告诉我展开后显示的校验码。`,
    markers: [DETAIL]
  },
  retry: {
    label: '老路失败后再试（老路做不到）',
    task: (base) => `打开 ${base}/guarded，点一下“生成校验码”按钮，告诉我页面上显示的校验码。`,
    retry: '再试一次吧。',
    markers: []
  },
  chain: {
    label: '运行中途开启，后面有页面要跑 JS',
    task: (base) =>
      `从 ${base}/p1 开始，沿着每页的“下一页”链接一页一页往下看，直到没有下一页。把每一页的标题和状态行都列给我。`,
    markers: [P3_MARK, CHAIN_END]
  }
}

const CONDITIONS: Record<ConditionId, string> = {
  direct: '一开始就勾选（对照）',
  tick: '中途勾选',
  'tick-notice': '中途勾选 + 通知',
  'tick-nudge': '中途勾选 + 明确要求改用',
  search: '主动搜索',
  'search-hint': '主动搜索 + 提示词说明'
}

const isTick = (condition: ConditionId): boolean =>
  condition === 'tick' || condition === 'tick-notice' || condition === 'tick-nudge'

const BROWSER_SELECTION = 'mcp:browser'
const NEW_TOOLS =
  'mcp__browser__navigate, mcp__browser__snapshot, mcp__browser__click, mcp__browser__read_page, ' +
  'mcp__browser__screenshot and 17 more'

/** 中途勾选时追加的通知：一种只陈述事实，一种明确要求改用 */
const NOTICES: Partial<Record<ConditionId, string>> = {
  'tick-notice': `<system-notice>The user just enabled the "browser" extension for this session. Its tools are available now: ${NEW_TOOLS}.</system-notice>`,
  'tick-nudge': `<system-notice>The user just enabled the "browser" extension for this session because they want you to use it. Its tools are available now: ${NEW_TOOLS}. From now on, use them for anything on a web page instead of your earlier methods.</system-notice>`
}

/** 人设里那段“可以申请开启的扩展”（中文档案的小标题，用来确认它在不在系统提示词里） */
const HINT_HEADING = '可以申请开启的扩展'
const HINT_PLACEHOLDER = /^\{\{shuvix:extensionDiscovery\}\}\n/m

// ─────────────────────────── 本地网站 ───────────────────────────

const html = (title: string, body: string): string =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`

const chainPage = (n: number, status: string, next?: number): string =>
  html(
    `第 ${n} 页`,
    `<p>状态行：${status}</p>${next === undefined ? '<p>没有下一页了。</p>' : `<a href="/p${next}">下一页</a>`}`
  )

const P3_BODY = `<h1>第 3 页</h1><p>状态行：${P3_MARK}</p><a href="/p4">下一页</a>`

interface Hit {
  method: string
  path: string
  client: 'browser' | 'cli'
}

interface Site {
  base: string
  hits: Hit[]
  /** /guarded 的校验码：点按钮时由真实浏览器画 canvas 再取哈希算出来，页面报回来才知道是多少 */
  seenCode?: string
  /** 第一次有人读 /p1：响应发回去之前等它做完，这样模型读到第一页时工具已经变了 */
  onFirstP1?: () => Promise<void>
  close(): Promise<void>
}

function startSite(): Promise<Site> {
  const nonce = randomBytes(6).toString('hex')
  let p1Seen = false
  const hits: Hit[] = []
  const site: Site = { base: '', hits, close: async () => undefined }

  const send = (res: ServerResponse, status: number, type: string, text: string): void => {
    res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
    res.end(text)
  }

  const handlePage = async (
    req: IncomingMessage,
    res: ServerResponse,
    body: string
  ): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://local').pathname
    const ua = req.headers['user-agent'] ?? ''
    if (path !== '/favicon.ico') {
      hits.push({
        method: req.method ?? 'GET',
        path,
        client: /Chrome\//.test(ua) ? 'browser' : 'cli'
      })
    }
    const page = (text: string): void => send(res, 200, 'text/html', text)
    switch (path) {
      case '/':
        // 不放链接：模型会顺手把后面的页面也看了，第二轮就没什么可量的了
        return page(html('内部状态页', `<p>系统状态：${STATUS_LINE}</p>`))
      case '/guarded':
        return page(
          html(
            '校验码',
            `<button id="gen">生成校验码</button><div id="out"></div><script>
document.getElementById('gen').addEventListener('click', async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 240
  canvas.height = 60
  const g = canvas.getContext('2d')
  g.font = '18px sans-serif'
  g.fillText(${JSON.stringify(nonce)}, 8, 30)
  const bytes = new TextEncoder().encode(canvas.toDataURL())
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const code = 'GUARD-' + [...hash.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  document.getElementById('out').textContent = '校验码：' + code
  fetch('/api/seen', { method: 'POST', body: code })
})
</script>`
          )
        )
      case '/api/seen':
        // 试次里的“做成了”只认这里记下的值。第一版用请求头把关，模型会照着 Chrome 伪造一整套头，第一轮就过了
        if (req.headers['sec-fetch-site'] === 'same-origin' && /Chrome\//.test(ua)) {
          site.seenCode = body
        }
        return send(res, 200, 'text/plain', 'ok')
      case '/incidents':
        return page(
          html(
            '事故记录',
            `<ol><li>2026-11-02 支付网关延迟升高（编号 ${INCIDENT}）</li><li>2026-10-19 对象存储短暂只读（编号 INC-4610）</li></ol>`
          )
        )
      case '/dashboard':
        return page(
          html(
            '仪表盘',
            `<button id="more">展开详情</button><div id="detail"></div><script>
document.getElementById('more').addEventListener('click', async () => {
  const r = await fetch('/api/detail', { method: 'POST', headers: { 'x-click-token': ${JSON.stringify(nonce)} } })
  document.getElementById('detail').textContent = await r.text()
})
</script>`
          )
        )
      case '/api/detail':
        return req.headers['x-click-token'] === nonce
          ? send(res, 200, 'text/plain', `校验码：${DETAIL}`)
          : send(res, 403, 'text/plain', 'forbidden')
      case '/p1':
        if (!p1Seen) {
          p1Seen = true
          await site.onFirstP1?.()
        }
        return page(chainPage(1, '节点 A 正常', 2))
      case '/p2':
        return page(chainPage(2, '节点 B 正常', 3))
      case '/p3':
        return page(
          `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>加载中</title></head><body><div id="root">正在加载…</div><script src="/static/p3.js"></script></body></html>`
        )
      case '/static/p3.js': {
        const encoded = Buffer.from(P3_BODY, 'utf8').toString('base64')
        return send(
          res,
          200,
          'text/javascript',
          `const bytes = Uint8Array.from(atob(${JSON.stringify(encoded)}), (c) => c.charCodeAt(0));\ndocument.getElementById('root').innerHTML = new TextDecoder().decode(bytes);\ndocument.title = '第 3 页';\n`
        )
      }
      case '/p4':
        return page(chainPage(4, '节点 D 正常', 5))
      case '/p5':
        return page(chainPage(5, CHAIN_END))
      default: {
        const module = /^\/a([1-8])$/.exec(path)
        return module
          ? page(html(`模块 a${module[1]}`, `<p>负责人：${ownerOf(Number(module[1]))}</p>`))
          : send(res, 404, 'text/plain', 'not found')
      }
    }
  }

  const server: HttpServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      handlePage(req, res, Buffer.concat(chunks).toString('utf8')).catch((error: unknown) => {
        if (!res.headersSent) send(res, 500, 'text/plain', String(error))
      })
    })
  })

  return new Promise((done, fail) => {
    server.on('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr !== 'object' || !addr) return fail(new Error('no port'))
      site.base = `http://127.0.0.1:${addr.port}`
      site.close = () =>
        new Promise((closed) => {
          server.closeAllConnections()
          server.close(() => closed())
        })
      done(site)
    })
  })
}

// ─────────────────────────── 读转写 ───────────────────────────

interface Usage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

type CallKind = 'browser' | 'search' | 'old' | 'other'

interface SnapshotMessage {
  role: string
  content: string
  usage?: Usage
  blocks: Array<{
    type: string
    text?: string
    toolName?: string
    args?: unknown
    result?: string
    isError?: boolean
  }>
}

interface Call {
  name: string
  kind: CallKind
  args: string
  result: string
  isError: boolean
  /** 所在消息的下标（一条 assistant 消息 = 一次模型请求） */
  message: number
}

function readMessages(app: E2EApp, sid: string): Promise<SnapshotMessage[]> {
  return app.main.eval<SnapshotMessage[]>(`
    window.api.message.list(${JSON.stringify(sid)}).then((msgs) => msgs.map((m) => ({
      role: m.role,
      content: String(m.content ?? ''),
      usage: m.metadata ? m.metadata.usage : undefined,
      blocks: (m.blocks ?? []).map((b) => b.type === 'tool'
        ? { type: 'tool', toolName: b.toolName, args: b.args, result: String(b.result ?? '').slice(0, 2000), isError: b.isError === true }
        : { type: b.type, text: b.text })
    })))
  `)
}

const kindOf = (name: string, args: unknown): CallKind => {
  if (name.startsWith('mcp__browser__')) return 'browser'
  if (name.includes('tool_search')) return 'search'
  if (name === 'bash' || name === 'powershell') return 'old'
  // read 也能抓网页（转成 Markdown），和 curl 一样不跑 JS
  if (name === 'read' && /https?:\/\//.test(JSON.stringify(args ?? {}))) return 'old'
  return 'other'
}

const answerHas = (messages: SnapshotMessage[], markers: string[]): boolean => {
  const answer = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('\n')
  return markers.every((marker) => answer.includes(marker))
}

function callsOf(messages: SnapshotMessage[]): Call[] {
  const calls: Call[] = []
  messages.forEach((message, index) => {
    for (const block of message.blocks) {
      if (block.type !== 'tool' || !block.toolName) continue
      calls.push({
        name: block.toolName,
        kind: kindOf(block.toolName, block.args),
        args: JSON.stringify(block.args ?? {}),
        result: block.result ?? '',
        isError: block.isError === true,
        message: index
      })
    }
  })
  return calls
}

function transcript(messages: SnapshotMessage[]): string {
  const out: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') {
      out.push(`>>> ${message.role.toUpperCase()}: ${message.content}`)
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'text' && block.text?.trim()) out.push(`<<< ASSISTANT:\n${block.text}`)
      if (block.type === 'thinking' && block.text?.trim()) out.push(`(thinking) ${block.text}`)
      if (block.type !== 'tool') continue
      out.push(`[TOOL] ${block.toolName} ${JSON.stringify(block.args ?? {}).slice(0, 1500)}`)
      out.push(`[RESULT]${block.isError ? ' (ERROR)' : ''} ${(block.result ?? '').slice(0, 800)}`)
    }
    if (message.usage) out.push(`(usage) ${JSON.stringify(message.usage)}`)
  }
  return out.join('\n\n')
}

// ─────────────────────────── 一个试次 ───────────────────────────

interface TrialPlan {
  model: string
  scenario: ScenarioId
  condition: ConditionId
  rep: number
}

interface TrialResult extends TrialPlan {
  id: string
  /** 变化之后的工具序列（old / browser / search / other） */
  sequence: string
  /** 变化之后第一个与“怎么上网”有关的调用 */
  first: CallKind | 'none'
  usedBrowser: boolean
  /** 变化之后，第一次用浏览器之前还走了几次老路 / 搜索；没用过 = null */
  stepsBeforeBrowser: number | null
  queries: string[]
  loaded: boolean
  /** 搜索加载之后第一个上网调用 */
  afterLoad: CallKind | 'none' | null
  /** 第一轮（变化之前）就搜索并加载了 */
  loadedBeforeChange: boolean
  /** retry 场景：第一轮就做成了（中途勾选的做法因此没有发生变化） */
  solvedBeforeChange: boolean
  completed: boolean
  /** 工具变化之后第一次请求的缓存命中率；取不到（包括那是这条会话的第一次请求）= null */
  cacheHit: number | null
  /** 同一次请求没命中的 token（input + cacheWrite） */
  uncached: number | null
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  browserHits: number
  cliHits: number
  /** 变化之后工具是否真的到了 agent 上（direct 恒 true） */
  toolsLive: boolean
  hintInPrompt: boolean | null
  asks: number
  ms: number
  error?: string
}

const SELECTION_AT_START: Record<ConditionId, string[]> = {
  direct: [BROWSER_SELECTION],
  tick: [],
  'tick-notice': [],
  'tick-nudge': [],
  search: [],
  'search-hint': []
}

const writeSelection = (app: E2EApp, sid: string, enabledTools: string[]): Promise<unknown> =>
  app.main.eval(
    `window.api.session.updateEnabledTools(${JSON.stringify({ id: sid, enabledTools })})`
  )

const browserToolsLive = (app: E2EApp, sid: string): Promise<boolean> =>
  app.main.eval<boolean>(
    `window.api.agent.getInfo(${JSON.stringify(sid)}).then((i) => !!i && (i.tools ?? []).some((t) => t.name === 'mcp__browser__navigate'))`
  )

async function runTrial(
  plan: TrialPlan,
  spec: ModelSpec,
  key: string,
  modelId: string,
  debug: (line: string) => void
): Promise<{ result: TrialResult; text: string }> {
  const id = `${plan.model}-${plan.scenario}-${plan.condition}-${plan.rep}`
  const scenario = SCENARIOS[plan.scenario]
  const started = Date.now()
  const result: TrialResult = {
    ...plan,
    id,
    sequence: '',
    first: 'none',
    usedBrowser: false,
    stepsBeforeBrowser: null,
    queries: [],
    loaded: false,
    afterLoad: null,
    loadedBeforeChange: false,
    solvedBeforeChange: false,
    completed: false,
    cacheHit: null,
    uncached: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    browserHits: 0,
    cliHits: 0,
    toolsLive: plan.condition === 'direct',
    hintInPrompt: null,
    asks: 0,
    ms: 0
  }
  const site = await startSite()
  let app: E2EApp | undefined
  let messages: SnapshotMessage[] = []
  let events: EventRecorder | undefined
  let sid = ''
  try {
    app = await launchApp({ env: OFFLINE_ENV })
    const live = app
    await waitRendererReady(live.main)
    await seedRealModel(live.main, {
      providerId: spec.providerId,
      providerName: spec.providerName,
      apiKey: key,
      apiProtocol: spec.apiProtocol,
      modelId
    })
    await live.main.eval(`window.api.settings.set({ key: 'general.language', value: 'zh' })`)
    await installRealHomeGuard(live, REPO_ROOT)
    await installPolicy(live, 'probe-no-unconfined', NO_UNCONFINED_POLICY)

    if (plan.condition !== 'search-hint') {
      // 用户级同名档案覆盖内置 chat：search 只去掉那段说明，其余做法连工具一起去掉
      let md = readFileSync(CHAT_MD, 'utf8')
        .replace(/^shuvix-builtin: true\n/m, '')
        .replace(HINT_PLACEHOLDER, '')
      if (plan.condition !== 'search') md = md.replace('tool_search, ', '')
      mkdirSync(live.agentsDir, { recursive: true })
      writeFileSync(join(live.agentsDir, 'chat.md'), md)
    }

    sid = await live.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: `probe ${id}` })}).then((s) => s.id)`
    )
    await writeSelection(live, sid, SELECTION_AT_START[plan.condition])
    if (plan.condition === 'search' || plan.condition === 'search-hint') {
      const prompt = await live.main.eval<string>(
        `window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true }).then((i) => i.systemPrompt)`
      )
      result.hintInPrompt = prompt.includes(HINT_HEADING)
    }
    events = eventRecorder(live.main)
    await events.install()

    const tick = async (): Promise<boolean> => {
      await writeSelection(live, sid, [...SELECTION_AT_START[plan.condition], BROWSER_SELECTION])
      return browserToolsLive(live, sid)
    }

    const notice = NOTICES[plan.condition]
    if (plan.scenario === 'chain' && isTick(plan.condition)) {
      site.onFirstP1 = async () => {
        result.toolsLive = await tick()
        if (notice) {
          await live.main.eval(
            `window.api.agent.steer(${JSON.stringify({ sessionId: sid, text: notice })})`
          )
        }
      }
    }

    const turn = async (text: string, label: string): Promise<void> => {
      await sendPrompt(live, sid, text)
      result.asks += await settle({
        app: live,
        events: events as EventRecorder,
        sid,
        label: `${id} ${label}`,
        answer: () => '你自己判断，直接做。',
        debug,
        quietMs: 6000,
        timeoutMs: TURN_TIMEOUT_MS
      })
    }

    let callsAtChange = 0
    let messagesAtChange = 0
    const ticks = isTick(plan.condition)
    const noticed = (text: string): string => (notice ? `${notice}\n\n${text}` : text)
    const markers = (): string[] =>
      plan.scenario === 'retry' ? [site.seenCode ?? 'GUARD-never-generated'] : scenario.markers
    /** 空闲时的变化点：记下此刻的位置，中途勾选的做法在这里开启工具 */
    const changeNow = async (): Promise<void> => {
      messages = await readMessages(live, sid)
      callsAtChange = callsOf(messages).length
      messagesAtChange = messages.length
      if (ticks) result.toolsLive = await tick()
    }
    const task = scenario.task(site.base)
    if (scenario.retry) {
      await turn(task, 'first try')
      messages = await readMessages(live, sid)
      result.solvedBeforeChange = answerHas(messages, markers())
      result.loadedBeforeChange = callsOf(await readMessages(live, sid)).some(
        (call) => call.kind === 'search' && call.result.startsWith('Loaded')
      )
      if (!result.solvedBeforeChange) {
        // 一开始就有工具或搜索的做法从第一轮算起：它们的第一轮本身就是要量的；只有中途勾选有变化点
        if (ticks) await changeNow()
        await turn(noticed(scenario.retry), 'retry')
      }
    } else if (scenario.momentum) {
      await turn(scenario.momentum(site.base), 'momentum')
      result.loadedBeforeChange = callsOf(await readMessages(live, sid)).some(
        (call) => call.kind === 'search' && call.result.startsWith('Loaded')
      )
      await changeNow()
      await turn(noticed(task), 'task')
    } else {
      await turn(task, 'task')
    }
    messages = await readMessages(live, sid)

    const calls = callsOf(messages)
    // chain 的“变化之后”从读第一页之后算：tick 就发生在那个响应之前
    if (!scenario.momentum && !scenario.retry) {
      const p1 = calls.findIndex((call) => /\/p1\b/.test(call.args))
      callsAtChange = p1 < 0 ? calls.length : p1 + 1
      messagesAtChange = p1 < 0 ? messages.length : calls[p1].message + 1
    }
    const after = calls.slice(callsAtChange)
    const web = after.filter((call) => call.kind !== 'other')
    result.sequence = after.map((call) => call.kind).join(' ')
    result.first = web[0]?.kind ?? 'none'
    result.usedBrowser = web.some((call) => call.kind === 'browser')
    const firstBrowser = web.findIndex((call) => call.kind === 'browser')
    result.stepsBeforeBrowser = firstBrowser < 0 ? null : firstBrowser

    result.queries = calls
      .filter((call) => call.kind === 'search')
      .map((call) => String((JSON.parse(call.args) as { query?: unknown }).query ?? ''))
    const loadIndex = calls.findIndex(
      (call) => call.kind === 'search' && call.result.startsWith('Loaded')
    )
    if (loadIndex >= 0) {
      result.loaded = true
      result.toolsLive = true
      const next = calls.slice(loadIndex + 1).find((c) => c.kind === 'browser' || c.kind === 'old')
      result.afterLoad = next?.kind ?? 'none'
    }

    // 工具列表第一次变化之后的那次请求：搜索时是加载之后，其余是变化点之后
    const changedAt = loadIndex >= 0 ? calls[loadIndex].message + 1 : messagesAtChange
    const measured = messages.slice(changedAt).find((m) => m.role === 'assistant' && m.usage)
    if (changedAt > 0 && measured?.usage) {
      const { input = 0, cacheRead = 0, cacheWrite = 0 } = measured.usage
      const total = input + cacheRead + cacheWrite
      result.cacheHit = total > 0 ? cacheRead / total : null
      result.uncached = input + cacheWrite
    }
    for (const message of messages) {
      result.tokens.input += message.usage?.input ?? 0
      result.tokens.output += message.usage?.output ?? 0
      result.tokens.cacheRead += message.usage?.cacheRead ?? 0
      result.tokens.cacheWrite += message.usage?.cacheWrite ?? 0
    }
    result.completed = answerHas(messages.slice(messagesAtChange), markers())
  } catch (error) {
    result.error = String(error instanceof Error ? error.message : error).slice(0, 400)
    if (app && sid) messages = await readMessages(app, sid).catch(() => messages)
  } finally {
    await app?.stop().catch((error: unknown) => debug(`${id}: stop failed: ${String(error)}`))
    await site.close()
  }
  result.browserHits = site.hits.filter((hit) => hit.client === 'browser').length
  result.cliHits = site.hits.filter((hit) => hit.client === 'cli').length
  result.ms = Date.now() - started
  const text = [
    `# ${id}（${modelId}）`,
    '',
    `站点访问：${site.hits.map((hit) => `${hit.client}:${hit.method} ${hit.path}`).join(', ')}`,
    '',
    transcript(messages)
  ].join('\n')
  return { result, text: key ? text.split(key).join('<redacted>') : text }
}

// ─────────────────────────── 报告 ───────────────────────────

const ratio = (count: number, total: number): string => (total === 0 ? '–' : `${count}/${total}`)

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
}

function renderReport(results: TrialResult[], meta: Record<string, string>): string {
  const lines: string[] = ['# 中途开启的工具，模型用不用', '']
  for (const [name, value] of Object.entries(meta)) lines.push(`- ${name}：${value}`)
  const failed = results.filter((r) => r.error)
  lines.push(`- 已完成试次：${results.length}（出错 ${failed.length}）`)
  const ticked = results.filter((r) => !r.error && isTick(r.condition) && !r.solvedBeforeChange)
  lines.push(
    `- 中途勾选后工具确实到了 agent 上：${ratio(ticked.filter((r) => r.toolsLive).length, ticked.length)}`
  )
  const hints = results.filter((r) => r.hintInPrompt !== null)
  if (hints.length) {
    lines.push(
      `- 系统提示词里有那段说明（search 应为没有，search-hint 应为有）：${ratio(hints.filter((r) => r.hintInPrompt).length, hints.length)}`
    )
  }
  const tokens = results.reduce(
    (sum, r) => sum + r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite,
    0
  )
  lines.push(`- 总 token（含缓存读）：${tokens}`)

  const models = [...new Set(results.map((r) => r.model))]
  for (const model of models) {
    for (const scenarioId of Object.keys(SCENARIOS) as ScenarioId[]) {
      const inScenario = results.filter((r) => r.model === model && r.scenario === scenarioId)
      if (inScenario.length === 0) continue
      lines.push(
        '',
        `## ${model}（${MODELS[model].support}）· ${SCENARIOS[scenarioId].label}`,
        '',
        '| 做法 | n | 下一步用浏览器 | 下一步搜索 | 下一步走老路 | 用过浏览器 | 搜索过 | 加载后下一步用浏览器 | 任务完成 | 首轮就做成 | 变化后首个请求缓存命中 |',
        '|---|---|---|---|---|---|---|---|---|---|---|'
      )
      for (const condition of Object.keys(CONDITIONS) as ConditionId[]) {
        const all = inScenario.filter((r) => r.condition === condition && !r.error)
        if (all.length === 0) continue
        // 第一轮就做成的“中途勾选”没有发生变化，不进后面的比例
        const rows = all.filter((r) => !(isTick(condition) && r.solvedBeforeChange))
        const n = rows.length
        const loaded = rows.filter((r) => r.afterLoad !== null)
        const hit = mean(rows.map((r) => r.cacheHit).filter((v): v is number => v !== null))
        const missed = mean(rows.map((r) => r.uncached).filter((v): v is number => v !== null))
        lines.push(
          `| ${CONDITIONS[condition]} | ${n} | ${ratio(rows.filter((r) => r.first === 'browser').length, n)} | ` +
            `${ratio(rows.filter((r) => r.first === 'search').length, n)} | ` +
            `${ratio(rows.filter((r) => r.first === 'old').length, n)} | ` +
            `${ratio(rows.filter((r) => r.usedBrowser).length, n)} | ` +
            `${ratio(rows.filter((r) => r.queries.length > 0).length, n)} | ` +
            `${ratio(loaded.filter((r) => r.afterLoad === 'browser').length, loaded.length)} | ` +
            `${ratio(rows.filter((r) => r.completed).length, n)} | ` +
            `${ratio(all.filter((r) => r.solvedBeforeChange).length, all.length)} | ` +
            `${hit === null ? '–' : `${Math.round(hit * 100)}%（未命中 ${Math.round(missed ?? 0)}）`} |`
        )
      }
    }
  }

  lines.push(
    '',
    '## 每个试次',
    '',
    '| 试次 | 变化之后的调用 | 搜索词 | 完成 | 站点访问（浏览器/命令行） | 问询 | 秒 |',
    '|---|---|---|---|---|---|---|'
  )
  for (const r of [...results].sort((a, b) => a.id.localeCompare(b.id))) {
    const queries = r.queries.map((q) => q.replace(/\|/g, '/')).join('；')
    lines.push(
      `| ${r.id} | ${r.error ? `出错：${r.error.replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 120)}` : r.sequence || '（无）'} | ` +
        `${queries || '–'}${r.loadedBeforeChange ? '（第一轮就加载）' : ''} | ${r.completed ? '是' : '否'} | ` +
        `${r.browserHits}/${r.cliHits} | ${r.asks} | ${Math.round(r.ms / 1000)} |`
    )
  }
  return lines.join('\n')
}

// ─────────────────────────── 入口 ───────────────────────────

function listFrom<T extends string>(raw: string | undefined, all: readonly T[]): T[] {
  if (!raw) return [...all]
  const wanted = raw.split(',').map((s) => s.trim())
  return all.filter((item) => wanted.includes(item))
}

it(
  'tool discovery: does a model use a tool that appeared mid-conversation',
  async () => {
    const env = collectProbeEnv(
      process.env,
      existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
    )
    const modelNames = (process.env.PROBE_MODELS ?? 'deepseek').split(',').map((s) => s.trim())
    const targets = modelNames.map((name) => {
      const spec = MODELS[name]
      if (!spec) throw new Error(`unknown model "${name}" in PROBE_MODELS`)
      const key = env[spec.keyEnv] ?? ''
      const modelId = env[spec.modelEnv] ?? spec.fallbackModel ?? ''
      if (!key || !modelId)
        throw new Error(`${spec.keyEnv} / ${spec.modelEnv} not set (${ENV_FILE})`)
      return { name, spec, key, modelId }
    })
    const allScenarios = Object.keys(SCENARIOS) as ScenarioId[]
    // retry 只在点名时跑（见文件头：它会让模型去启动这台电脑上的应用）
    const scenarios = process.env.PROBE_SCENARIOS
      ? listFrom(process.env.PROBE_SCENARIOS, allScenarios)
      : allScenarios.filter((id) => id !== 'retry')
    const conditions = listFrom(
      process.env.PROBE_CONDITIONS,
      Object.keys(CONDITIONS) as ConditionId[]
    )

    mkdirSync(join(OUT, 'transcripts'), { recursive: true })
    const debug = makeDebug(OUT)
    // 先把每个格子都跑一遍，再跑第二遍：提前停下时结果也是均衡的
    const queue: TrialPlan[] = []
    for (let rep = 1; rep <= REPEAT; rep++) {
      for (const target of targets) {
        for (const scenario of scenarios) {
          for (const condition of conditions) {
            queue.push({ model: target.name, scenario, condition, rep })
          }
        }
      }
    }
    const meta = {
      模型: targets.map((t) => `${t.name} = ${t.modelId}（${t.spec.support}）`).join('，'),
      每格重复: String(REPEAT),
      并行实例: String(WORKERS)
    }
    const total = queue.length
    const results: TrialResult[] = []
    const flush = (): void => {
      writeFileSync(join(OUT, 'report.md'), renderReport(results, meta))
      writeFileSync(
        join(OUT, 'results.jsonl'),
        results.map((r) => JSON.stringify(r)).join('\n') + '\n'
      )
    }

    await Promise.all(
      Array.from({ length: WORKERS }, async () => {
        for (let plan = queue.shift(); plan; plan = queue.shift()) {
          const target = targets.find((t) => t.name === plan?.model)
          if (!target) continue
          const { result, text } = await runTrial(
            plan,
            target.spec,
            target.key,
            target.modelId,
            debug
          )
          results.push(result)
          writeFileSync(join(OUT, 'transcripts', `${result.id}.txt`), text)
          flush()
          console.log(
            `[${results.length}/${total}] ${result.id}: ${result.error ? `ERROR ${result.error}` : `${result.sequence || '(no calls)'} completed=${result.completed}`} (${Math.round(result.ms / 1000)}s)`
          )
        }
      })
    )

    if (existsSync(join(OUT, 'report.md'))) {
      const report = readFileSync(join(OUT, 'report.md'), 'utf8')
      if (report.includes(`${REAL_HOME}/.shuvix`)) debug('report mentions the real ~/.shuvix')
    }
    console.log(`tool discovery report: ${join(OUT, 'report.md')}`)
  },
  8 * 60 * 60 * 1000
)
