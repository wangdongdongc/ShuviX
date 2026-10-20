/**
 * 远程访问策略引导的真模型探针（2026-10-19，docs/network-policy/design.md §10）—— 不断言，跑几个场景、写一份报告。
 *
 * 每个场景：一条新会话（不属于项目、勾上 shuvix 知识库），输入的就是设置页「让 agent 帮我设置」填进输入框的那段
 * 提示词（同一个 buildNetworkPolicyPrompt、同一份界面语言的模板，事实按场景造）；agent 用 `ask` 工具提问 → 第一问
 * 交场景写好的「用户回答」，之后的问题回「按你的建议来」；它以文字提问结束一轮 → 同样把回答当下一条消息发过去
 * （至多三轮）。权限询问只放行落在隔离 HOME 里的（探的是知识条目，不是询问卡片；绝对路径能通向真实的主目录，
 * 不能一律放行）。结束后读隔离 HOME 里的
 * `~/.shuvix/policies/network-admission.md`，在 node 里用引擎（同一个解析器、内置策略、judgeGate 的降级）对场景的
 * 请求表逐条判定，与期望对照。报告里有转写、写出来的文件、对照表与得分。
 *
 * 用廉价模型跑是刻意的：能力强的模型会替不完整的知识条目补上空白，便宜的模型更能暴露条目哪里没写清楚。
 *
 * key **只从 env 文件来**（缺省 `~/.shuvix-probe.env`，`SHUVIX_PROBE_ENV_FILE` 可改）：`SHUVIX_PROBE_COMPLETIONS_KEY`、
 * `SHUVIX_PROBE_COMPLETIONS_MODEL`（必填：模型 ID）、`SHUVIX_PROBE_COMPLETIONS_PROVIDER`（缺省 deepseek，只认 deepseek）。
 * 不碰真实实例的数据库；key 只经 IPC 种进隔离实例，不打印、不落盘，输出里出现就替换掉。
 *
 * 跑：`electron-vite build` 之后，在 apps/desktop 下
 *   `npx vitest run --config vitest.config.probe.ts e2e/live/networkPolicy.probe.ts`
 * 旋钮：`PROBE_LANG`（界面语言，缺省 zh）、`PROBE_ONLY`（逗号分隔的场景 id）、`PROBE_OUT`（报告落点）、`PROBE_LABEL`。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import i18next, { type TFunction } from 'i18next'
import {
  createSecurityContext,
  parsePolicyDefinitionFile,
  type GateVerdict,
  type SecurityHostProvider,
  type SecurityObject,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import { createInlinePolicyMdReader } from '../../../../packages/agent-runtime/src/security/builtinPolicies/inlineSources'
import { buildNetworkPolicyPrompt } from '../../src/renderer/src/components/settings/networkPolicyPrompt'
import { channelAccessOf } from '../../src/shared/channelAccess'
import type { NetworkStatus } from '../../src/shared/network'
import { until } from '../harness/cdp'
import { launchApp, type E2EApp } from '../harness/launch'
import { eventRecorder, waitRendererReady, type EventRecorder } from '../harness/seed'
import { syncProbe } from '../harness/sync'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'

const ENV_FILE = process.env.SHUVIX_PROBE_ENV_FILE ?? join(homedir(), '.shuvix-probe.env')
/** 跑探针的这台电脑真实的主目录：隔离实例里的 agent 碰到它的一律拒绝 */
const REAL_HOME = homedir()
const LANG = (process.env.PROBE_LANG ?? 'zh') as 'en' | 'zh' | 'ja'
const LABEL = process.env.PROBE_LABEL ?? 'run'
const OUT = process.env.PROBE_OUT ?? join(tmpdir(), `shuvix-network-policy-probe-${LABEL}`)
const ONLY = (process.env.PROBE_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const PORT = 7766

// 提示词一律「发出去不等」：agent.prompt 要等这一轮跑完才回，而这一轮会停在询问上等 settle 去答 —— 等它就是互相等死

/** 第一问之后的所有问题、以及没写文件就停下来时的回答 */
const FOLLOW_UP: Record<'en' | 'zh' | 'ja', string> = {
  // 不提「核对」：探针要看的就是 agent 自己会不会去跑 shuvix policy check
  en: 'Go with what you recommend and finish setting it up now.',
  zh: '按你的建议来，直接设置好。',
  ja: 'おすすめのとおりで、設定を済ませてください。'
}
const PHONE = 'PhOnE0000000000000000a'
const LAPTOP = 'LaPtOp0000000000000000'
const OTHER = 'OtHeR00000000000000000'

/** 一条要判的请求 */
interface Probe {
  readonly label: string
  readonly address: string
  readonly device?: string
  readonly object: SecurityObject
  readonly action: string
  readonly tool?: { name: string; operation: string }
  readonly expect: 'allow' | 'deny'
}

const page = (label: string, address: string, expect: Probe['expect'], device?: string): Probe => ({
  label,
  address,
  device,
  action: 'request',
  object: { type: 'request', method: 'GET', path: '/', query: {}, route: 'page' },
  expect
})

const upgrade = (
  label: string,
  address: string,
  expect: Probe['expect'],
  device?: string
): Probe => ({
  label,
  address,
  device,
  action: 'request',
  object: { type: 'request', method: 'GET', path: '/ws', query: {}, route: 'socket' },
  expect
})

const call = (
  label: string,
  address: string,
  channel: string,
  expect: Probe['expect'],
  device?: string
): Probe => ({
  label,
  address,
  device,
  action: 'invoke',
  object: {
    type: 'channel',
    channel,
    group: channel.split(':')[0],
    kind: 'invoke',
    access: channelAccessOf(channel),
    size: 64
  },
  expect
})

const write = (
  label: string,
  address: string,
  path: string,
  expect: Probe['expect'],
  device?: string
): Probe => ({
  label,
  address,
  device,
  action: 'write',
  object: { type: 'path', path, displayPath: path },
  tool: { name: 'files', operation: 'write' },
  expect
})

interface Scenario {
  readonly id: string
  /** 「用户」对 agent 第一个问题（或第一轮文字提问）的回答，按界面语言 */
  readonly answer: Record<'en' | 'zh' | 'ja', string>
  /** 造进提示词的事实 */
  readonly status: Partial<NetworkStatus>
  readonly probes: (home: string) => Probe[]
}

const SCENARIOS: Scenario[] = [
  {
    id: 'devices',
    answer: {
      zh: `会连进来的只有两台设备，都在家里的局域网（192.168.1.0/24）：\n- 我的手机，设备 ID ${PHONE}：只能看会话，不能发消息、不能改任何东西；\n- 我的笔记本，设备 ID ${LAPTOP}：什么都能做。\n不用 VPN，也不用 SSH 隧道。其他设备一律不许连。`,
      en: `Only two devices will connect, both on my home network (192.168.1.0/24):\n- my phone, device ID ${PHONE}: it may only look at conversations — no sending messages, no changing anything;\n- my laptop, device ID ${LAPTOP}: it may do everything.\nNo VPN, no SSH tunnel. No other device may connect.`,
      ja: `接続するのは二台だけで、どちらも自宅のネットワーク（192.168.1.0/24）にあります：\n- スマートフォン、デバイス ID ${PHONE}：会話を見るだけ。メッセージの送信も、何かを変えることもできない。\n- ノート PC、デバイス ID ${LAPTOP}：何でもできる。\nVPN も SSH トンネルも使いません。ほかのデバイスは一切接続させないでください。`
    },
    status: {
      clients: [
        {
          id: 'ws:1',
          remoteAddress: '192.168.1.23',
          userAgent: 'Mobile Safari',
          device: PHONE,
          connectedAt: 1
        },
        {
          id: 'ws:2',
          remoteAddress: '192.168.1.40',
          userAgent: 'Chrome',
          device: LAPTOP,
          connectedAt: 2
        }
      ]
    },
    probes: (home) => [
      page('this computer opens the page', '127.0.0.1', 'allow'),
      page('unknown LAN device opens the page', '192.168.1.50', 'deny'),
      upgrade('unknown device with an ID connects', '192.168.1.50', 'deny', OTHER),
      page('phone opens the page', '192.168.1.23', 'allow', PHONE),
      upgrade('phone connects', '192.168.1.23', 'allow', PHONE),
      call('phone lists sessions', '192.168.1.23', 'session:list', 'allow', PHONE),
      call('phone reads messages', '192.168.1.23', 'message:list', 'allow', PHONE),
      call('phone sends a message to an agent', '192.168.1.23', 'agent:prompt', 'deny', PHONE),
      call('phone creates a policy', '192.168.1.23', 'policy:create', 'deny', PHONE),
      call('phone changes a setting', '192.168.1.23', 'settings:set', 'deny', PHONE),
      write(
        'phone writes a policy file',
        '192.168.1.23',
        `${home}/.shuvix/policies/x.md`,
        'deny',
        PHONE
      ),
      page('laptop opens the page', '192.168.1.40', 'allow', LAPTOP),
      upgrade('laptop connects', '192.168.1.40', 'allow', LAPTOP),
      call('laptop sends a message to an agent', '192.168.1.40', 'agent:prompt', 'allow', LAPTOP),
      call('laptop changes a setting', '192.168.1.40', 'settings:set', 'allow', LAPTOP)
    ]
  },
  {
    id: 'subnets',
    answer: {
      zh: '家里的局域网 192.168.1.0/24 和公司 VPN 10.8.0.0/16 里的设备都可以连。连进来的都是我自己的设备，什么都能做。别的网段不行。',
      en: 'Devices on my home network 192.168.1.0/24 and on the office VPN 10.8.0.0/16 may connect. They are all my own devices and may do everything. Nothing from other networks.',
      ja: '自宅のネットワーク 192.168.1.0/24 と会社の VPN 10.8.0.0/16 のデバイスは接続できます。どれも自分のデバイスなので何でもできます。ほかのネットワークは不可。'
    },
    status: {},
    probes: () => [
      page('this computer opens the page', '127.0.0.1', 'allow'),
      page('home device opens the page', '192.168.1.23', 'allow'),
      page('VPN device opens the page', '10.8.3.4', 'allow'),
      upgrade('VPN device connects', '10.8.3.4', 'allow'),
      call('VPN device sends a message to an agent', '10.8.3.4', 'agent:prompt', 'allow'),
      page('other network opens the page', '192.168.2.5', 'deny'),
      page('another private range opens the page', '172.16.0.5', 'deny')
    ]
  },
  {
    id: 'readonly-lan',
    answer: {
      zh: '家里局域网（192.168.1.0/24）的任何设备都可以连进来看会话，但不能发消息、不能改设置、不能改文件。只有在这台电脑上、或者经 SSH 隧道进来的，才能做一切。别的网段都不许连。',
      en: 'Any device on my home network (192.168.1.0/24) may connect and look at conversations, but not send messages, change settings or change files. Only this computer itself, or an SSH tunnel to it, may do everything. No other network may connect.',
      ja: '自宅のネットワーク（192.168.1.0/24）のどのデバイスも接続して会話を見られますが、メッセージの送信、設定やファイルの変更はできません。何でもできるのは、このコンピューター自身か SSH トンネル経由だけです。ほかのネットワークは接続不可。'
    },
    status: {},
    probes: (home) => [
      page('this computer opens the page', '127.0.0.1', 'allow'),
      call('this computer sends a message to an agent', '127.0.0.1', 'agent:prompt', 'allow'),
      page('home device opens the page', '192.168.1.23', 'allow'),
      upgrade('home device connects', '192.168.1.23', 'allow'),
      call('home device lists sessions', '192.168.1.23', 'session:list', 'allow'),
      call('home device sends a message to an agent', '192.168.1.23', 'agent:prompt', 'deny'),
      call('home device changes a setting', '192.168.1.23', 'settings:set', 'deny'),
      write('home device writes a file', '192.168.1.23', `${home}/notes/a.md`, 'deny'),
      page('other network opens the page', '10.0.0.5', 'deny')
    ]
  }
]

let app: E2EApp
let events: EventRecorder
let key = ''
let modelId = ''
let t: TFunction

/** 输出里绝不能出现 key */
const redact = (text: string): string => (key ? text.split(key).join('<redacted>') : text)

beforeAll(async () => {
  const env = collectProbeEnv(
    process.env,
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
  )
  key = env.SHUVIX_PROBE_COMPLETIONS_KEY ?? ''
  modelId = env.SHUVIX_PROBE_COMPLETIONS_MODEL ?? ''
  const provider = (env.SHUVIX_PROBE_COMPLETIONS_PROVIDER ?? 'deepseek').toLowerCase()
  if (!key) throw new Error(`SHUVIX_PROBE_COMPLETIONS_KEY not found (env or ${ENV_FILE})`)
  if (!modelId) throw new Error(`SHUVIX_PROBE_COMPLETIONS_MODEL not found (env or ${ENV_FILE})`)
  if (provider !== 'deepseek') throw new Error(`only deepseek is wired here, got ${provider}`)

  t = (await i18next.createInstance().init({
    lng: LANG,
    resources: { en: { translation: en }, zh: { translation: zh }, ja: { translation: ja } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })) as TFunction

  app = await launchApp()
  await waitRendererReady(app.main)
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
  )
  await seedRealModel(app.main, {
    providerId: 'deepseek',
    providerName: 'deepseek',
    apiKey: key,
    baseUrl: 'https://api.deepseek.com',
    apiProtocol: 'openai-completions',
    modelId
  })
  events = eventRecorder(app.main)
  await events.install()
  mkdirSync(OUT, { recursive: true })
}, 180_000)

afterAll(async () => {
  await app?.stop()
})

const policiesDir = (): string => join(app.home, '.shuvix', 'policies')

/** 进度写进报告目录的 debug.log（vitest 会攒着 console 输出到用例结束才印） */
function debug(line: string): void {
  try {
    appendFileSync(join(OUT, 'debug.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 报告目录还没建 */
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    )
  ])
}

/** 等会话安静下来（10 秒没有新事件），其间回答它的询问；回：问过几次 ask 工具 */
async function settle(sid: string, scenario: Scenario, answeredBefore: number): Promise<number> {
  const probe = syncProbe(app.main)
  await probe.install()
  const answered = new Set<string>()
  let questions = answeredBefore
  let last = -1
  let lastLog = 0
  let quietSince = Date.now()
  await until(
    async () => {
      // 单次读取限时：视图读挂住时不能把整个等待卡死（until 对单次轮询没有超时）
      const view = await withTimeout(probe.viewOf(sid), 8000).catch((error) => {
        debug(`${scenario.id}: viewOf failed: ${String(error)}`)
        return undefined
      })
      for (const req of (view?.asks ?? []) as Array<{ id: string; kind: string }>) {
        if (answered.has(req.id)) continue
        debug(`${scenario.id}: answering ${req.kind} ${req.id}`)
        let response: Record<string, unknown>
        if (req.kind === 'choice') {
          questions++
          response = {
            kind: 'other',
            text: questions === 1 ? scenario.answer[LANG] : FOLLOW_UP[LANG]
          }
        } else {
          // 权限询问：只放行落在隔离 HOME（与它底下的 userData）里的操作。e2e 只换了 HOME 环境变量 —— 绝对路径照样
          // 通向这台电脑真实的主目录（agent 能从知识库的路径里推出它来），一律放行等于替它批准往真实的
          // ~/.shuvix 里写（2026-10-19 r4 就写进去了）。命令里没有隔离 HOME 的路径也拒绝（够不着别处的才放）
          const text = JSON.stringify(req)
          const inside = text.includes(app.home)
          const outside = text.includes(`${REAL_HOME}/`)
          response =
            inside && !outside
              ? { kind: 'ask', allowed: true }
              : {
                  kind: 'ask',
                  allowed: false,
                  reason: `Refused. In this environment the home folder is ${app.home} — use ~ or paths under it.`
                }
        }
        try {
          const result = await app.main.eval(
            `window.api.agent.respondToInput(${JSON.stringify({ sessionId: sid, requestId: req.id, response })})`
          )
          answered.add(req.id)
          debug(`${scenario.id}: answered ${req.id} → ${JSON.stringify(result)}`)
        } catch (error) {
          // 没答上：下一拍再试（until 会吞掉这一拍的错误）
          debug(`${scenario.id}: answering ${req.id} failed: ${String(error)}`)
          if (req.kind === 'choice') questions--
          throw error
        }
        quietSince = Date.now()
      }
      const n = (await events.all()).length
      if (n !== last && Date.now() - lastLog > 30_000) {
        lastLog = Date.now()
        console.log(
          `[probe] ${scenario.id}: ${n} events, run ${view?.run?.state ?? '?'}, asks ${view?.asks?.length ?? 0}`
        )
      }
      if (n !== last) {
        last = n
        quietSince = Date.now()
        return false
      }
      // 安静 10 秒还不够：模型在想（还没出第一个字）时也没有事件。会话还忙着就发下一条，那一条会被当作
      // 「忙」拒掉、什么也不留（r6 的场景回答就这么丢了）—— 一定要等到这一轮真的结束
      return Date.now() - quietSince > 10_000 && view !== undefined && view.run?.state !== 'busy'
    },
    'session went quiet',
    12 * 60 * 1000
  )
  return questions
}

async function transcriptOf(sid: string): Promise<string> {
  return app.main.eval<string>(`
    (async () => {
      const msgs = await window.api.message.list(${JSON.stringify(sid)})
      const out = []
      for (const m of msgs) {
        if (m.role === 'user') { out.push('>>> USER: ' + m.content); continue }
        if (m.role !== 'assistant') { out.push('### ' + m.role + ': ' + m.content); continue }
        for (const b of m.blocks ?? []) {
          if (b.type === 'text' && b.text?.trim()) out.push('<<< ASSISTANT: ' + b.text)
          if (b.type !== 'tool') continue
          const args = JSON.stringify(b.args ?? {})
          out.push('[TOOL] ' + b.toolName + ' ' + (args.length > 3000 ? args.slice(0, 3000) + '…' : args))
          const result = String(b.result ?? '')
          out.push('[RESULT]' + (b.isError ? ' (ERROR)' : '') + '\\n' + (result.length > 1500 ? result.slice(0, 1500) + '…' : result))
        }
      }
      return out.join('\\n\\n')
    })()
  `)
}

/** 隔离 HOME 里的用户策略（解析失败的记下原因） */
function userPolicies(): {
  files: UserPolicyFile[]
  raw: Record<string, string>
  invalid: string[]
} {
  const dir = policiesDir()
  const files: UserPolicyFile[] = []
  const raw: Record<string, string> = {}
  const invalid: string[] = []
  if (!existsSync(dir)) return { files, raw, invalid }
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('.'))) {
    const text = readFileSync(join(dir, name), 'utf8')
    raw[name] = text
    const warnings: string[] = []
    const parsed = parsePolicyDefinitionFile(text, name.slice(0, -3), (w) => warnings.push(w))
    if (!parsed) invalid.push(`${name}: ${warnings.join(' / ') || 'invalid'}`)
    else {
      files.push({ ...parsed, fileName: name })
      for (const w of warnings) invalid.push(`${name} (warning): ${w}`)
    }
  }
  return { files, raw, invalid }
}

