/**
 * 两面说同一句话：沙箱规格（受限命令实际能碰什么）与外部目录访问策略（文件工具问不问）出自同一张
 * **会话权限表**（services/acl），所以**文件工具要问的，恰好就是受限命令碰不到的** —— 否则模型会学会走
 * 不问的那条路（换成 `cat` / `echo >`，或者反过来）。
 *
 * 两面都走真实的代码：
 *   - 权限表是真的 sessionAcl（内存会话那一边的存储，不起数据库）；派生行由真的 acl/derive.ts 按会话此刻的
 *     设置懒对账（工作目录与会话自己的目录经真的沙箱管理器 sessionOwnDirsView，勾选的知识库与技能目录经
 *     settingDirForAcl）；「允许并记住」经桌面 provider 的 persistGrant 写进表（询问卡片上那一步走的同一条路）；
 *   - 策略那一面是真实的桌面安全 provider（toolContext 的 getDesktopSecurityContext /
 *     makeDesktopSecurityProvider：`vars.aclRead` / `vars.aclWrite` 由 sessionAcl.pathView 现算）+ 真实的
 *     内置策略 md（ask-on-external-path）；
 *   - 沙箱那一面用 buildSandboxSpec，喂的是 shellCommand 交给 planFor 的同一份 sessionAcl.sandboxEntries。
 *
 *  - PP-0 前提：一张表、两个面 —— provider 交给策略的 aclWrite / aclRead 就是规格的可写根 / 可读根（可读根
 *    另加 ShuviX 自己的程序），表里确实有派生的四种行（与授予的行）；
 *  - PP-1 写的精确对偶：文件工具的写要问（ask-on-external-path#1）⇔ 受限命令写不了；
 *  - PP-2 读的精确对偶：文件工具的读要问（ask-on-external-path#0）⇔ 受限命令读不到 —— 两处有意的例外：
 *  - PP-3 cli-token 与家目录里的 ShuviX 程序目录：受限命令读得到（CLI 在沙箱里必须能用），文件工具的读照问；
 *  - PP-4 授予的行（「允许并记住」）：授予的读两面都只放读，授予的写两面都放读写；授予之后两面立即生效；
 *  - PP-5 知识库与技能：勾选的知识库两面都可读写；技能目录 / 内置知识库两面都只读（只在 aclRead 里）；
 *    取消勾选之后两面一起收回；
 *  - PP-6 不适合的工作目录（含「包含 userData」的 ~/Library、`temp_workspace` 本身、别的会话临时工作区里的
 *    子目录）：权限表里没有它那一行 —— 沙箱不套（命令逐条询问），文件工具在那里照问；PP-6b 不适合的
 *    授予的写：沙箱不套，文件工具照样凭授权写（授予的行在表里）；
 *  - PP-8 临时会话的 fork：工作目录正是别的会话的临时工作区（共用源会话的）—— 两面都把它当本会话的，
 *    本会话自己的与第三个会话的临时工作区两面都拦（PP-0..2 的工作目录表里也有这一行）；
 *  - PP-9 工作目录那一行改成只读（权限表面板上的开关）：两面一起变成只读，对账不把它改回去；改回可写两面一起放开；
 *  - PP-10 bot 会话自己的 bot 文件（派生的 bot 行，可写）：文件工具读写它都不问，同目录里别的 bot 文件、它旁边的
 *    `.bak` 照问；它在 ~/.shuvix 里却不让沙箱被拒（不过可写根检查），受限命令能写它、写不了它的邻居；
 *  - PP-11 bot 行改成只读：两面一起只读（写问 #1、读不问；沙箱照套，读得到、写不了）；
 *  - PP-7 变量齐全：以上评估没有 fail-safe / 对账失败的告警（放在最后，收齐前面所有用例的告警）。
 *
 * 替身：electron 的 app.getPath（userData）、os.homedir（按布局换家目录）、projectDao、sessionRecords（会话在、
 * 是内存会话、工作目录取 state）、sessionAclDao（内存会话用不到；桩掉免得连带打开数据库）、sessionService、
 * skillService（外部目录与启用的技能根）、knowledge 的 enabledTargets（勾选的知识库）、policyService（内置策略读
 * 仓库里那一份，没有用户策略）、logger（收集告警）。sandbox 模块、acl、utils/paths 用真的。
 * 两种布局：生产（/Users/u）与 e2e（假家目录在 /private/tmp 下）。
 */
import { realpathSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  home: '/Users/u',
  userData: '/Users/u/Library/Application Support/ShuviX',
  /** 会话的工作目录（sessionWorkdir 经 sessionRecords 取） */
  ws: '/Users/u/proj',
  /** knowledge 的 enabledTargets：本会话勾选的知识库 */
  knowledgeTargets: [] as Array<{ name: string; target: { dir: string; readonly?: boolean } }>,
  /** skillService.enabledSkillRoots */
  skillRoots: [] as string[],
  /** 这条会话绑定的 bot 文件（主进程注入的 setAclBotFile 来源；null = 不是 bot 会话） */
  botFile: null as string | null,
  warnings: [] as string[]
}))

