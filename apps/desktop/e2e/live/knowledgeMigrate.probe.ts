/**
 * 真模型会不会用 `knowledge` 工具把另一个项目知识库里的条目迁进本项目，目标库的管理员又会怎么收 —— 真模型探针
 * （docs/project-split-design.md §5、§7）。
 *
 * 起因（2026-11-11）：拆分项目时知识库条目也只给 agent 一条路 —— 带 `project` 看另一个项目的库，再 `migrate`；
 * 迁来的条目交给目标库的管理员（内置 `knowledge-writer`）处理，不直接落地。这里一次量两个真模型的行为：发起迁移的
 * agent（会不会先看那个库、点名对的条目、不重抄正文、如实汇报）和管理员（原样收 / 合并 / 不收，`taken` 报得对不对）。
 *
 * 每个试次一个新实例。两个项目：`big`（知识库里六条：auth/ 三条、release/ 两条、misc/ 一条，之间有链接）与 `auth`
 * （知识库里已有一条 `auth/token-refresh.md`，与 big 的同名条目讲同一件事、内容不同 —— 看管理员合不合并）。
 * 发消息的会话在 `auth` 里。
 *
 * 场景（`SCENARIOS`），一条像真用户那样写的中文消息：
 *   topic   「把 big 项目知识库里和登录、令牌、会话有关的条目迁移到这个项目」—— 要它自己看库、挑条目
 *   named   「把 big 项目知识库里的 /release/checklist.md 迁移过来」—— 点名一条
 *   all     「把 big 项目的知识库整个迁移过来」—— 六条，一次调用以内
 *   deny    同 topic，但模拟用户在写入的询问上点拒绝（这个场景关掉自动审查，卡才到得了「用户」）
 *   chat    在不属于任何项目的临时对话里提同样的要求 —— 没有可迁入的项目库；看它怎么说
 *
 * 模拟用户答卡（settle 的 `respond`）：隔离 HOME 里的路径询问放行（deny 场景对写入的那张拒绝）；`ask` 工具的问题答
 * 「按你的判断来。」。
 *
 * 每个试次量（都从实例的状态和探针自己的记录读，不信模型的话）：
 *   - `knowledge` 工具的调用（动作、带没带 project、点名了几条）、别的工具调用；
 *   - 路径门的决策（读 / 写、是审查员答的还是人答的）；
 *   - 两个库最后各有哪些条目；目标库新来的条目有没有两个章；源库的 git 提交信息（去向 trailer）；
 *   - 最后一段回复（给人读）。
 * 不断言（真模型不确定），只写 `<PROBE_OUT>/report.md`、`results.json`、`<试次>.txt`。
 *
 * 安全（同别的探针）：权限询问只放行不碰真实主目录的（settle）；文件工具碰真实主目录一律拒（installRealHomeGuard）；
 * 沙箱外的命令一律拒（`NO_UNCONFINED_POLICY`）。
 *
 * 模型：`PROBE_PROVIDER=deepseek`（缺省）或 `kimi`；key 只从 `~/.shuvix-probe.env`（或环境变量）来。
 * 其余旋钮：`PROBE_SCENARIOS`（子集）、`PROBE_RUNS`（缺省 1）、`PROBE_LANG`（缺省 zh）、`PROBE_OUT`。
 *
 *   npx electron-vite build
 *   npx vitest run --config vitest.config.probe.ts e2e/live/knowledgeMigrate.probe.ts
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
import { launchApp, type E2EApp } from '../harness/launch'
import {
  createProject,
  eventRecorder,
  securityDecisions,
  waitRendererReady,
  type EventRecorder
} from '../harness/seed'
import { stagePackagedResources, type PackagedStage } from './packagedStage'
import { seedRealModel } from './probe'
import { collectProbeEnv } from './protocolProbeEnv'
import {
  ENV_FILE,
  installPolicy,
  installRealHomeGuard,
  makeDebug,
  REAL_HOME,
  sendPrompt,
  settle,
  transcriptOf
} from './redactionProbeShared'

const REPO_ROOT = resolve(process.cwd(), '../..')
const OUT = process.env.PROBE_OUT ?? mkdtempSync(join(tmpdir(), 'shuvix-knowledge-migrate-probe-'))
const LANG = process.env.PROBE_LANG ?? 'zh'
const PROVIDER = (process.env.PROBE_PROVIDER ?? 'deepseek').toLowerCase()
const RUNS = Math.max(1, Number(process.env.PROBE_RUNS ?? '1') || 1)

type Scenario = 'topic' | 'named' | 'all' | 'deny' | 'chat'
const ALL: Scenario[] = ['topic', 'named', 'all', 'deny', 'chat']
const SCENARIOS = (process.env.PROBE_SCENARIOS ?? ALL.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is Scenario => (ALL as string[]).includes(s))

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

const okf = (o: {
  type: string
  title: string
  description: string
  tags: string[]
  body: string
  source: string
}): string =>
  [
    '---',
    'shuvix: okf v0.2',
    `type: ${o.type}`,
    `title: ${o.title}`,
    `description: ${o.description}`,
    `tags: [${o.tags.join(', ')}]`,
    'status: stable',
    'sources:',
    `  - resource: ${o.source}`,
    '---',
    '',
    o.body,
    ''
  ].join('\n')

/** big 项目的知识库 */
const BIG_BASE: Record<string, string> = {
  'auth/login-flow.md': okf({
    type: 'Guide',
    title: '登录流程',
    description: '改登录页或排查登录失败时打开。',
    tags: ['auth', 'login'],
    source: '/work/big/src/auth/login.ts',
    body: '登录表单提交到 `/api/login`，成功后写会话 cookie，再跳回来源页。\n\n令牌过期后的续期见 [令牌刷新](/auth/token-refresh.md)；cookie 的属性见 [会话 cookie](/auth/session-cookies.md)。'
  }),
  'auth/token-refresh.md': okf({
    type: 'Memory',
    title: '令牌刷新的竞态',
    description: '请求在刷新令牌后立刻返回 401 时打开。',
    tags: ['auth', 'token'],
    source: '/work/big/src/auth/refresh.ts#refreshToken',
    body: '两个请求同时发现令牌过期时会各自刷新一次，后到的那次把先到的令牌作废。修法：刷新请求全局只保留一个进行中的 Promise。'
  }),
  'auth/session-cookies.md': okf({
    type: 'Decision',
    title: '会话 cookie 的属性',
    description: '要改 cookie 的 SameSite / Secure / 过期时间时打开。',
    tags: ['auth', 'session'],
    source: '/work/big/src/auth/cookies.ts',
    body: '会话 cookie 用 `SameSite=Lax; Secure; HttpOnly`，有效期 14 天，每次请求滑动续期。'
  }),
  'release/checklist.md': okf({
    type: 'Guide',
    title: '发版检查清单',
    description: '发版之前打开。',
    tags: ['release'],
    source: '/work/big/scripts/release.sh',
    body: '1. 跑完整测试。\n2. 更新版本号。\n3. 打 tag、推送。\n\n发版当天不要改 [登录流程](/auth/login-flow.md) 相关的代码。'
  }),
  'release/versioning.md': okf({
    type: 'Decision',
    title: '版本号规则',
    description: '不确定该升哪一位版本号时打开。',
    tags: ['release'],
    source: '/work/big/package.json',
    body: '按 semver：破坏性改动升主版本，新功能升次版本，其余升修订号。'
  }),
  'misc/editor-setup.md': okf({
    type: 'Memory',
    title: '编辑器设置',
    description: '新机器上配编辑器时打开。',
    tags: ['tooling'],
    source: '/work/big/.editorconfig',
    body: '缩进两个空格，保存时格式化。'
  })
}

