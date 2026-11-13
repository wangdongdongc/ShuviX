/**
 * 知识库管理员怎么把关、怎么整理 —— 真模型探针。
 *
 * 起因（2026-11-12，用户反馈）：知识库很容易劣化 —— 工作会话把自己的中间过程（做了什么、进度、排查经过、测试结果）
 * 当项目知识交上来，管理员基本照单全收，条目数量很快膨胀。要管理员按「对项目有没有长期保存价值」来判断收不收，
 * 该否决的否决；条目多了以后主动合并、分类。这里量的就是它的判断。
 *
 * 做法：**提交这一侧是脚本**（假提供商让主会话原样发出一次 `knowledge` `submit`），**管理员是真模型**（隔离实例里放
 * 一份同名的 `~/.shuvix/agents/knowledge-writer.md` = 被测的那份 md + `shuvix-model: <真模型>`）。这样同一份提交内容
 * 可以一字不差地重放给不同的模型、不同版本的提示词，量出来的只有管理员的判断，没有提交者改写的噪声。
 * 提交者那一侧（真模型自己会交什么）在 knowledgeWork.probe.ts。
 *
 * 一个隔离实例跑完全部用例；每个用例一个新项目（各自的项目库）、一条新会话。用例（`CASES`，素材在
 * knowledgeGateFixtures.ts）：
 *   worklog     纯工作记录（做了什么、改了哪些文件、测试、提交号）                    期望：不收
 *   userasked   同上，但提交者说明是用户要求记的                                      期望：不收或只留有长期价值的部分，说清原因
 *   fixreport   包装成「知识」的修复报告，修完之后没有留下以后还成立的东西            期望：不收
 *   fixlesson   修复报告，原因是一条以后还会咬人的约束（网关 60 秒超时）              期望：只记约束，不记排查经过
 *   progress    进度 / 待办                                                            期望：不收
 *   narrative   排查过程 + 一个真结论                                                  期望：只记结论
 *   decision    一个决定和它的理由                                                     期望：收
 *   restate     复述代码（目录结构、函数清单）                                         期望：不收
 *   duplicate   库里已有同一件事，没有新东西                                           期望：不收、不新增
 *   extend      给已有的一条补一个新事实                                               期望：改那一条，不新增
 *   snapshot    某一刻的测试结果                                                       期望：不收
 *   mixed       一份会话总结，五项里两项有长期价值                                     期望：只记那两项
 *   howto / envfact / userpref   一件反复做的事的做法、环境里的一条事实、用户的一条长期偏好   期望：收（防把关过严）
 *   crowded     往一个已经劣化的库（26 条全在根目录）里交一条值得留的                  期望：收，并整理它落进去的那一块
 *   organize    对同一个劣化的库发 `organize`（什么都不交，整个库过一遍）              期望：合并重复的、删掉没有长期价值的、
 *                                                                                        分文件夹；用户的笔记与人工核实过的条目不动
 *
 * 每个用例量（都从磁盘和会话库读，不信模型的话）：收没收、动了哪几条、库前后的文件、新写 / 改过的条目全文、管理员的
 * 工具调用序列、耗时；再按用例各自的几条判据打标记（`flags`，如「把排查经过也记进去了」）。不断言（真模型不确定），
 * 只写 `<PROBE_OUT>/report.md`、`results.json`、`<用例>.txt`。
 *
 * 模型：`PROBE_PROVIDER=deepseek`（缺省）或 `kimi`；key 只从 `~/.shuvix-probe.env`（或环境变量）来。
 * 旋钮：`PROBE_CASES`（子集）、`PROBE_RUNS`（每条几遍，缺省 1）、`PROBE_LANG`（界面语言 = 取哪一版 md，缺省 en）、
 * `PROBE_LIBRARIAN_MD`（被测的 md；缺省本 checkout 里随包的那份）、`PROBE_OUT`。
 *
 *   npx electron-vite build
 *   npx vitest run --config vitest.config.probe.ts e2e/live/knowledgeGate.probe.ts
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import {
  startFakeProvider,
  toolTextsOf,
  type FakeProvider,
  type FakeRequest
} from '../harness/fakeProvider'
import { launchApp, type E2EApp } from '../harness/launch'
import {
  createProject,
  durableStoragePathOf,
  eventRecorder,
  requestToolNames,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../harness/seed'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'
import {
  ENV_FILE,
  installRealHomeGuard,
  makeDebug,
  sendPrompt,
  settle
} from './redactionProbeShared'
import {
  CROWDED_BASE,
  SMALL_BASE,
  SUBMIT_DECISION,
  SUBMIT_DUPLICATE,
  SUBMIT_ENVFACT,
  SUBMIT_EXTEND,
  SUBMIT_FIX_LESSON,
  SUBMIT_FIX_REPORT,
  SUBMIT_HOWTO,
  SUBMIT_INTO_CROWDED,
  SUBMIT_MIXED,
  SUBMIT_NARRATIVE,
  SUBMIT_PROGRESS,
  SUBMIT_RESTATE,
  SUBMIT_SNAPSHOT,
  SUBMIT_USERPREF,
  SUBMIT_WORKLOG,
  SUBMIT_WORKLOG_USER_ASKED
} from './knowledgeGateFixtures'

const REPO_ROOT = resolve(process.cwd(), '../..')
const OUT = process.env.PROBE_OUT ?? mkdtempSync(join(tmpdir(), 'shuvix-knowledge-gate-probe-'))
const LANG = process.env.PROBE_LANG ?? 'en'
const PROVIDER = (process.env.PROBE_PROVIDER ?? 'deepseek').toLowerCase()
const RUNS = Math.max(1, Number(process.env.PROBE_RUNS ?? '1') || 1)
const FAKE_MODEL = 'probe-scripted-submitter'
const LIBRARIAN_MD =
  process.env.PROBE_LIBRARIAN_MD ??
  join(
    REPO_ROOT,
    'packages/agent-runtime/src/subagent/builtinAgents/md',
    LANG === 'en' ? 'knowledge-writer.md' : `knowledge-writer.${LANG}.md`
  )

/** 一次跑完之后拿来打标记的材料 */
interface Outcome {
  accepted: boolean
  /** 工具结果原文（`Recorded in base …` / `Not recorded …` + 条目行 + 管理员的报告） */
  resultText: string
  before: Record<string, string>
  after: Record<string, string>
  added: string[]
  removed: string[]
  changed: string[]
  /** 新写与改过的条目正文拼在一起（判据在里面找词） */
  written: string
}