vi.mock('electron', () => ({ app: { getPath: () => state.userData, isPackaged: false } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const mocked = { ...actual, homedir: () => state.home }
  return { ...mocked, default: mocked }
})
vi.mock('../../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
// 会话在（权限表只给存在的会话）、是内存会话（权限表走内存那一边）、不属于项目，工作目录在设置里
vi.mock('../../sessionRecords', () => ({
  sessionRecords: {
    pick: (id: string) => ({ id, projectId: null, settings: { workingDirectory: state.ws } }),
    pickSettings: () => ({ workingDirectory: state.ws }),
    isEphemeral: () => true
  }
}))
vi.mock('../../../dao/sessionAclDao', () => ({ sessionAclDao: {} }))
vi.mock('../../sessionService', () => ({
  sessionService: { getById: () => undefined }
}))
vi.mock('../../skillService', () => ({
  skillService: {
    listExternalDirs: () => [],
    listSharedDirs: () => [],
    enabledSkillRoots: () => state.skillRoots
  }
}))
vi.mock('../../knowledge/sessionBundle', () => ({
  enabledTargets: () => state.knowledgeTargets
}))
vi.mock('../../policyService', async () => {
  const { createInlinePolicyMdReader } =
    await import('@shuvix/agent-runtime/security/builtinPolicies/inlineSources')
  const readMd = createInlinePolicyMdReader()
  return {
    policyService: {
      getUserPolicies: () => [],
      readBuiltinPolicyMd: (f: string) => readMd(f),
      isDisabled: () => false
    }
  }
})
vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (msg: unknown) => void state.warnings.push(String(msg))
  })
}))

import type { SecurityContext, SecurityDecision } from '@shuvix/agent-runtime'
import { pathAclView } from '@shuvix/chat-protocol/sessionAcl'
import { sessionAcl, setAclBotFile, setAclSkillRoots } from '../../acl'

// 用户启用的技能目录由主进程注入（acl 不反向依赖 skillService）：与上面 skillService 替身同一份
setAclSkillRoots(() => state.skillRoots)
// bot 会话自己的 bot 文件同样由主进程注入（sessionService.ownBotFile）：缺省不是 bot 会话
setAclBotFile(() => state.botFile)
import { clearMemoryAclForTests } from '../../acl/store'
import {
  getDesktopSecurityContext,
  makeDesktopSecurityProvider,
  type ProjectConfig
} from '../../toolContext'
import { isReadBlocked, isWriteBlocked } from '../classify'
import {
  buildSandboxSpec,
  isWithin,
  sessionOwnDirs,
  sessionTmpName,
  type SpecResult
} from '../spec'
import type { SandboxHostPaths, SandboxSpec } from '../types'

const SID = 'sess-1'
const UID = process.getuid?.() ?? 0
const TMP_ROOT = `/private/tmp/shuvix-${UID}`
const TMP_DIR = `${TMP_ROOT}/${sessionTmpName(SID)}`

/** 与管理器同义的 realpath：不存在的部分按最近的已存在祖先拼回 */
function realLoose(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync.native(abs)
  } catch {
    const parent = dirname(abs)
    if (parent === abs) return abs
    return join(realLoose(parent), basename(abs))
  }
}

interface Layout {
  home: string
  userData: string
  shuvix: string
  /** 家目录里的 ShuviX 程序目录（开发态：仓库在家目录里） */
  appPaths: string[]
  host: SandboxHostPaths
}

function layoutOf(home: string): Layout {
  const userData = `${home}/Library/Application Support/ShuviX`
  const shuvix = `${home}/.shuvix`
  const appPaths = [`${home}/dev/ShuviX/out/main`, `${home}/dev/ShuviX/resources/cli`]
  return {
    home,
    userData,
    shuvix,
    appPaths,
    host: {
      home,
      userData,
      shuvixHome: shuvix,
      toolResultsBase: `${userData}/tool_results`,
      uid: UID,
      cliSocket: `${shuvix}/cli.sock`,
      cliToken: `${shuvix}/cli-token`,
      appPaths,
      tmpRoot: TMP_ROOT
    }
  }
}

const LAYOUTS = {
  prod: layoutOf('/Users/u'),
  e2e: layoutOf('/private/tmp/shuvix-e2e-x')
} as const
type LayoutName = keyof typeof LAYOUTS

/** 适合当会话目录的工作目录 */
const WORKSPACES: Record<string, (l: Layout) => string> = {
  '~/proj': (l) => `${l.home}/proj`,
  '~/Documents/a/proj': (l) => `${l.home}/Documents/a/proj`,
  'temp workspace': (l) => `${l.userData}/temp_workspace/${SID}`,
  "another session's temp workspace (a temp fork's)": (l) => `${l.userData}/temp_workspace/OTHER`,
  'knowledge base ~/.shuvix/knowledge/b': (l) => `${l.shuvix}/knowledge/b`,
  'widget ~/.shuvix/widgets/w': (l) => `${l.shuvix}/widgets/w`,
  '/Volumes/data/proj (outside home)': () => '/Volumes/data/proj'
}

type Grant = ['read' | 'write', string]

/** 「允许并记住」：家目录里一个读，家目录里与家目录外各一个写 */
const grantsOf = (l: Layout): Grant[] => [
  ['read', `${l.home}/ref`],
  ['write', `${l.home}/w2`],
  ['write', '/Volumes/data/shared']
]

/** 本会话的设置：一个勾选的知识库（可读写）、只读的内置知识库、两个技能根 */
function arrangeSettings(l: Layout): void {
  state.knowledgeTargets = [
    { name: 'notes', target: { dir: `${l.shuvix}/knowledge/notes` } },
    {
      name: 'shuvix',
      target: { dir: `${l.home}/dev/ShuviX/resources/knowledge/shuvix/en`, readonly: true }
    }
  ]
  state.skillRoots = [`${l.shuvix}/skills`, `${l.home}/my-skills`]
}