/** auth 项目的知识库里已有的一条：与 big 的同名条目讲同一件事 */
const AUTH_BASE: Record<string, string> = {
  'auth/token-refresh.md': okf({
    type: 'Memory',
    title: '令牌刷新',
    description: '改令牌续期逻辑时打开。',
    tags: ['auth', 'token'],
    source: '/work/auth/src/refresh.ts',
    body: '访问令牌有效期 15 分钟，过期前 1 分钟内的请求会先触发刷新。'
  })
}

interface KnowledgeCall {
  action: string
  project?: string
  base?: string
  entries?: number
  isError: boolean
}

interface RunRecord {
  scenario: Scenario
  run: number
  provider: string
  seconds: number
  knowledgeCalls: KnowledgeCall[]
  otherTools: string[]
  /** 路径门：读 / 写、谁答的 */
  gates: Array<{ action: string; effect: string; review?: string; user?: string }>
  sourceBefore: string[]
  sourceAfter: string[]
  targetBefore: string[]
  targetAfter: string[]
  /** 目标库里新来或改过的条目：两个章各是谁 */
  stamps: Record<string, { generated?: string; verified?: string }>
  /** 源库最近几条提交信息里的去向 trailer */
  movedToTrailers: string[]
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
  stage = stagePackagedResources()
  realShuvixBefore = listRealShuvix()
}, 120_000)

afterAll(() => {
  stage?.cleanup()
  const added = listRealShuvix().filter((n) => !realShuvixBefore.includes(n))
  writeFileSync(
    join(OUT, 'real-home-check.txt'),
    added.length ? `NEW IN REAL ~/.shuvix:\n${added.join('\n')}\n` : 'real ~/.shuvix unchanged\n'
  )
})

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