function judge(files: UserPolicyFile[], probe: Probe): GateVerdict {
  const home = app.home
  const provider: SecurityHostProvider = {
    host: 'desktop',
    pathSep: '/',
    getVars: () => ({
      home,
      botsDir: `${home}/.shuvix/bots`,
      shuvixConfigDirs: ['policies', 'agents', 'hooks', 'skills'].map((d) => `${home}/.shuvix/${d}`)
    }),
    getSessionGrants: () => ({ allowList: [] }),
    readBuiltinPolicyMd: createInlinePolicyMdReader(),
    getUserPolicies: () => files
  }
  return createSecurityContext(
    {
      kind: 'network',
      sessionId: '',
      attrs: {
        address: probe.address,
        port: 50000,
        localAddress: probe.address === '127.0.0.1' ? '127.0.0.1' : '192.168.1.10',
        localPort: PORT,
        family: 'ipv4',
        interface: probe.address === '127.0.0.1' ? 'lo0' : 'en0',
        headers: probe.device ? { cookie: `shuvix_device=${probe.device}` } : {},
        cookies: probe.device ? { shuvix_device: probe.device } : {},
        device: probe.device ?? '',
        userAgent: '',
        connection: probe.object.type === 'channel' ? 'ws:1' : ''
      }
    },
    { host: 'desktop', platform: 'darwin' },
    provider
  ).judgeGate(probe.action, probe.object, probe.tool ? { tool: probe.tool } : undefined)
}

