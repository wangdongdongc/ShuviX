/**
 * 两面说同一句话：沙箱规格（受限命令实际能碰什么）与外部目录访问策略（文件工具问不问）出自同一份
 * 会话目录清单，所以**文件工具要问的，恰好就是受限命令碰不到的** —— 否则模型会学会走不问的那条路
 * （换成 `cat` / `echo >`，或者反过来）。
 *
 * 策略那一面走**真实**的桌面安全 provider（toolContext 的 getDesktopSecurityContext /
 * makeDesktopSecurityProvider：变量表里的 `vars.sessionDirs` / `vars.sessionReadDirs` 由沙箱管理器的
 * sessionDirsView 现算，extras 由 sessionDirExtras 现算，「允许并记住」来自会话设置的 allowList）+ 真实的
 * 内置策略 md（ask-on-external-path）。沙箱那一面用 buildSandboxSpec，喂的是 shellCommand 交给 planFor 的
 * 同一份 extras 与授权。
 *
 *  - PP-0 前提：provider 交给策略的两份清单就是规格里的 sessionDirs / sessionReadDirs；
 *  - PP-1 写的精确对偶：文件工具的写要问（ask-on-external-path#1）⇔ 受限命令写不了；
 *  - PP-2 读的精确对偶：文件工具的读要问（ask-on-external-path#0）⇔ 受限命令读不到 —— 两处有意的例外：
 *  - PP-3 cli-token 与家目录里的 ShuviX 程序目录：受限命令读得到（CLI 在沙箱里必须能用），文件工具的读照问；
 *  - PP-4 授权：读授权两面都只放读，写授权两面都放读写；
 *  - PP-5 extras：勾选的知识库两面都可读写；技能目录 / 内置知识库两面都只读（规则 #0 豁免 sessionReadDirs，#1 不）；
 *  - PP-6 不适合的工作目录（含「包含 userData」的 ~/Library）：两面都不把它当会话目录 —— 沙箱不套
 *    （命令逐条询问），文件工具在那里照问；PP-6b 不适合的写授权：沙箱不套，文件工具照样凭授权写；
 *  - PP-7 变量齐全：以上评估没有 fail-safe 告警。
 *
 * 替身：electron 的 app.getPath（userData）、os.homedir（按布局换家目录）、dao、sessionService、skillService
 * （外部目录与启用的技能根）、knowledge 的 enabledTargets（勾选的知识库）、policyService（内置策略读仓库里
 * 那一份，没有用户策略）、logger（收集告警）。sandbox 模块与 utils/paths 用真的。
 * 两种布局：生产（/Users/u）与 e2e（假家目录在 /private/tmp 下）。
 */
import { realpathSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  home: '/Users/u',
  userData: '/Users/u/Library/Application Support/ShuviX',
  /** 会话设置里的 allowList（「允许并记住」） */
  allowList: [] as string[],
  /** knowledge 的 enabledTargets：本会话勾选的知识库 */
  knowledgeTargets: [] as Array<{ name: string; target: { dir: string; readonly?: boolean } }>,
  /** skillService.enabledSkillRoots */
  skillRoots: [] as string[],
  warnings: [] as string[]
}))