interface Case {
  id: string
  expect: string
  base?: Record<string, string>
  /** 缺省 `submit`；`organize` = 什么都不交，请管理员把整个库过一遍（`content` 是转述的要求，可为空） */
  action?: 'submit' | 'organize'
  content: string
  /** 提交者点名的条目（库内路径） */
  entry?: string
  /** 判据：回一组标记，空 = 合乎期望 */
  flags: (o: Outcome) => string[]
}

const turnedDown = (o: Outcome): string[] => [
  ...(o.accepted ? ['ACCEPTED (expected a turn-down)'] : []),
  ...(o.added.length ? [`added ${o.added.length} entr${o.added.length === 1 ? 'y' : 'ies'}`] : [])
]
const has = (o: Outcome, word: string): boolean => o.written.includes(word)
/** 库内链接（`](/x.md)`）里指向不存在的条目的那些：`源 → 目标` */
function brokenLinks(base: Record<string, string>): string[] {
  const out: string[] = []
  for (const [path, text] of Object.entries(base)) {
    for (const m of text.matchAll(/\]\(\/([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      let target = m[1]
      try {
        target = decodeURIComponent(target)
      } catch {
        /* 原样 */
      }
      if (!(target in base)) out.push(`${path} → /${target}`)
    }
  }
  return out
}
const linkFlags = (o: Outcome): string[] => {
  const broken = brokenLinks(o.after)
  return broken.length ? [`BROKEN LINKS: ${broken.join('; ')}`] : []
}
const recorded = (o: Outcome): string[] => [
  ...(o.accepted ? [] : ['TURNED DOWN (expected it recorded)']),
  ...(o.added.length === 1 ? [] : [`added ${o.added.length} entries (expected 1)`])
]

const CASES: Case[] = [
  { id: 'worklog', expect: 'turn down', content: SUBMIT_WORKLOG, flags: turnedDown },
  {
    id: 'userasked',
    expect: 'turn down (or keep only what lasts) and say why',
    content: SUBMIT_WORKLOG_USER_ASKED,
    flags: (o) => [
      ...(has(o, 'a81c3f2') ? ['kept the commit id'] : []),
      ...(has(o, '214') ? ['kept the test count'] : []),
      ...(has(o, '修改的文件') ? ['kept the file list'] : [])
    ]
  },
  { id: 'fixreport', expect: 'turn down', content: SUBMIT_FIX_REPORT, flags: turnedDown },
  {
    id: 'fixlesson',
    expect: 'record the 60s gateway constraint only',
    content: SUBMIT_FIX_LESSON,
    flags: (o) => [
      ...(o.accepted ? [] : ['TURNED DOWN (expected the constraint to be recorded)']),
      ...(has(o, '60') ? [] : ['the 60s constraint is missing']),
      ...(has(o, '索引') ? ['kept the dead end (index)'] : []),
      ...(has(o, 'csv-stringify') ? ['kept the dead end (csv-stringify)'] : []),
      ...(has(o, '验证') ? ['kept the verification section'] : []),
      ...(o.added.length > 1 ? [`added ${o.added.length} entries`] : [])
    ]
  },
  { id: 'progress', expect: 'turn down', content: SUBMIT_PROGRESS, flags: turnedDown },
  {
    id: 'narrative',
    expect: 'record the conclusion only',
    content: SUBMIT_NARRATIVE,
    flags: (o) => [
      ...(o.accepted ? [] : ['TURNED DOWN (expected the conclusion to be recorded)']),
      ...(has(o, 'redis-master') ? [] : ['the conclusion is missing']),
      ...(has(o, '事务回滚') ? ['kept the dead end (transaction rollback)'] : []),
      ...(has(o, '端口') ? ['kept the dead end (random port)'] : []),
      ...(has(o, '30 次') ? ['kept the verification run'] : [])
    ]
  },
  {
    id: 'decision',
    expect: 'record',
    content: SUBMIT_DECISION,
    flags: (o) => [
      ...(o.accepted ? [] : ['TURNED DOWN (expected it recorded)']),
      ...(o.added.length === 1 ? [] : [`added ${o.added.length} entries (expected 1)`])
    ]
  },
  { id: 'restate', expect: 'turn down', content: SUBMIT_RESTATE, flags: turnedDown },
  {
    id: 'duplicate',
    expect: 'nothing new',
    base: SMALL_BASE,
    content: SUBMIT_DUPLICATE,
    flags: (o) => [
      ...(o.added.length ? [`added ${o.added.length} (expected none)`] : []),
      ...(o.accepted && o.changed.length === 0 && o.added.length === 0
        ? ['says accepted but changed nothing']
        : [])
    ]
  },
  {
    id: 'extend',
    expect: 'update /ci/redis.md, add nothing',
    base: SMALL_BASE,
    content: SUBMIT_EXTEND,
    entry: '/ci/redis.md',
    flags: (o) => [
      ...(o.accepted ? [] : ['TURNED DOWN (expected the entry extended)']),
      ...(o.added.length ? [`added ${o.added.length} (expected none)`] : []),
      ...(has(o, 'redis-stg-master') ? [] : ['the new fact is missing'])
    ]
  },
  { id: 'snapshot', expect: 'turn down', content: SUBMIT_SNAPSHOT, flags: turnedDown },
  {
    id: 'mixed',
    expect: 'record the commit-message convention and the Redis pitfall only',
    content: SUBMIT_MIXED,
    flags: (o) => [
      ...(o.accepted ? [] : ['TURNED DOWN (expected two items recorded)']),
      ...(/祈使|英文|imperative|English/.test(o.written)
        ? []
        : ['the commit-message convention is missing']),
      ...(has(o, 'docker compose up') ? [] : ['the Redis pitfall is missing']),
      ...(has(o, '217') ? ['kept the test count'] : []),
      ...(has(o, 'refund.test.ts') ? ['kept the file list'] : []),
      ...(has(o, '金额校验') ? ['kept the to-do'] : [])
    ]
  },
  { id: 'howto', expect: 'record', content: SUBMIT_HOWTO, flags: recorded },
  { id: 'envfact', expect: 'record', content: SUBMIT_ENVFACT, flags: recorded },
  { id: 'userpref', expect: 'record', content: SUBMIT_USERPREF, flags: recorded },
  {
    id: 'crowded',
    expect: 'record, and tidy the part of the base it lands in',
    base: CROWDED_BASE,
    content: SUBMIT_INTO_CROWDED,
    flags: (o) => {
      const rootAfter = Object.keys(o.after).filter((p) => !p.includes('/')).length
      const exportish = (paths: string[]): number =>
        paths.filter((p) => /导出|export/i.test(p)).length
      return [
        ...(o.accepted ? [] : ['TURNED DOWN (expected it recorded)']),
        ...(has(o, 'BOM') || Object.values(o.after).some((t) => t.includes('BOM'))
          ? []
          : ['the BOM fact is missing']),
        `entries ${Object.keys(o.before).length} → ${Object.keys(o.after).length}`,
        `in the root ${Object.keys(o.before).filter((p) => !p.includes('/')).length} → ${rootAfter}`,
        `about export ${exportish(Object.keys(o.before))} → ${exportish(Object.keys(o.after))}`,
        `folders ${
          new Set(
            Object.keys(o.after)
              .filter((p) => p.includes('/'))
              .map((p) => p.split('/')[0])
          ).size
        }`,
        ...(Object.values(o.after).includes(o.before['随手记.md'])
          ? []
          : ["TOUCHED THE USER'S OWN NOTE"]),
        ...(Object.values(o.after).some(
          (t) => t.includes('human:wdd') && t.includes('2026-10-12T03:10:00.000Z')
        )
          ? []
          : ['the human-verified entry was rewritten or lost its stamp']),
        ...linkFlags(o)
      ]
    }
  },
  {
    id: 'organize',
    expect: 'merge duplicates, drop what does not last, group into folders',
    base: CROWDED_BASE,
    action: 'organize',
    content: '',
    flags: (o) => {
      const all = Object.values(o.after).join('\n')
      const lost = (label: string, word: string): string[] =>
        all.includes(word) ? [] : [`LOST: ${label}`]
      const kept = (label: string, word: string): string[] =>
        all.includes(word) ? [`still there: ${label}`] : []
      return [
        `entries ${Object.keys(o.before).length} → ${Object.keys(o.after).length}`,
        `in the root ${Object.keys(o.before).filter((p) => !p.includes('/')).length} → ${Object.keys(o.after).filter((p) => !p.includes('/')).length}`,
        `folders ${
          new Set(
            Object.keys(o.after)
              .filter((p) => p.includes('/'))
              .map((p) => p.split('/')[0])
          ).size
        }`,
        // 长期知识一条都不能丢
        ...lost('60s gateway limit', '60'),
        ...lost('page size 2000 and why', '2000'),
        ...lost('redis-master', 'redis-master'),
        ...lost('local Redis pitfall', 'docker compose up'),
        ...lost('callback idempotency', 'notify_id'),
        ...lost('certificate rotation', '轮换'),
        ...lost('order number reason', '撞号'),
        ...lost('cancel-after-refund pitfall', '退款成功'),
        ...lost('release checklist', '周五'),
        ...lost('rollback', 'rollback.sh'),
        ...lost('commit-message convention', '祈使'),
        ...lost('amounts in cents', 'amount_cents'),
        ...lost('migration rule', '只加不删'),
        ...lost('index rule', 'idx_user_created'),
        // 没有长期价值的该走
        ...kept('test run of 11-03', '80.9%'),
        ...kept('release log of 10-28', '14:02'),
        ...kept('refactor progress checklist', '灰度 10%'),
        ...kept('session summary (209 tests)', '209'),
        ...kept('to-do list', '导出加进度条'),
        ...(Object.values(o.after).includes(o.before['随手记.md'])
          ? []
          : ["TOUCHED THE USER'S OWN NOTE"]),
        ...(Object.values(o.after).some(
          (t) => t.includes('human:wdd') && t.includes('2026-10-12T03:10:00.000Z')
        )
          ? []
          : ['the human-verified entry was rewritten or lost its stamp']),
        ...linkFlags(o)
      ]
    }
  }
]

const ONLY = process.env.PROBE_CASES?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const SELECTED = ONLY ? CASES.filter((c) => ONLY.includes(c.id)) : CASES

interface RunRecord {
  id: string
  run: number
  expect: string
  seconds: number
  accepted: boolean
  flags: string[]
  added: string[]
  removed: string[]
  changed: string[]
  /** 管理员的工具调用，按序（`knowledge.search`、`write`…） */
  tools: string[]
  resultText: string
}

const records: RunRecord[] = []
let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let realKey = ''
let realModelId = ''
const debug = makeDebug(OUT)

/** 库里的全部 md：相对路径 → 原文 */
function readBase(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  let names: string[] = []
  try {
    names = readdirSync(dir, { recursive: true }).map((p) => String(p).replace(/\\/g, '/'))
  } catch {
    return out
  }
  for (const rel of names.sort()) {
    if (!rel.endsWith('.md') || rel.startsWith('.git/') || rel.includes('/.git/')) continue
    out[rel] = readFileSync(join(dir, rel), 'utf8')
  }
  return out
}

/** 种一个库并让它是个 git 仓库（真实的库从第一次写入起就是） */
function seedBase(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@shuvix.local', ...args], {
      cwd: dir,
      stdio: 'ignore'
    })
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '--allow-empty', '-m', 'kb(init): knowledge base')
}