it(
  'sets up remote access policies with a real model',
  async () => {
    const summary: string[] = [
      `# Network policy onboarding probe — ${LABEL}`,
      '',
      `model: ${modelId} · language: ${LANG} · ${new Date().toISOString()}`,
      ''
    ]
    for (const scenario of SCENARIOS) {
      if (ONLY.length > 0 && !ONLY.includes(scenario.id)) continue
      rmSync(policiesDir(), { recursive: true, force: true })

      const status: NetworkStatus = {
        enabled: true,
        port: PORT,
        listening: true,
        addresses: [`http://127.0.0.1:${PORT}`],
        clients: [],
        admission: 'builtin',
        denials: [],
        ...scenario.status
      }
      const prompt = buildNetworkPolicyPrompt(t, status)
      const sid = await app.main.eval<string>(
        `(async () => {
          const s = await window.api.session.create({ projectId: null, title: ${JSON.stringify(`network policy — ${scenario.id}`)} })
          await window.api.session.updateKnowledgeBases({ id: s.id, knowledgeBases: ['shuvix'] })
          return s.id
        })()`
      )
      const started = Date.now()
      await app.main.eval(
        `(void window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(prompt)} }), true)`
      )
      let questions = await settle(sid, scenario, 0)
      // 以文字提问结束一轮、还没写文件：把回答当下一条消息发过去（至多三轮）
      for (
        let round = 0;
        round < 3 && !existsSync(join(policiesDir(), 'network-admission.md'));
        round++
      ) {
        const text = round === 0 && questions === 0 ? scenario.answer[LANG] : FOLLOW_UP[LANG]
        await app.main.eval(
          `(void window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }), true)`
        )
        questions = await settle(sid, scenario, questions === 0 ? 1 : questions)
      }
      const seconds = Math.round((Date.now() - started) / 1000)

      const { files, raw, invalid } = userPolicies()
      const admission = files.find((f) => f.name === 'network-admission')
      const rows = scenario.probes(app.home).map((probe) => {
        const verdict = judge(files, probe)
        const actual = verdict.allowed ? 'allow' : 'deny'
        return { probe, actual, verdict }
      })
      const passed = rows.filter((r) => r.actual === r.probe.expect).length
      const transcript = await transcriptOf(sid)
      // agent 自己核对了几次（`shuvix policy check` 的 bash 调用）
      const checks = transcript
        .split('\n')
        .filter((l) => l.startsWith('[TOOL] ') && l.includes('shuvix policy check')).length

      const report: string[] = [
        `# Scenario ${scenario.id}`,
        '',
        `model ${modelId} · ${LANG} · ${seconds}s · ask-tool questions ${questions} · ` +
          `network-admission ${admission ? 'written' : 'MISSING'} · ${passed}/${rows.length} as expected · ` +
          `policy checks ${checks}`,
        '',
        '## Prompt',
        '',
        '```text',
        prompt,
        '```',
        '',
        '## Policy files',
        ''
      ]
      for (const [name, text] of Object.entries(raw)) {
        report.push(`### ${name}`, '', '```markdown', text, '```', '')
      }
      if (invalid.length > 0) report.push('### Parser', '', ...invalid.map((i) => `- ${i}`), '')
      report.push(
        '## Requests',
        '',
        '| | request | expected | actual | rule |',
        '| --- | --- | --- | --- | --- |',
        ...rows.map(
          (r) =>
            `| ${r.actual === r.probe.expect ? 'ok' : '**MISMATCH**'} | ${r.probe.label} | ${r.probe.expect} | ${r.actual} | ${r.verdict.decision.winning}${r.verdict.downgraded ? ' (ask→deny)' : ''} |`
        ),
        '',
        '## Transcript',
        '',
        '```text',
        transcript,
        '```',
        ''
      )
      writeFileSync(join(OUT, `${scenario.id}.md`), redact(report.join('\n')))
      summary.push(
        `- **${scenario.id}**: ${passed}/${rows.length} as expected · policy ${admission ? 'written' : 'MISSING'} · ` +
          `${questions} ask-tool question(s) · ${checks} policy check(s) · ${seconds}s` +
          (invalid.length > 0 ? ` · parser: ${invalid.length} note(s)` : '')
      )
    }
    writeFileSync(join(OUT, 'README.md'), redact(summary.join('\n') + '\n'))
    console.log(redact(summary.join('\n')))
    console.log(`report: ${OUT}`)
  },
  45 * 60 * 1000
)