beforeEach(() => {
  state.knowledgeTargets = []
  state.skillRoots = []
  state.botFile = null
})

/** 桌面 provider（与 contextFor 里的同一个构造） */
function providerFor(ws: string): ReturnType<typeof makeDesktopSecurityProvider> {
  const config = { workingDirectory: ws } as ProjectConfig
  return makeDesktopSecurityProvider({ sessionId: SID }, () => config)
}

/**
 * 进入一个布局：会话的工作目录与设置换掉，权限表从空开始（下一次读时按设置派生），再把「允许并记住」
 * 经 provider 的 persistGrant 写进去
 */
function enterLayout(l: Layout, ws: string, grants: Grant[] = []): void {
  state.home = l.home
  state.userData = l.userData
  state.ws = ws
  arrangeSettings(l)
  clearMemoryAclForTests()
  sessionAcl.forgetReconciled()
  const provider = providerFor(ws)
  for (const [mode, path] of grants) provider.persistGrant!(mode, path)
}

/** 文件工具那一面：真实的桌面安全 context（agent 主体） */
function contextFor(ws: string): SecurityContext {
  const config = { workingDirectory: ws } as ProjectConfig
  return getDesktopSecurityContext(
    { sessionId: SID, requestUserInput: async () => ({ kind: 'cancel' }) as never },
    () => config
  )
}

/** provider 交给策略的变量表 */
function varsFor(ws: string): Record<string, unknown> {
  return providerFor(ws).getVars() as Record<string, unknown>
}

/** 沙箱那一面：shellCommand 交给 planFor 的同一份权限表行 */
function buildFor(l: Layout, ws: string): SpecResult {
  return buildSandboxSpec(
    l.host,
    { sessionId: SID, workingDirectory: ws, entries: sessionAcl.sandboxEntries(SID) },
    realLoose
  )
}

function specFor(l: Layout, ws: string): SandboxSpec {
  const built = buildFor(l, ws)
  if (!built.ok) throw new Error(built.reason)
  return built.spec
}

const listVar = (vars: Record<string, unknown>, name: string): string[] => {
  const value = vars[name]
  expect(Array.isArray(value), name).toBe(true)
  return value as string[]
}

/** 语料：会话自己的目录、知识库与技能、授予的行、ShuviX 自己的文件、凭据、家目录里的配置与缓存、家目录以外 */
function corpus(l: Layout, ws: string): string[] {
  const { home: h, shuvix: s, userData: u } = l
  return [
    // 工作目录（git 元数据与别家工具的配置不再受保护）
    `${ws}/src/a.ts`,
    `${ws}/.git/hooks/pre-commit`,
    `${ws}/.git/config`,
    `${ws}/.git`,
    `${ws}/.vscode/settings.json`,
    // 本会话自己的其他目录，与别的会话的
    `${TMP_DIR}/x`,
    `${TMP_ROOT}/0000aaaa/x`,
    `${s}/artifacts/${SID}/f`,
    `${s}/artifacts/other/f`,
    `${u}/tool_results/${SID}/x`,
    `${u}/tool_results/other/r.txt`,
    `${u}/temp_workspace/${SID}/a.txt`,
    `${u}/temp_workspace/OTHER/a.txt`,
    `${u}/temp_workspace/THIRD/a.txt`,
    // 知识库与技能
    `${s}/knowledge/notes/a.md`,
    `${s}/knowledge/other/a.md`,
    `${s}/skills/s/SKILL.md`,
    `${h}/my-skills/s/SKILL.md`,
    `${h}/dev/ShuviX/resources/knowledge/shuvix/en/policy-md.md`,
    // 授予的行
    `${h}/ref/a.txt`,
    `${h}/w2/x`,
    '/Volumes/data/shared/x',
    // ShuviX 自己的文件与数据
    `${s}/x`,
    `${s}/policies/p.md`,
    `${s}/agents/a.md`,
    `${s}/.session-state`,
    `${s}/cli.sock`,
    `${u}/data/db`,
    `${u}/x`,
    // 凭据、家目录里的配置与缓存
    `${h}/.ssh/id_ed25519`,
    `${h}/.ssh/config`,
    `${h}/.aws/credentials`,
    `${h}/.config/gh/hosts.yml`,
    `${h}/.gitconfig`,
    `${h}/.zshrc`,
    `${h}/.npm/x`,
    `${h}/Library/Caches/pip/x`,
    `${h}/Library/LaunchAgents/x.plist`,
    `${h}/Documents/a.txt`,
    `${h}/other`,
    h,
    // 家目录以外
    '/etc/hosts',
    '/private/etc/hosts',
    '/private/tmp/x',
    '/tmp/x',
    '/Volumes/x/y',
    '/opt/homebrew/bin/node',
    '/Applications/ShuviX.app/Contents/MacOS/ShuviX'
  ]
}

/** 有意的不对称：受限命令读得到、文件工具的读照问 —— cli-token 与家目录里的 ShuviX 程序目录 */
function readAsymmetry(l: Layout, path: string): boolean {
  return (
    path === l.host.cliToken || l.appPaths.some((a) => isWithin(path, a) && isWithin(path, l.home))
  )
}

const variants = (Object.keys(LAYOUTS) as LayoutName[]).flatMap((layout) =>
  Object.keys(WORKSPACES).flatMap((wsName) =>
    (['no grants', 'with grants'] as const).map((grants) => [layout, wsName, grants] as const)
  )
)