vi.mock('electron', () => ({ app: { getPath: () => state.userData, isPackaged: false } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const mocked = { ...actual, homedir: () => state.home }
  return { ...mocked, default: mocked }
})
vi.mock('../../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: { pickSettings: () => ({ allowList: state.allowList }) }
}))
vi.mock('../../sessionService', () => ({
  sessionService: { getById: () => undefined, addAllowListPaths: () => {} }
}))
vi.mock('../../skillService', () => ({
  skillService: { listExternalDirs: () => [], enabledSkillRoots: () => state.skillRoots }
}))
vi.mock('../../knowledge/sessionBundle', () => ({
  enabledTargets: () => state.knowledgeTargets
}))
vi.mock('../../policyService', async () => {
  const { createInlinePolicyMdReader } =
    await import('@shuvix/agent-runtime/security/builtinPolicies/inlineSources')
  const readMd = createInlinePolicyMdReader()
  return {
    policyService: { getUserPolicies: () => [], readBuiltinPolicyMd: (f: string) => readMd(f) }
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
import {
  getDesktopSecurityContext,
  makeDesktopSecurityProvider,
  sessionDirExtras,
  type ProjectConfig
} from '../../toolContext'
import { isReadBlocked, isWriteBlocked } from '../classify'
import { buildSandboxSpec, isWithin, sessionDirsFor, sessionTmpName } from '../spec'
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
  'knowledge base ~/.shuvix/knowledge/b': (l) => `${l.shuvix}/knowledge/b`,
  'widget ~/.shuvix/widgets/w': (l) => `${l.shuvix}/widgets/w`,
  '/Volumes/data/proj (outside home)': () => '/Volumes/data/proj'
}

/** 「允许并记住」：家目录里一个读授权、家目录里与家目录外各一个写授权 */
const grantsOf = (l: Layout): string[] => [
  `Read(${l.home}/ref)`,
  `Write(${l.home}/w2)`,
  'Write(/Volumes/data/shared)'
]

/** 本会话的 extras：一个勾选的知识库（可读写）、只读的内置知识库、两个技能根 */
function arrangeExtras(l: Layout): void {
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
  state.allowList = []
  state.knowledgeTargets = []
  state.skillRoots = []
})

function enterLayout(l: Layout, allowList: string[] = []): void {
  state.home = l.home
  state.userData = l.userData
  state.allowList = allowList
  arrangeExtras(l)
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
  const config = { workingDirectory: ws } as ProjectConfig
  return makeDesktopSecurityProvider({ sessionId: SID }, () => config).getVars() as Record<
    string,
    unknown
  >
}

/** 沙箱那一面：shellCommand 交给 planFor 的同一份 extras 与授权 */
function grantsFromAllowList(): { grantedRead: string[]; grantedWrite: string[] } {
  const grantedRead: string[] = []
  const grantedWrite: string[] = []
  for (const entry of state.allowList) {
    const m = /^(Read|Write)\((.*)\)$/.exec(entry)
    if (m) (m[1] === 'Write' ? grantedWrite : grantedRead).push(m[2])
  }
  return { grantedRead, grantedWrite }
}

function specFor(l: Layout, ws: string): SandboxSpec {
  const built = buildSandboxSpec(
    l.host,
    {
      sessionId: SID,
      workingDirectory: ws,
      extras: sessionDirExtras(SID),
      ...grantsFromAllowList()
    },
    realLoose
  )
  if (!built.ok) throw new Error(built.reason)
  return built.spec
}

/** 语料：会话目录、extras、授权、ShuviX 自己的文件、凭据、家目录里的配置与缓存、家目录以外 */
function corpus(l: Layout, ws: string): string[] {
  const { home: h, shuvix: s, userData: u } = l
  return [
    // 工作目录（git 元数据与别家工具的配置不再受保护）
    `${ws}/src/a.ts`,
    `${ws}/.git/hooks/pre-commit`,
    `${ws}/.git/config`,
    `${ws}/.git`,
    `${ws}/.vscode/settings.json`,
    // 本会话的其他会话目录，与别的会话的
    `${TMP_DIR}/x`,
    `${TMP_ROOT}/0000aaaa/x`,
    `${s}/artifacts/${SID}/f`,
    `${s}/artifacts/other/f`,
    `${u}/tool_results/${SID}/x`,
    `${u}/tool_results/other/r.txt`,
    `${u}/temp_workspace/${SID}/a.txt`,
    `${u}/temp_workspace/OTHER/a.txt`,
    // extras
    `${s}/knowledge/notes/a.md`,
    `${s}/knowledge/other/a.md`,
    `${s}/skills/s/SKILL.md`,
    `${h}/my-skills/s/SKILL.md`,
    `${h}/dev/ShuviX/resources/knowledge/shuvix/en/policy-md.md`,
    // 授权
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
  enterLayout(l, grants === 'with grants' ? grantsOf(l) : [])
  const ws = WORKSPACES[wsName](l)
  return { l, ws, spec: specFor(l, ws), ctx: contextFor(ws) }
}

const brief = (d: SecurityDecision): { effect: string; winning: string; matched: string[] } => ({
  effect: d.effect,
  winning: d.winning,
  matched: d.matched
})

describe('PP-0 前提：provider 交给策略的会话目录就是规格里那两份', () => {
  it.each(variants)('PP-0 %s 布局 · %s · %s', (layout, wsName, grants) => {
    const { ws, spec } = arrange(layout, wsName, grants)
    const vars = varsFor(ws)
    expect(vars.sessionDirs).toEqual(spec.sessionDirs)
    expect(vars.sessionReadDirs).toEqual(spec.sessionReadDirs)
    expect(vars.home).toBe(spec.home)
    // extras 确实进来了（不是两份空清单碰巧相等）
    expect(spec.sessionDirs.length).toBeGreaterThan(4)
    expect(spec.sessionReadDirs.length).toBeGreaterThanOrEqual(3)
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
    enterLayout(l)
    const packaged: Layout = {
      ...l,
      appPaths: ['/Applications/ShuviX.app'],
      host: { ...l.host, appPaths: ['/Applications/ShuviX.app'] }
    }
    const ws = `${l.home}/proj`
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

describe('PP-4 授权：两面一样', () => {
  it.each(Object.keys(LAYOUTS) as LayoutName[])(
    'PP-4 %s 布局：读授权（家目录里）只放读；写授权放读写 —— 家目录里外都一样',
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

      // 没有授权时：同样的位置两面都拦
      const bare = arrange(layout, '~/proj', 'no grants')
      expect(bare.ctx.evaluate('read', { type: 'path', path: ref }).effect).toBe('ask')
      expect(isReadBlocked(bare.spec, ref)).toBe(true)
      expect(
        bare.ctx.evaluate('write', { type: 'path', path: '/Volumes/data/shared/x' }).effect
      ).toBe('ask')
      expect(isWriteBlocked(bare.spec, '/Volumes/data/shared/x')).toBe(true)
    }
  )
})

describe('PP-5 extras：勾选的知识库可读写；技能目录与内置知识库只读', () => {
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

  it('PP-5 extras 跟着会话里勾的东西走：取消勾选之后，两面一起收回', () => {
    const l = LAYOUTS.prod
    enterLayout(l)
    const ws = `${l.home}/proj`
    const kb = `${l.shuvix}/knowledge/notes/a.md`
    expect(contextFor(ws).evaluate('write', { type: 'path', path: kb }).effect).toBe('allow')
    expect(isWriteBlocked(specFor(l, ws), kb)).toBe(false)

    state.knowledgeTargets = []
    state.skillRoots = []
    expect(contextFor(ws).evaluate('write', { type: 'path', path: kb }).effect).toBe('ask')
    expect(isWriteBlocked(specFor(l, ws), kb)).toBe(true)
    expect(contextFor(ws).evaluate('read', { type: 'path', path: kb }).effect).toBe('ask')
    expect(isReadBlocked(specFor(l, ws), kb)).toBe(true)
  })
})

describe('PP-6 不适合的工作目录：两面都不把它当会话目录', () => {
  const UNSUITABLE: Record<string, (l: Layout) => string> = {
    '/': () => '/',
    'the home folder': (l) => l.home,
    'the parent of the home folder': (l) => dirname(l.home),
    '~/.shuvix': (l) => l.shuvix,
    '~/.shuvix/agents': (l) => `${l.shuvix}/agents`,
    userData: (l) => l.userData,
    "another session's temp workspace": (l) => `${l.userData}/temp_workspace/OTHER`,
    '~/Library (contains userData)': (l) => `${l.home}/Library`,
    '~/Library/Application Support (contains userData)': (l) =>
      `${l.home}/Library/Application Support`
  }
  const cases = (Object.keys(LAYOUTS) as LayoutName[]).flatMap((layout) =>
    Object.keys(UNSUITABLE).map((name) => [layout, name] as const)
  )

  it.each(cases)('PP-6 %s 布局 · 工作目录是 %s', (layout, name) => {
    const l = LAYOUTS[layout]
    enterLayout(l)
    const ws = UNSUITABLE[name](l)

    // 沙箱那一面：不套（命令逐条询问）
    const built = buildSandboxSpec(
      l.host,
      {
        sessionId: SID,
        workingDirectory: ws,
        extras: sessionDirExtras(SID),
        grantedRead: [],
        grantedWrite: []
      },
      realLoose
    )
    expect(built.ok).toBe(false)

    // 策略那一面：会话目录里没有工作目录，本会话其余的目录与 extras 照旧
    const vars = varsFor(ws)
    const expected = sessionDirsFor(
      l.host,
      { sessionId: SID, workingDirectory: ws, extras: sessionDirExtras(SID) },
      realLoose
    )!
    expect(expected.workspaceUnsuitable).not.toBeNull()
    expect(vars.sessionDirs).toEqual(expected.dirs)
    expect(vars.sessionReadDirs).toEqual(expected.readDirs)
    expect(vars.sessionDirs).not.toContain(realLoose(ws))
    expect(vars.sessionDirs).toEqual(
      expect.arrayContaining([TMP_DIR, `${l.shuvix}/artifacts/${SID}`])
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

describe('PP-6b 不合适的写授权：沙箱不套，文件工具照样凭授权写', () => {
  it.each(Object.keys(LAYOUTS) as LayoutName[])(
    'PP-6b %s 布局：写授权是 ~/Library（包含 userData）或在 ~/.shuvix/policies 里 —— 规格被拒（命令逐条询问）；文件工具在授权里读写不问',
    (layout) => {
      const l = LAYOUTS[layout]
      for (const grant of [`${l.home}/Library`, `${l.shuvix}/policies`]) {
        enterLayout(l, [`Write(${grant})`])
        const ws = `${l.home}/proj`
        const built = buildSandboxSpec(
          l.host,
          {
            sessionId: SID,
            workingDirectory: ws,
            extras: sessionDirExtras(SID),
            ...grantsFromAllowList()
          },
          realLoose
        )
        expect(built.ok, grant).toBe(false)
        expect(!built.ok && built.reason, grant).toMatch(/^a write grant /)
        // 策略那一面：授权照样有效；会话目录里照旧有工作目录（授权不是会话目录）
        const ctx = contextFor(ws)
        const target = `${grant}/x`
        expect(ctx.evaluate('write', { type: 'path', path: target }).effect, grant).toBe('allow')
        expect(ctx.evaluate('read', { type: 'path', path: target }).effect, grant).toBe('allow')
        expect(varsFor(ws).sessionDirs).toContain(ws)
        expect(varsFor(ws).sessionDirs).not.toContain(grant)
      }
    }
  )
})

describe('PP-7 变量齐全', () => {
  it('PP-7 以上评估没有 fail-safe / 变量缺失的告警', () => {
    // 本文件的用例按声明顺序跑在同一个 worker 里：此刻告警已经收齐
    for (const [layout, wsName, grants] of variants) {
      const { l, ws, ctx } = arrange(layout, wsName, grants)
      for (const path of corpus(l, ws).slice(0, 5)) {
        ctx.evaluate('read', { type: 'path', path })
        ctx.evaluate('write', { type: 'path', path })
      }
    }
    expect(state.warnings.filter((w) => /fail-safe|not provided|unavailable/i.test(w))).toEqual([])
  })
})