/** 被测的 md → 隔离实例里的同名用户档案：去掉内置的身份行，钉上真模型 */
function librarianOverride(modelId: string): string {
  const text = readFileSync(LIBRARIAN_MD, 'utf8')
  const end = text.indexOf('\n---', 3)
  if (!text.startsWith('---') || end < 0) throw new Error(`${LIBRARIAN_MD}: no frontmatter`)
  const head = text
    .slice(3, end)
    .split('\n')
    .filter((line) => line.trim() && !/^shuvix-(id|builtin|model):/.test(line))
  return ['---', ...head, `shuvix-model: ${modelId}`, text.slice(end + 1)].join('\n')
}

/** 会话库里除根对话外的每条对话（= 管理员那一轮）：工具调用序列 + 摊开的记录 */
function librarianRun(sid: string): { tools: string[]; dump: string } {
  const file = durableStoragePathOf(app.home, sid)
  if (!existsSync(file)) return { tools: [], dump: '(session database not found)' }
  const rows = JSON.parse(
    execFileSync('sqlite3', [
      '-readonly',
      '-json',
      file,
      'SELECT conversation_id AS c, id, record FROM entries ORDER BY conversation_id, id'
    ]).toString('utf8') || '[]'
  ) as { c: number; id: number; record: string }[]
  if (rows.length === 0) return { tools: [], dump: '(no entries)' }
  const root = Math.min(...rows.map((r) => r.c))
  const tools: string[] = []
  const dump: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node !== 'object' || node === null) return
    const o = node as Record<string, unknown>
    if (o.type === 'toolCall' && typeof o.name === 'string') {
      const args = (o.arguments ?? {}) as Record<string, unknown>
      const detail =
        o.name === 'knowledge'
          ? `.${String(args.action ?? '?')}`
          : typeof args.path === 'string'
            ? `(${args.path.split('/').slice(-2).join('/')})`
            : ''
      tools.push(`${o.name}${detail}`)
    }
    Object.values(o).forEach(walk)
  }
  for (const r of rows) {
    if (r.c === root) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(r.record)
    } catch {
      parsed = r.record
    }
    walk(parsed)
    const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 1)
    dump.push(
      `--- conversation ${r.c} · entry ${r.id}`,
      text.length > 6000 ? `${text.slice(0, 6000)}\n… (${text.length - 6000} more chars)` : text
    )
  }
  return { tools, dump: dump.join('\n') }
}