function arrange(
  layout: LayoutName,
  wsName: string,
  grants: 'no grants' | 'with grants'
): { l: Layout; ws: string; spec: SandboxSpec; ctx: SecurityContext } {
  const l = LAYOUTS[layout]
  const ws = WORKSPACES[wsName](l)
  enterLayout(l, ws, grants === 'with grants' ? grantsOf(l) : [])
  return { l, ws, spec: specFor(l, ws), ctx: contextFor(ws) }
}

const brief = (d: SecurityDecision): { effect: string; winning: string; matched: string[] } => ({
  effect: d.effect,
  winning: d.winning,
  matched: d.matched
})

describe('PP-0 前提：一张权限表、两个面', () => {
  it.each(variants)('PP-0 %s 布局 · %s · %s', (layout, wsName, grants) => {
    const { l, ws, spec } = arrange(layout, wsName, grants)
    const vars = varsFor(ws)
    const aclRead = listVar(vars, 'aclRead')
    const aclWrite = listVar(vars, 'aclWrite')
    // 策略的两张目录表就是权限表的路径视图（写隐含读）；沙箱拿到的是同样的行
    const entries = sessionAcl.entries(SID)
    expect({ read: aclRead, write: aclWrite }).toEqual(pathAclView(entries))
    expect(sessionAcl.sandboxEntries(SID).map((e) => e.path)).toEqual(entries.map((e) => e.target))
    // 规格的可写根 = aclWrite；可读根 = aclRead + ShuviX 自己的程序（都按解析后的路径）
    expect(spec.writableRoots).toEqual(aclWrite.map(realLoose))
    expect(spec.readableRoots).toEqual([...aclRead, ...l.host.appPaths].map(realLoose))
    expect(vars.home).toBe(spec.home)
    // 表里确实有派生的四种行（不是两张空表碰巧相等）；授予的行只在「允许并记住」之后才有
    const sources = new Set(entries.map((e) => e.source))
    for (const source of ['workdir', 'system', 'knowledge', 'skill'] as const) {
      expect(sources.has(source), source).toBe(true)
    }
    expect(sources.has('user')).toBe(grants === 'with grants')
    expect(aclWrite.length).toBeGreaterThan(4)
    expect(aclRead.length - aclWrite.length).toBeGreaterThanOrEqual(3)
  })
})

describe('PP-1 写的精确对偶：文件工具的写要问 ⇔ 受限命令写不了', () => {
  it.each(variants)('PP-1 %s 布局 · %s · %s', (layout, wsName, grants) => {
    const { l, ws, spec, ctx } = arrange(layout, wsName, grants)
    let asked = 0
    let allowed = 0
    for (const path of corpus(l, ws)) {
      const decision = ctx.evaluate('write', { type: 'path', path })
      const blocked = isWriteBlocked(spec, path)
      if (blocked) {
        asked++
        expect({ path, ...brief(decision) }).toEqual({
          path,
          effect: 'ask',
          winning: 'ask-on-external-path#1',
          matched: ['ask-on-external-path#1']
        })
      } else {
        allowed++
        expect({ path, ...brief(decision) }).toEqual({
          path,
          effect: 'allow',
          winning: expect.any(String),
          matched: []
        })
      }
    }
    // 语料两边都覆盖到了
    expect(asked).toBeGreaterThan(10)
    expect(allowed).toBeGreaterThan(5)
  })
})

describe('PP-2 读的精确对偶：文件工具的读要问 ⇔ 受限命令读不到（除 PP-3 的两处）', () => {
  it.each(variants)('PP-2 %s 布局 · %s · %s', (layout, wsName, grants) => {
    const { l, ws, spec, ctx } = arrange(layout, wsName, grants)
    let asked = 0
    let allowed = 0
    for (const path of corpus(l, ws)) {
      const decision = ctx.evaluate('read', { type: 'path', path })
      const blocked = isReadBlocked(spec, path)
      const fileToolAsks = blocked || readAsymmetry(l, path)
      if (fileToolAsks) {
        asked++
        expect({ path, ...brief(decision) }).toEqual({
          path,
          effect: 'ask',
          winning: 'ask-on-external-path#0',
          matched: ['ask-on-external-path#0']
        })
      } else {
        allowed++
        expect({ path, ...brief(decision) }).toEqual({
          path,
          effect: 'allow',
          winning: expect.any(String),
          matched: []
        })
      }
    }
    expect(asked).toBeGreaterThan(10)
    expect(allowed).toBeGreaterThan(5)
  })
})