const baseDirOf = (app: E2EApp, projectId: string): string =>
  join(app.home, '.shuvix', 'knowledge-shuvix', 'projects', projectId)

/**
 * 种一个库，并让它像真的库那样是个 git 仓库（宿主对每次变更各提交一次，真实的库从第一次写入起就是仓库）——
 * 否则被删掉的条目从没进过仓库，源库那边就没有可看的删除提交
 */
function seedBase(dir: string, files: Record<string, string>): void {
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
  git('commit', '-q', '-m', 'kb(init): knowledge base')
}

/** 库里的全部 md（相对路径、字典序） */
function treeOf(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true })
      .map((p) => String(p).replace(/\\/g, '/'))
      .filter((p) => p.endsWith('.md') && !p.startsWith('.git/'))
      .sort()
  } catch {
    return []
  }
}

const stampOf = (text: string, key: string): string | undefined =>
  new RegExp(`^${key}: .*by: "([^"]*)"`, 'm').exec(text)?.[1]

function movedToTrailers(dir: string): string[] {
  try {
    return execFileSync('git', ['log', '-10', '--format=%B'], { cwd: dir, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.startsWith('Knowledge-Moved-To:'))
  } catch {
    return []
  }
}

function promptOf(scenario: Scenario): string {
  switch (scenario) {
    case 'topic':
    case 'deny':
    case 'chat':
      return '把「big」项目知识库里和登录、令牌、会话有关的条目迁移到这个项目的知识库里。'
    case 'named':
      return '把「big」项目知识库里的 /release/checklist.md 迁移过来。'
    case 'all':
      return '把「big」项目的知识库整个迁移到这个项目。'
  }
}

interface Block {
  type: string
  toolName?: string
  args?: Record<string, unknown>
  isError?: boolean
}
interface Msg {
  role: string
  content: string
  blocks?: Block[]
}

function renderReport(): string {
  const lines = [
    `# knowledge migrate probe — ${PROVIDER}`,
    '',
    '| 场景 | # | 秒 | knowledge 工具的调用 | 别的工具 | 路径门 | 源库少了 | 目标库多了 / 现有 | 去向 trailer |',
    '|---|---|---|---|---|---|---|---|---|'
  ]
  for (const r of records) {
    const calls = r.knowledgeCalls
      .map(
        (c) =>
          `${c.action}${c.project ? '@' + c.project : ''}${c.entries !== undefined ? `(${c.entries})` : ''}${c.isError ? '✗' : ''}`
      )
      .join(', ')
    const gates = r.gates
      .map((g) => `${g.action}:${g.review ? `审查${g.review}` : ''}${g.user ? `人${g.user}` : ''}`)
      .join(', ')
    const gone = r.sourceBefore.filter((p) => !r.sourceAfter.includes(p))
    const added = r.targetAfter.filter((p) => !r.targetBefore.includes(p))
    lines.push(
      `| ${r.scenario} | ${r.run} | ${r.seconds} | ${calls || '—'} | ${r.otherTools.join(', ') || '—'} | ${gates || '—'} | ${gone.join(' ') || '—'} | +${added.join(' ') || '无'} / 共 ${r.targetAfter.length} | ${r.movedToTrailers.length} |`
    )
  }
  lines.push('', '## 目标库条目的章', '')
  for (const r of records) {
    lines.push(`### ${r.scenario} #${r.run}`, '')
    for (const [path, s] of Object.entries(r.stamps)) {
      lines.push(`- ${path}: generated=${s.generated ?? '—'} verified=${s.verified ?? '—'}`)
    }
    lines.push('')
  }
  lines.push('## 最后一段回复', '')
  for (const r of records) {
    lines.push(
      `### ${r.scenario} #${r.run}`,
      '',
      '```text',
      r.lastReply.trim() || '(空)',
      '```',
      ''
    )
  }
  return lines.join('\n')
}

for (const scenario of SCENARIOS) {
  for (let run = 1; run <= RUNS; run++) {
    it(
      `${scenario} / #${run}`,
      async () => {
        const label = `${scenario}-r${run}`
        const debug = makeDebug(OUT)
        // deny：关掉自动审查，写入的询问才到得了模拟用户
        const app = (await launchApp({
          autoReview: scenario !== 'deny',
          env: { SHUVIX_E2E_STAGED_RESOURCES: stage.resources }
        })) as E2EApp
        let key = ''
        try {
          await waitRendererReady(app.main)
          key = await seedModel(app)
          await app.main.eval(
            `window.api.settings.set({ key: 'general.language', value: ${JSON.stringify(LANG)} })`
          )
          await installRealHomeGuard(app, REPO_ROOT)
          await installPolicy(app, 'probe-no-unconfined', NO_UNCONFINED_POLICY)
          const events: EventRecorder = eventRecorder(app.main)
          await events.install()

          const bigPath = join(app.home, 'code', 'big')
          const authPath = join(app.home, 'code', 'auth')
          for (const dir of [bigPath, authPath]) mkdirSync(dir, { recursive: true })
          const big = await createProject(app.main, { name: 'big', path: bigPath })
          const auth = await createProject(app.main, { name: 'auth', path: authPath })
          const sourceDir = baseDirOf(app, big.id)
          const targetDir = baseDirOf(app, auth.id)
          seedBase(sourceDir, BIG_BASE)
          seedBase(targetDir, AUTH_BASE)
          const sourceBefore = treeOf(sourceDir)
          const targetBefore = treeOf(targetDir)
          const targetTextBefore = Object.fromEntries(
            targetBefore.map((p) => [p, readFileSync(join(targetDir, p), 'utf8')])
          )

          const sid = await app.main.eval<string>(
            `window.api.session.create(${JSON.stringify(
              scenario === 'chat' ? { title: '新对话' } : { title: '新对话', projectId: auth.id }
            )}).then((s) => s.id)`
          )

          const started = Date.now()
          await sendPrompt(app, sid, promptOf(scenario))
          await settle({
            app,
            events,
            sid,
            label,
            answer: () => '按你的判断来。',
            debug,
            quietMs: 20_000,
            respond: (request, fallback) =>
              scenario === 'deny' &&
              request.toolName === 'knowledge' &&
              String(request.command ?? '').startsWith('Write(')
                ? { kind: 'ask', allowed: false }
                : fallback
          })

          const msgs = await app.main.eval<Msg[]>(`window.api.message.list(${JSON.stringify(sid)})`)
          const blocks = msgs.flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'tool'))
          const knowledgeCalls: KnowledgeCall[] = blocks
            .filter((b) => b.toolName === 'knowledge')
            .map((b) => {
              const args = b.args ?? {}
              return {
                action: String(args.action ?? '?'),
                ...(typeof args.project === 'string' ? { project: args.project } : {}),
                ...(typeof args.base === 'string' ? { base: args.base } : {}),
                ...(Array.isArray(args.entries) ? { entries: args.entries.length } : {}),
                isError: Boolean(b.isError)
              }
            })
          const targetAfter = treeOf(targetDir)
          const stamps: RunRecord['stamps'] = {}
          for (const path of targetAfter) {
            const text = readFileSync(join(targetDir, path), 'utf8')
            if (targetTextBefore[path] === text) continue
            stamps[path] = {
              generated: stampOf(text, 'generated'),
              verified: stampOf(text, 'verified')
            }
          }
          records.push({
            scenario,
            run,
            provider: PROVIDER,
            seconds: Math.round((Date.now() - started) / 1000),
            knowledgeCalls,
            otherTools: blocks
              .filter((b) => b.toolName !== 'knowledge')
              .map((b) => `${b.toolName}${b.isError ? '✗' : ''}`),
            gates: securityDecisions(app)
              .filter(
                (d) =>
                  d.sessionId === sid &&
                  d.toolName === 'knowledge' &&
                  d.objectKind === 'path' &&
                  d.effect !== 'allow'
              )
              .map((d) => ({
                action: d.action,
                effect: d.effect,
                ...(d.review ? { review: d.review.decision } : {}),
                ...(d.userResponse ? { user: d.userResponse } : {})
              })),
            sourceBefore,
            sourceAfter: treeOf(sourceDir),
            targetBefore,
            targetAfter,
            stamps,
            movedToTrailers: movedToTrailers(sourceDir),
            lastReply:
              [...msgs].reverse().find((m) => m.role === 'assistant' && (m.content || '').trim())
                ?.content ?? ''
          })
          const redact = (t: string): string => (key ? t.split(key).join('<redacted>') : t)
          const targetDump = targetAfter
            .map(
              (p) =>
                `## ${p}\n\n\`\`\`md\n${readFileSync(join(targetDir, p), 'utf8').trimEnd()}\n\`\`\``
            )
            .join('\n\n')
          writeFileSync(
            join(OUT, `${label}.txt`),
            redact(`${await transcriptOf(app, sid)}\n\n# 目标库最后的样子\n\n${targetDump}\n`)
          )
          writeFileSync(join(OUT, 'report.md'), redact(renderReport()))
          writeFileSync(join(OUT, 'results.json'), redact(JSON.stringify(records, null, 2)))
          console.log(`[${label}] done → ${OUT}`)
        } finally {
          await app.stop()
        }
      },
      25 * 60 * 1000
    )
  }
}