const redact = (text: string): string => (realKey ? text.split(realKey).join('<redacted>') : text)

function renderReport(): string {
  const lines = [
    `# knowledge gate probe — ${PROVIDER} (${realModelId})`,
    '',
    `Librarian md: ${LIBRARIAN_MD}`,
    '',
    '| case | # | s | expect | accepted | +added | −removed | ~changed | librarian calls | flags |',
    '|---|---|---|---|---|---|---|---|---|---|'
  ]
  for (const r of records) {
    lines.push(
      `| ${r.id} | ${r.run} | ${r.seconds} | ${r.expect} | ${r.accepted ? 'yes' : 'no'} | ${r.added.join('<br>') || '—'} | ${r.removed.join('<br>') || '—'} | ${r.changed.join('<br>') || '—'} | ${r.tools.length} | ${r.flags.join('<br>') || 'ok'} |`
    )
  }
  lines.push('', '## What the submitter was told', '')
  for (const r of records) {
    lines.push(`### ${r.id} #${r.run}`, '', '```text', r.resultText.trim() || '(empty)', '```', '')
  }
  return lines.join('\n')
}

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true })
  const env = collectProbeEnv(
    process.env,
    existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : undefined
  )
  const kimi = PROVIDER === 'kimi'
  realKey = (kimi ? env.SHUVIX_PROBE_KIMI_KEY : env.SHUVIX_PROBE_COMPLETIONS_KEY) ?? ''
  realModelId = kimi
    ? (env.SHUVIX_PROBE_KIMI_MODEL ?? 'kimi-for-coding')
    : (env.SHUVIX_PROBE_COMPLETIONS_MODEL ?? '')
  if (!realKey || !realModelId) {
    throw new Error(`${PROVIDER} key / model not found (env or ${ENV_FILE})`)
  }

  provider = await startFakeProvider()
  app = await launchApp()
  await waitRendererReady(app.main)
  await app.main.eval(
    `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
  )
  await seedRealModel(
    app.main,
    kimi
      ? {
          providerId: 'kimi-coding',
          providerName: 'kimi',
          apiKey: realKey,
          apiProtocol: 'anthropic-messages',
          modelId: realModelId
        }
      : {
          providerId: 'deepseek',
          providerName: 'deepseek',
          apiKey: realKey,
          apiProtocol: 'openai-completions',
          modelId: realModelId
        }
  )
  // 之后种的假提供商成为新会话的默认模型：主会话是脚本，管理员经它的 md 钉在真模型上
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: FAKE_MODEL })
  mkdirSync(app.agentsDir, { recursive: true })
  writeFileSync(join(app.agentsDir, 'knowledge-writer.md'), librarianOverride(realModelId))
  await installRealHomeGuard(app, REPO_ROOT)
  events = eventRecorder(app.main)
  await events.install()
}, 180_000)

afterAll(async () => {
  writeFileSync(join(OUT, 'report.md'), redact(renderReport()))
  writeFileSync(join(OUT, 'results.json'), redact(JSON.stringify(records, null, 2)))
  console.log(`knowledge gate probe report: ${join(OUT, 'report.md')}`)
  await provider?.close()
  await app?.stop()
})

for (const c of SELECTED) {
  for (let run = 1; run <= RUNS; run++) {
    it(
      `${c.id} / #${run}`,
      async () => {
        const label = `${c.id}-r${run}`
        const mark = `[probe ${label}]`
        const workdir = join(app.home, 'code', label)
        mkdirSync(workdir, { recursive: true })
        const project = await createProject(app.main, {
          name: `order-service-${label}`,
          path: workdir
        })
        const baseDir = join(app.home, '.shuvix', 'knowledge-shuvix', 'projects', project.id)
        seedBase(baseDir, c.base ?? {})
        const before = readBase(baseDir)
        const sid = await app.main.eval<string>(
          `window.api.session.create(${JSON.stringify({ title: label, projectId: project.id })}).then((s) => s.id)`
        )

        // 主会话：第一步原样发出这次提交，拿到结果后收尾。按标记认领 —— 自动标题也往假提供商发请求
        const mine = (req: FakeRequest): boolean =>
          requestToolNames(req).includes('knowledge') && req.lastUserText.includes(mark)
        provider.script(
          {
            toolCalls: [
              {
                id: `call_${label}`,
                name: 'knowledge',
                args: JSON.stringify(
                  c.action === 'organize'
                    ? {
                        action: 'organize',
                        base: 'project',
                        ...(c.content ? { content: c.content } : {})
                      }
                    : {
                        action: 'submit',
                        base: 'project',
                        content: c.content,
                        ...(c.entry ? { entry: c.entry } : {})
                      }
                )
              }
            ],
            when: (req) => mine(req) && toolTextsOf(req).length === 0
          },
          { text: 'Done.', when: (req) => mine(req) && toolTextsOf(req).length > 0 }
        )

        const started = Date.now()
        await sendPrompt(app, sid, `${mark} submit the note to the project knowledge base`)
        await settle({
          app,
          events,
          sid,
          label,
          answer: () => 'Use your own judgement.',
          debug,
          quietMs: 6000,
          timeoutMs: 14 * 60 * 1000
        })
        const seconds = Math.round((Date.now() - started) / 1000)

        const resultText = await app.main.eval<string>(`
          (async () => {
            const msgs = await window.api.message.list(${JSON.stringify(sid)})
            for (const m of msgs) for (const b of m.blocks ?? []) {
              if (b.type === 'tool' && b.toolName === 'knowledge') {
                return (b.isError ? '(ERROR) ' : '') + String(b.result ?? '')
              }
            }
            return ''
          })()
        `)
        const after = readBase(baseDir)
        const added = Object.keys(after).filter((p) => !(p in before))
        const removed = Object.keys(before).filter((p) => !(p in after))
        const changed = Object.keys(after).filter((p) => p in before && before[p] !== after[p])
        const outcome: Outcome = {
          accepted: /^(Recorded in|Reorganized) base/.test(resultText),
          resultText,
          before,
          after,
          added,
          removed,
          changed,
          written: [...added, ...changed].map((p) => after[p]).join('\n')
        }
        const librarian = librarianRun(sid)
        records.push({
          id: c.id,
          run,
          expect: c.expect,
          seconds,
          accepted: outcome.accepted,
          flags: c.flags(outcome),
          added,
          removed,
          changed,
          tools: librarian.tools,
          resultText
        })

        const dump = [
          `# ${label} — ${PROVIDER} (${realModelId})`,
          `expect: ${c.expect}`,
          `flags: ${records[records.length - 1].flags.join(' | ') || 'ok'}`,
          `seconds: ${seconds}`,
          '',
          c.action === 'organize' ? '## Organize request' : '## Submission',
          ...(c.entry ? [`(names entry ${c.entry})`] : []),
          c.content || '(nothing in particular)',
          '',
          '## Result the submitter got',
          resultText,
          '',
          `## Base before (${Object.keys(before).length}): ${Object.keys(before).join(', ') || '(empty)'}`,
          `## Base after (${Object.keys(after).length}): ${Object.keys(after).join(', ') || '(empty)'}`,
          `removed: ${removed.join(', ') || '—'}`,
          '',
          ...[...added, ...changed].flatMap((p) => [
            `### ${added.includes(p) ? 'ADDED' : 'CHANGED'} ${p}`,
            '```markdown',
            after[p],
            '```',
            ''
          ]),
          `## Librarian tool calls (${librarian.tools.length}): ${librarian.tools.join(' → ')}`,
          '',
          '## Librarian conversation',
          librarian.dump
        ].join('\n')
        writeFileSync(join(OUT, `${label}.txt`), redact(dump))
        writeFileSync(join(OUT, 'report.md'), redact(renderReport()))
      },
      16 * 60 * 1000
    )
  }
}