describe('PP-3 有意的不对称：受限命令读得到、文件工具的读照问', () => {
  it.each(Object.keys(LAYOUTS) as LayoutName[])(
    'PP-3 %s 布局：cli-token —— 命令读得到（沙箱里的 shuvix CLI 要鉴权）、文件工具的读要问；写两面都不行',
    (layout) => {
      const { l, spec, ctx } = arrange(layout, '~/proj', 'no grants')
      const token = l.host.cliToken
      expect(isReadBlocked(spec, token)).toBe(false)
      expect(brief(ctx.evaluate('read', { type: 'path', path: token }))).toMatchObject({
        effect: 'ask',
        winning: 'ask-on-external-path#0'
      })
      expect(isWriteBlocked(spec, token)).toBe(true)
      expect(ctx.evaluate('write', { type: 'path', path: token }).effect).toBe('ask')
      // 只是这一个文件：它旁边的照样两面都拦
      expect(isReadBlocked(spec, `${l.shuvix}/cli-token2`)).toBe(true)
    }
  )

  it.each(Object.keys(LAYOUTS) as LayoutName[])(
    'PP-3 %s 布局：家目录里的 ShuviX 程序目录（开发态）—— 命令读得到、文件工具的读要问；写两面都不行',
    (layout) => {
      const { l, spec, ctx } = arrange(layout, '~/proj', 'no grants')
      const cliJs = `${l.appPaths[0]}/cli.js`
      expect(isReadBlocked(spec, cliJs)).toBe(false)
      expect(ctx.evaluate('read', { type: 'path', path: cliJs }).effect).toBe('ask')
      expect(isWriteBlocked(spec, cliJs)).toBe(true)
      expect(ctx.evaluate('write', { type: 'path', path: cliJs }).effect).toBe('ask')
    }
  )

  it('PP-3 对照：打包后的程序在家目录以外（应用包里）—— 两面都读得到，没有不对称', () => {
    const l = LAYOUTS.prod
    const ws = `${l.home}/proj`
    enterLayout(l, ws)
    const packaged: Layout = {
      ...l,
      appPaths: ['/Applications/ShuviX.app'],
      host: { ...l.host, appPaths: ['/Applications/ShuviX.app'] }
    }
    const spec = specFor(packaged, ws)
    const ctx = contextFor(ws)
    const exe = '/Applications/ShuviX.app/Contents/MacOS/ShuviX'
    expect(isReadBlocked(spec, exe)).toBe(false)
    expect(brief(ctx.evaluate('read', { type: 'path', path: exe }))).toMatchObject({
      effect: 'allow',
      matched: []
    })
    expect(isWriteBlocked(spec, exe)).toBe(true)
    expect(ctx.evaluate('write', { type: 'path', path: exe }).effect).toBe('ask')
  })
})

describe('PP-4 授予的行（「允许并记住」）：两面一样', () => {
  it.each(Object.keys(LAYOUTS) as LayoutName[])(
    'PP-4 %s 布局：授予的读（家目录里）只放读；授予的写放读写 —— 家目录里外都一样',
    (layout) => {
      const { l, spec, ctx } = arrange(layout, '~/proj', 'with grants')
      const ref = `${l.home}/ref/a.txt`
      expect(ctx.evaluate('read', { type: 'path', path: ref }).effect).toBe('allow')
      expect(isReadBlocked(spec, ref)).toBe(false)
      expect(ctx.evaluate('write', { type: 'path', path: ref }).effect).toBe('ask')
      expect(isWriteBlocked(spec, ref)).toBe(true)

      for (const w of [`${l.home}/w2/x`, '/Volumes/data/shared/x']) {
        expect(ctx.evaluate('read', { type: 'path', path: w }).effect, w).toBe('allow')
        expect(isReadBlocked(spec, w), w).toBe(false)
        expect(ctx.evaluate('write', { type: 'path', path: w }).effect, w).toBe('allow')
        expect(isWriteBlocked(spec, w), w).toBe(false)
      }

      // 没有授予的行时：同样的位置两面都拦
      const bare = arrange(layout, '~/proj', 'no grants')
      expect(bare.ctx.evaluate('read', { type: 'path', path: ref }).effect).toBe('ask')
      expect(isReadBlocked(bare.spec, ref)).toBe(true)
      expect(
        bare.ctx.evaluate('write', { type: 'path', path: '/Volumes/data/shared/x' }).effect
      ).toBe('ask')
      expect(isWriteBlocked(bare.spec, '/Volumes/data/shared/x')).toBe(true)
    }
  )

  it('PP-4 授予之后两面立即生效：同一个（整会话复用的）context 下一次评估就不问，命令下一次就读得到', () => {
    const l = LAYOUTS.prod
    const ws = `${l.home}/proj`
    enterLayout(l, ws)
    const ctx = contextFor(ws)
    const ref = `${l.home}/ref/a.txt`
    expect(ctx.evaluate('read', { type: 'path', path: ref }).effect).toBe('ask')
    expect(isReadBlocked(specFor(l, ws), ref)).toBe(true)

    providerFor(ws).persistGrant!('read', `${l.home}/ref`)
    expect(ctx.evaluate('read', { type: 'path', path: ref }).effect).toBe('allow')
    expect(isReadBlocked(specFor(l, ws), ref)).toBe(false)
    // 授予的读不顺带放写
    expect(ctx.evaluate('write', { type: 'path', path: ref }).effect).toBe('ask')
    expect(isWriteBlocked(specFor(l, ws), ref)).toBe(true)

    // 同一路径再授予写：合并成一行可写（读 + 写 = 写），两面都放写
    providerFor(ws).persistGrant!('write', `${l.home}/ref`)
    expect(sessionAcl.entries(SID).filter((e) => e.source === 'user')).toHaveLength(1)
    expect(ctx.evaluate('write', { type: 'path', path: ref }).effect).toBe('allow')
    expect(isWriteBlocked(specFor(l, ws), ref)).toBe(false)
  })
})

describe('PP-5 知识库与技能：勾选的知识库可读写；技能目录与内置知识库只读', () => {
  it.each(Object.keys(LAYOUTS) as LayoutName[])('PP-5 %s 布局', (layout) => {
    const { l, spec, ctx } = arrange(layout, '~/proj', 'no grants')
    const kb = `${l.shuvix}/knowledge/notes/a.md`
    expect(ctx.evaluate('read', { type: 'path', path: kb }).effect).toBe('allow')
    expect(ctx.evaluate('write', { type: 'path', path: kb }).effect).toBe('allow')
    expect(isReadBlocked(spec, kb)).toBe(false)
    expect(isWriteBlocked(spec, kb)).toBe(false)

    for (const ro of [
      `${l.shuvix}/skills/s/SKILL.md`,
      `${l.home}/my-skills/s/references/x.md`,
      `${l.home}/dev/ShuviX/resources/knowledge/shuvix/en/policy-md.md`
    ]) {
      expect(brief(ctx.evaluate('read', { type: 'path', path: ro })), ro).toMatchObject({
        effect: 'allow',
        matched: []
      })
      expect(isReadBlocked(spec, ro), ro).toBe(false)
      expect(brief(ctx.evaluate('write', { type: 'path', path: ro })), ro).toMatchObject({
        effect: 'ask',
        winning: 'ask-on-external-path#1'
      })
      expect(isWriteBlocked(spec, ro), ro).toBe(true)
    }

    // 没勾的知识库：两面都拦
    const other = `${l.shuvix}/knowledge/other/a.md`
    expect(ctx.evaluate('read', { type: 'path', path: other }).effect).toBe('ask')
    expect(isReadBlocked(spec, other)).toBe(true)
  })

  it('PP-5 知识库与技能跟着会话里勾的东西走：取消勾选之后（下一次读表时对账），两面一起收回', () => {
    const l = LAYOUTS.prod
    const ws = `${l.home}/proj`
    enterLayout(l, ws)
    const kb = `${l.shuvix}/knowledge/notes/a.md`
    const skill = `${l.shuvix}/skills/s/SKILL.md`
    expect(contextFor(ws).evaluate('write', { type: 'path', path: kb }).effect).toBe('allow')
    expect(isWriteBlocked(specFor(l, ws), kb)).toBe(false)
    expect(contextFor(ws).evaluate('read', { type: 'path', path: skill }).effect).toBe('allow')

    state.knowledgeTargets = []
    state.skillRoots = []
    expect(contextFor(ws).evaluate('write', { type: 'path', path: kb }).effect).toBe('ask')
    expect(isWriteBlocked(specFor(l, ws), kb)).toBe(true)
    expect(contextFor(ws).evaluate('read', { type: 'path', path: kb }).effect).toBe('ask')
    expect(isReadBlocked(specFor(l, ws), kb)).toBe(true)
    expect(contextFor(ws).evaluate('read', { type: 'path', path: skill }).effect).toBe('ask')
    expect(isReadBlocked(specFor(l, ws), skill)).toBe(true)
    expect(sessionAcl.entries(SID).some((e) => e.source === 'knowledge')).toBe(false)
  })
})

describe('PP-6 不适合的工作目录：权限表里没有它那一行', () => {
  const UNSUITABLE: Record<string, (l: Layout) => string> = {
    '/': () => '/',
    'the home folder': (l) => l.home,
    'the parent of the home folder': (l) => dirname(l.home),
    '~/.shuvix': (l) => l.shuvix,
    '~/.shuvix/agents': (l) => `${l.shuvix}/agents`,
    userData: (l) => l.userData,
    'temp_workspace itself': (l) => `${l.userData}/temp_workspace`,
    "a subfolder of another session's temp workspace": (l) =>
      `${l.userData}/temp_workspace/OTHER/sub`,
    '~/Library (contains userData)': (l) => `${l.home}/Library`,
    '~/Library/Application Support (contains userData)': (l) =>
      `${l.home}/Library/Application Support`
  }
  const cases = (Object.keys(LAYOUTS) as LayoutName[]).flatMap((layout) =>
    Object.keys(UNSUITABLE).map((name) => [layout, name] as const)
  )

  it.each(cases)('PP-6 %s 布局 · 工作目录是 %s', (layout, name) => {
    const l = LAYOUTS[layout]
    const ws = UNSUITABLE[name](l)
    enterLayout(l, ws)

    // 沙箱那一面：不套（命令逐条询问）
    const built = buildFor(l, ws)
    expect(built.ok).toBe(false)
    expect(!built.ok && built.reason).toMatch(/^working directory /)

    // 权限表：没有工作目录那一行，会话自己的三个目录与知识库照旧
    const own = sessionOwnDirs(l.host, { sessionId: SID, workingDirectory: ws }, realLoose)!
    expect(own.workspaceUnsuitable).not.toBeNull()
    expect(sessionAcl.entries(SID).some((e) => e.source === 'workdir')).toBe(false)
    const aclWrite = listVar(varsFor(ws), 'aclWrite')
    expect(aclWrite.slice(0, 3)).toEqual([own.tmp, own.artifacts, own.toolResults])
    expect(aclWrite).not.toContain(ws)
    expect(aclWrite).not.toContain(realLoose(ws))
    expect(aclWrite).toEqual(
      expect.arrayContaining([
        TMP_DIR,
        `${l.shuvix}/artifacts/${SID}`,
        `${l.shuvix}/knowledge/notes`
      ])
    )

    // 文件工具在工作目录里照问：写恒问，读在家目录里才问
    const ctx = contextFor(ws)
    const inside = `${ws === '/' ? '' : ws}/some-file`
    expect(brief(ctx.evaluate('write', { type: 'path', path: inside }))).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-external-path#1'
    })
    expect(ctx.evaluate('read', { type: 'path', path: inside }).effect).toBe(
      isWithin(inside, l.home) ? 'ask' : 'allow'
    )
    // 本会话临时目录照样不问
    expect(ctx.evaluate('write', { type: 'path', path: `${TMP_DIR}/x` }).effect).toBe('allow')
  })
})

describe('PP-6b 不合适的授予的写：沙箱不套，文件工具照样凭授权写', () => {
  it.each(Object.keys(LAYOUTS) as LayoutName[])(
    'PP-6b %s 布局：授予的写是 ~/Library（包含 userData）或在 ~/.shuvix/policies 里 —— 规格被拒（命令逐条询问）；文件工具在授权里读写不问',
    (layout) => {
      const l = LAYOUTS[layout]
      const ws = `${l.home}/proj`
      for (const grant of [`${l.home}/Library`, `${l.shuvix}/policies`]) {
        enterLayout(l, ws, [['write', grant]])
        const built = buildFor(l, ws)
        expect(built.ok, grant).toBe(false)
        expect(!built.ok && built.reason, grant).toMatch(/^a write grant /)
        // 策略那一面：授权照样有效 —— 它是表里一行授予的写，工作目录那一行照旧在
        const ctx = contextFor(ws)
        const target = `${grant}/x`
        expect(ctx.evaluate('write', { type: 'path', path: target }).effect, grant).toBe('allow')
        expect(ctx.evaluate('read', { type: 'path', path: target }).effect, grant).toBe('allow')
        const aclWrite = listVar(varsFor(ws), 'aclWrite')
        expect(aclWrite).toContain(ws)
        expect(aclWrite).toContain(grant)
        expect(
          sessionAcl.entries(SID).find((e) => e.target === grant),
          grant
        ).toMatchObject({ source: 'user', access: 'write' })
      }
    }
  )
})

describe('PP-8 临时会话的 fork：工作目录正是别的会话的临时工作区', () => {
  const rows = (Object.keys(LAYOUTS) as LayoutName[]).flatMap((layout) =>
    (['no grants', 'with grants'] as const).map((grants) => [layout, grants] as const)
  )

  it.each(rows)(
    'PP-8 %s 布局 · %s：它里面的文件两面都放行；本会话自己的与第三个会话的临时工作区两面都拦（读 #0、写 #1）',
    (layout, grants) => {
      const { l, ws, spec, ctx } = arrange(
        layout,
        "another session's temp workspace (a temp fork's)",
        grants
      )
      expect(ws).toBe(`${l.userData}/temp_workspace/OTHER`)
      // 一张表、两个面：它是工作目录那一行，排在可写根最前
      expect(sessionAcl.entries(SID).find((e) => e.source === 'workdir')?.target).toBe(ws)
      expect(listVar(varsFor(ws), 'aclWrite').map(realLoose)).toEqual(spec.writableRoots)
      expect(spec.writableRoots[0]).toBe(ws)

      for (const path of [`${ws}/a.txt`, `${ws}/sub/b.txt`]) {
        expect(brief(ctx.evaluate('read', { type: 'path', path })), path).toMatchObject({
          effect: 'allow',
          matched: []
        })
        expect(brief(ctx.evaluate('write', { type: 'path', path })), path).toMatchObject({
          effect: 'allow',
          matched: []
        })
        expect(isReadBlocked(spec, path), path).toBe(false)
        expect(isWriteBlocked(spec, path), path).toBe(false)
      }

      for (const path of [
        `${l.userData}/temp_workspace/${SID}/a.txt`,
        `${l.userData}/temp_workspace/THIRD/a.txt`
      ]) {
        expect(brief(ctx.evaluate('read', { type: 'path', path })), path).toEqual({
          effect: 'ask',
          winning: 'ask-on-external-path#0',
          matched: ['ask-on-external-path#0']
        })
        expect(brief(ctx.evaluate('write', { type: 'path', path })), path).toEqual({
          effect: 'ask',
          winning: 'ask-on-external-path#1',
          matched: ['ask-on-external-path#1']
        })
        expect(isReadBlocked(spec, path), path).toBe(true)
        expect(isWriteBlocked(spec, path), path).toBe(true)
      }
    }
  )
})

describe('PP-9 工作目录那一行改成只读：两面一起只读', () => {
  it.each(Object.keys(LAYOUTS) as LayoutName[])(
    'PP-9 %s 布局：读两面都不拦、写两面都拦（沙箱照套）；设置变了重新对账也不改回去；改回可写两面一起放开',
    (layout) => {
      const l = LAYOUTS[layout]
      const ws = `${l.home}/proj`
      enterLayout(l, ws)
      const ctx = contextFor(ws)
      const file = `${ws}/src/a.ts`
      const workdirRow = sessionAcl.entries(SID).find((e) => e.source === 'workdir')!
      expect(workdirRow).toMatchObject({ target: ws, access: 'write' })

      expect(sessionAcl.setAccess(SID, workdirRow.id, 'read')).toBe(true)
      const expectReadOnly = (): void => {
        const spec = specFor(l, ws)
        expect(brief(ctx.evaluate('read', { type: 'path', path: file }))).toMatchObject({
          effect: 'allow',
          matched: []
        })
        expect(isReadBlocked(spec, file)).toBe(false)
        expect(brief(ctx.evaluate('write', { type: 'path', path: file }))).toEqual({
          effect: 'ask',
          winning: 'ask-on-external-path#1',
          matched: ['ask-on-external-path#1']
        })
        expect(isWriteBlocked(spec, file)).toBe(true)
        // 会话自己的目录照旧可写
        expect(ctx.evaluate('write', { type: 'path', path: `${TMP_DIR}/x` }).effect).toBe('allow')
        expect(isWriteBlocked(spec, `${TMP_DIR}/x`)).toBe(false)
      }
      expectReadOnly()

      // 设置变了（取消勾选一个知识库）：对账重来一遍，工作目录那一行保留用户改的访问方式
      state.knowledgeTargets = state.knowledgeTargets.slice(1)
      expectReadOnly()
      expect(sessionAcl.entries(SID).some((e) => e.source === 'knowledge')).toBe(true)
      expect(
        sessionAcl
          .entries(SID)
          .filter((e) => e.source === 'knowledge')
          .map((e) => e.sourceKey)
      ).toEqual(['shuvix'])

      expect(sessionAcl.setAccess(SID, workdirRow.id, 'write')).toBe(true)
      expect(ctx.evaluate('write', { type: 'path', path: file }).effect).toBe('allow')
      expect(isWriteBlocked(specFor(l, ws), file)).toBe(false)
    }
  )
})

describe('PP-10 bot 会话自己的 bot 文件：两面都可写，同目录里别的照拦', () => {
  it.each(Object.keys(LAYOUTS) as LayoutName[])(
    'PP-10 %s 布局：读写它不问、受限命令能写它；别的 bot 文件与它的 .bak 两面都拦；规格不因它在 ~/.shuvix 里被拒',
    (layout) => {
      const l = LAYOUTS[layout]
      const ws = `${l.home}/proj`
      const bot = `${l.shuvix}/bots/scout.md`
      state.botFile = bot
      enterLayout(l, ws)
      const ctx = contextFor(ws)

      const row = sessionAcl.entries(SID).find((e) => e.source === 'bot')
      expect(row).toMatchObject({ kind: 'path', target: realLoose(bot), access: 'write' })

      // 文件工具那一面：它自己读写都不问
      expect(brief(ctx.evaluate('write', { type: 'path', path: bot }))).toMatchObject({
        effect: 'allow',
        matched: []
      })
      expect(brief(ctx.evaluate('read', { type: 'path', path: bot }))).toMatchObject({
        effect: 'allow',
        matched: []
      })
      // 同一目录里别的 bot 文件、它旁边的备份：照问（读 #0、写 #1）
      for (const path of [`${l.shuvix}/bots/other.md`, `${bot}.bak`]) {
        expect(brief(ctx.evaluate('write', { type: 'path', path })), path).toEqual({
          effect: 'ask',
          winning: 'ask-on-external-path#1',
          matched: ['ask-on-external-path#1']
        })
        expect(brief(ctx.evaluate('read', { type: 'path', path })), path).toEqual({
          effect: 'ask',
          winning: 'ask-on-external-path#0',
          matched: ['ask-on-external-path#0']
        })
      }

      // 沙箱那一面：它在 ~/.shuvix 里，但不过可写根检查 —— 规格照常，它是可写根之一
      const built = buildFor(l, ws)
      expect(built.ok, !built.ok ? built.reason : '').toBe(true)
      const spec = specFor(l, ws)
      expect(spec.writableRoots).toContain(realLoose(bot))
      expect(isWriteBlocked(spec, bot)).toBe(false)
      expect(isReadBlocked(spec, bot)).toBe(false)
      for (const path of [`${l.shuvix}/bots/other.md`, `${bot}.bak`]) {
        expect(isWriteBlocked(spec, path), path).toBe(true)
        expect(isReadBlocked(spec, path), path).toBe(true)
      }
      // 一张表、两个面
      expect(spec.writableRoots).toEqual(listVar(varsFor(ws), 'aclWrite').map(realLoose))
    }
  )
})

describe('PP-11 bot 行改成只读：两面一起只读', () => {
  it.each(Object.keys(LAYOUTS) as LayoutName[])(
    'PP-11 %s 布局：写两面都拦（#1）、读两面都不拦；沙箱照套',
    (layout) => {
      const l = LAYOUTS[layout]
      const ws = `${l.home}/proj`
      const bot = `${l.shuvix}/bots/scout.md`
      state.botFile = bot
      enterLayout(l, ws)
      const ctx = contextFor(ws)
      const row = sessionAcl.entries(SID).find((e) => e.source === 'bot')!
      expect(sessionAcl.setAccess(SID, row.id, 'read')).toBe(true)

      expect(brief(ctx.evaluate('write', { type: 'path', path: bot }))).toEqual({
        effect: 'ask',
        winning: 'ask-on-external-path#1',
        matched: ['ask-on-external-path#1']
      })
      expect(brief(ctx.evaluate('read', { type: 'path', path: bot }))).toMatchObject({
        effect: 'allow',
        matched: []
      })

      const built = buildFor(l, ws)
      expect(built.ok, !built.ok ? built.reason : '').toBe(true)
      const spec = specFor(l, ws)
      expect(spec.writableRoots).not.toContain(realLoose(bot))
      expect(spec.readableRoots).toContain(realLoose(bot))
      expect(isReadBlocked(spec, bot)).toBe(false)
      expect(isWriteBlocked(spec, bot)).toBe(true)
    }
  )
})

describe('PP-7 变量齐全', () => {
  it('PP-7 以上评估没有 fail-safe / 变量缺失 / 对账失败的告警', () => {
    // 本文件的用例按声明顺序跑在同一个 worker 里：此刻告警已经收齐
    for (const [layout, wsName, grants] of variants) {
      const { l, ws, ctx } = arrange(layout, wsName, grants)
      for (const path of corpus(l, ws).slice(0, 5)) {
        ctx.evaluate('read', { type: 'path', path })
        ctx.evaluate('write', { type: 'path', path })
      }
    }
    expect(
      state.warnings.filter((w) => /fail-safe|not provided|unavailable|reconcile failed/i.test(w))
    ).toEqual([])
  })
})
