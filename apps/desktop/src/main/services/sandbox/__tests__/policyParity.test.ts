/**
 * 两面说同一句话：沙箱规格（命令实际能碰什么）与策略变量（文件工具问不问）同源，
 * 所以**文件工具免询问的地方，受限命令一定也能碰**——否则模型会学会走不问的那条路。
 *
 * 规格 buildSandboxSpec → 视图 toPolicyView → 作为 vars（连同常规桌面变量）喂给**真实**的
 * 内置策略（agent-runtime createSecurityContext 的 evaluate，与生产同一条装配 + 求值路径）。
 *
 *  - PP-1 写的健全性：write 判 allow ⇒ !isWriteBlocked(spec, p)；并钉住已知的「策略比沙箱严」
 *    的方向（安全方向，实现方已接受）；
 *  - PP-2 读的健全性：read 判 allow ⇒ !isReadBlocked(spec, p)；
 *  - PP-3 沙箱没套上（INACTIVE_VIEW）、只剩工作区写入视图：免询问的写仍 ⇒ !isWriteBlocked(spec, p)，
 *    而且只落在工作区或本会话 artifacts 里（工作区豁免绝不放过沙箱会拒写的位置）；
 *  - PP-4 同一情形下，沙箱视图才放行的临时目录与工具缓存照问。
 *
 * 语料：CL-3 / CL-4 / CL-6 用到的路径 + SP-9 的正则路径，按几种工作区与两种布局（生产 / e2e）各跑一遍。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', isPackaged: false } }))

import {
  createSecurityContext,
  type SecurityContext,
  type SecurityHostProvider
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import { isReadBlocked, isWriteBlocked } from '../classify'
import {
  buildSandboxSpec,
  isWithin,
  protectedWritePatterns,
  sessionTmpName,
  toPolicyView
} from '../spec'
import {
  INACTIVE_VIEW,
  type SandboxHostPaths,
  type SandboxSessionInput,
  type SandboxSpec,
  type SessionSandboxView
} from '../types'

const SID = 'sess-1'
const READ_MD = createInlinePolicyMdReader()

function hostPaths(home: string): SandboxHostPaths {
  return {
    home,
    userData: `${home}/Library/Application Support/ShuviX`,
    shuvixHome: `${home}/.shuvix`,
    uid: 501,
    cliSocket: `${home}/.shuvix/cli.sock`,
    tmpRoot: '/private/tmp/shuvix-501'
  }
}

const LAYOUTS = {
  prod: hostPaths('/Users/u'),
  e2e: hostPaths('/private/tmp/shuvix-e2e-x')
} as const
type Layout = keyof typeof LAYOUTS

/** 工作区变体（相对家目录；temp = 本会话临时工作区） */
const WORKSPACES: Record<string, (p: SandboxHostPaths) => string> = {
  'project ~/proj': (p) => `${p.home}/proj`,
  'project ~/Documents/proj': (p) => `${p.home}/Documents/proj`,
  'temp workspace': (p) => `${p.userData}/temp_workspace/${SID}`,
  'knowledge base ~/.shuvix/knowledge/b': (p) => `${p.shuvixHome}/knowledge/b`
}

function specFor(paths: SandboxHostPaths, over: Partial<SandboxSessionInput>): SandboxSpec {
  const result = buildSandboxSpec(
    paths,
    { sessionId: SID, workingDirectory: '', grantedWrite: [], grantedRead: [], ...over },
    (x) => x
  )
  if (!result.ok) throw new Error(result.reason)
  return result.spec
}

/**
 * 生产 getVars 的形状：常规桌面变量 + 沙箱视图（缺省是套上时的 toPolicyView；PP-3 / PP-4 换成
 * INACTIVE_VIEW —— 设置关着、探测没过、Linux 上的会话）+ 工作区写入视图
 */
function contextFor(
  paths: SandboxHostPaths,
  spec: SandboxSpec,
  autoAllow = false,
  view: SessionSandboxView = toPolicyView(spec, `${paths.shuvixHome}/cli-token`)
): SecurityContext {
  const provider: SecurityHostProvider = {
    host: 'desktop',
    pathSep: '/',
    getVars: () => ({
      workspace: spec.workingDirectory,
      toolResultsBase: `${paths.userData}/tool_results`,
      skillsDirs: [
        `${paths.shuvixHome}/skills`,
        '/Applications/ShuviX.app/Contents/Resources/skills'
      ],
      memoryDirs: [`${paths.shuvixHome}/memory`],
      botsDir: `${paths.shuvixHome}/bots`,
      builtinKnowledgeDir: '/Applications/ShuviX.app/Contents/Resources/knowledge',
      sessionArtifactsDir: `${paths.shuvixHome}/artifacts/${SID}`,
      home: paths.home,
      systemDirs: [],
      // ShuviX 自己的规矩所在（protect-shuvix-config）
      shuvixConfigDirs: ['policies', 'agents', 'hooks', 'skills'].map(
        (d) => `${paths.shuvixHome}/${d}`
      ),
      // 与沙箱开没开无关的工作区写入视图（生产 workspaceWriteView 在非 Windows 上给的就是这一组）
      workspaceWritable: [spec.workingDirectory],
      workspaceWriteDenied: spec.writeDeniedFinal,
      workspaceProtectedPatterns: protectedWritePatterns(spec),
      ...view
    }),
    getSessionGrants: () => ({ autoAllow, allowList: [] }),
    readBuiltinPolicyMd: READ_MD,
    logger: { warn: (msg: string) => warnings.push(msg), info: () => {}, error: () => {} }
  } as SecurityHostProvider
  return createSecurityContext(
    { kind: 'agent', sessionId: SID, agentKind: 'root' },
    { host: 'desktop', platform: 'darwin' },
    provider
  )
}

const warnings: string[] = []

/** 语料：计划里 CL-3 / CL-4 / CL-6 与 SP-9 用到的路径，按布局与工作区换算 */
function corpus(p: SandboxHostPaths, ws: string): string[] {
  const h = p.home
  const s = p.shuvixHome
  const u = p.userData
  return [
    // CL-3
    `${h}/other`,
    `${ws}/.vscode/settings.json`,
    `${ws}/.git/hooks/pre-commit`,
    `${ws}/.GIT/config`,
    `${h}/.zshrc`,
    `/private/tmp/shuvix-ssh-501/x`,
    `/private/tmp/com.apple.launchd.x/y`,
    `${h}/Documents/a.txt`,
    `${h}/.ssh/id_ed25519`,
    `${u}/data/x`,
    `${u}/x`,
    `${ws}/.mcp.json`,
    `${s}/x`,
    `${s}/policies/p.md`,
    `${s}/agents/a.md`,
    // CL-4
    `${ws}/src/a.ts`,
    '/private/tmp/x',
    `${u}/tool_results/${SID}/x`,
    `${h}/Documents/proj/x`,
    '/private/tmp/r/.git/config',
    // CL-6
    `${s}/artifacts/${SID}/f`,
    `${s}/artifacts/other/f`,
    `${u}/temp_workspace/${SID}/a.txt`,
    `${s}/widgets/w/f`,
    `${s}/widgets/w/.claude/x`,
    `${h}/.ssh/config`,
    `${h}/Documents/ref/a.txt`,
    `${h}/Documents/other.txt`,
    '/private/etc/hosts',
    `${s}/.session-state/k`,
    `${s}/cli-token`,
    `${u}/data/db`,
    `${u}/tool_results/other/r.txt`,
    `${ws}/.git`,
    `${ws}/.git/info/exclude`,
    `${ws}/sub/.vscode/x`,
    `${ws}/sub/.mcp.json`,
    '/private/tmp/clone/.git/config',
    `${h}/.npm/x`,
    `${h}/Library/Caches/pip/x`,
    `${p.tmpRoot}/${sessionTmpName(SID)}/x`,
    `${h}/.config/fish/config.fish`,
    `${h}/.config/gh/hosts.yml`,
    `${h}/Library/LaunchAgents/x.plist`,
    `${h}/Library/Mail/x`,
    // SP-9（放到工作区下）
    `${ws}/.git/hooks`,
    `${ws}/.git/config.worktree`,
    `${ws}/.git/commondir`,
    `${ws}/a/b/.git/config`,
    `${ws}/.git/modules/m/config`,
    `${ws}/.git/modules/a/modules/b/hooks/x`,
    `${ws}/.git/worktrees/wt/config.worktree`,
    `${ws}/.git/HEAD`,
    `${ws}/.git/config.lock`,
    `${ws}/.github/workflows/ci.yml`,
    `${ws}/.gitignore`,
    `${ws}/.git/refs/heads/config`,
    `${ws}/sub/.Git`,
    '/private/tmp/com.apple.launchd.AbC/Listeners',
    '/private/tmp/com.apple.launchdX'
  ]
}

const variants = (Object.keys(LAYOUTS) as Layout[]).flatMap((layout) =>
  Object.keys(WORKSPACES).map((wsName) => [layout, wsName] as const)
)

describe('PP-1 写的健全性：文件工具免询问的写，受限命令一定也写得了', () => {
  it.each(variants)('PP-1 %s 布局 · %s', (layout, wsName) => {
    const paths = LAYOUTS[layout]
    const ws = WORKSPACES[wsName](paths)
    const spec = specFor(paths, { workingDirectory: ws })
    const ctx = contextFor(paths, spec)
    const violations: string[] = []
    let allowed = 0
    for (const path of corpus(paths, ws)) {
      const decision = ctx.evaluate('write', { type: 'path', path })
      if (decision.effect !== 'allow') continue
      allowed++
      if (isWriteBlocked(spec, path)) violations.push(`${path} (${decision.winning})`)
    }
    expect(violations).toEqual([])
    // 语料确实覆盖到了免询问的一侧（不是全都在问）
    expect(allowed).toBeGreaterThan(3)
  })

  it('PP-1 严格方向（钉住）：git 元数据正则在策略里全局生效 —— 工作区外 clone 的 .git/config 策略要问，沙箱放行', () => {
    const paths = LAYOUTS.prod
    const spec = specFor(paths, { workingDirectory: `${paths.home}/proj` })
    const ctx = contextFor(paths, spec)
    const path = '/private/tmp/clone/.git/config'
    expect(ctx.evaluate('write', { type: 'path', path })).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-write#0'
    })
    expect(isWriteBlocked(spec, path)).toBe(false)
  })

  it('PP-1 e2e 布局的临时工作区：沙箱视图把 userData 列进写拒（它落在 /private/tmp 根里），但工作区写入视图放行工作区本身 —— write 与 bash 两面一致', () => {
    // 2026-09-28 之前这条钉的是「write 要问而 bash 能写」的严格方向；与沙箱无关的工作区写入视图
    // 把工作区本身放回来之后，两面一致了
    const paths = LAYOUTS.e2e
    const ws = `${paths.userData}/temp_workspace/${SID}`
    const spec = specFor(paths, { workingDirectory: ws })
    const ctx = contextFor(paths, spec)
    const path = `${ws}/a.txt`
    expect(ctx.evaluate('write', { type: 'path', path }).effect).toBe('allow')
    expect(isWriteBlocked(spec, path)).toBe(false)
    // 生产布局下同一种会话两面一致：都放行
    const prod = LAYOUTS.prod
    const prodWs = `${prod.userData}/temp_workspace/${SID}`
    const prodSpec = specFor(prod, { workingDirectory: prodWs })
    expect(
      contextFor(prod, prodSpec).evaluate('write', { type: 'path', path: `${prodWs}/a.txt` }).effect
    ).toBe('allow')
    expect(isWriteBlocked(prodSpec, `${prodWs}/a.txt`)).toBe(false)
  })
})

describe('PP-2 读的健全性：文件工具免询问的读，受限命令一定也读得到', () => {
  it.each(variants)('PP-2 %s 布局 · %s', (layout, wsName) => {
    const paths = LAYOUTS[layout]
    const ws = WORKSPACES[wsName](paths)
    const spec = specFor(paths, { workingDirectory: ws })
    const ctx = contextFor(paths, spec)
    const violations: string[] = []
    let allowed = 0
    for (const path of corpus(paths, ws)) {
      const decision = ctx.evaluate('read', { type: 'path', path })
      if (decision.effect !== 'allow') continue
      allowed++
      if (isReadBlocked(spec, path)) violations.push(`${path} (${decision.winning})`)
    }
    expect(violations).toEqual([])
    expect(allowed).toBeGreaterThan(3)
  })

  it('PP-2 视图的放回覆盖了凭据目录（读授权 ~/.ssh —— 生产的 sessionView 不带授权，这里钉住策略的第二道防线）：ask-on-read 不命中，protect-credentials 照问', () => {
    // 计划原用 ws=~/.config；那样的工作区现在直接不套沙箱（严格包含 ~/.config/gh，见 SP-1）
    const paths = LAYOUTS.prod
    const spec = specFor(paths, {
      workingDirectory: `${paths.home}/proj`,
      grantedRead: [`${paths.home}/.ssh`]
    })
    const ctx = contextFor(paths, spec)
    const path = `${paths.home}/.ssh/config`
    const decision = ctx.evaluate('read', { type: 'path', path })
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('protect-credentials#1')
    expect(decision.matched).not.toContain('ask-on-read#0')
    expect(isReadBlocked(spec, path)).toBe(true)
  })

  it('PP-2 策略变量齐全：以上评估没有 fail-safe 告警', () => {
    expect(warnings.filter((w) => /fail-safe|not provided/i.test(w))).toEqual([])
  })
})

describe('PP-3 / PP-4 沙箱没套上、只剩工作区写入视图', () => {
  /** 沙箱视图换成 INACTIVE_VIEW；工作区写入视图照生产 workspaceWriteView 从同一份规格算 */
  const workspaceOnly = (paths: SandboxHostPaths, spec: SandboxSpec): SecurityContext =>
    contextFor(paths, spec, false, INACTIVE_VIEW)

  it.each(variants)(
    'PP-3 %s 布局 · %s：免询问的写受限命令一定也写得了，且都在工作区或本会话 artifacts 里',
    (layout, wsName) => {
      const paths = LAYOUTS[layout]
      const ws = WORKSPACES[wsName](paths)
      const spec = specFor(paths, { workingDirectory: ws })
      const ctx = workspaceOnly(paths, spec)
      const artifacts = `${paths.shuvixHome}/artifacts/${SID}`
      const warningsBefore = warnings.length
      const blocked: string[] = []
      const escaped: string[] = []
      let allowed = 0
      for (const path of corpus(paths, ws)) {
        const decision = ctx.evaluate('write', { type: 'path', path })
        if (decision.effect !== 'allow') continue
        allowed++
        if (isWriteBlocked(spec, path)) blocked.push(`${path} (${decision.winning})`)
        if (!isWithin(path, spec.workingDirectory) && !isWithin(path, artifacts)) {
          escaped.push(`${path} (${decision.winning})`)
        }
      }
      expect(blocked).toEqual([])
      expect(escaped).toEqual([])
      expect(allowed).toBeGreaterThan(0)
      // 工作区里的普通源码确实走了豁免（不是整片都在问）
      expect(ctx.evaluate('write', { type: 'path', path: `${ws}/src/a.ts` }).effect).toBe('allow')
      // 变量齐全：没有 fail-safe 告警
      expect(
        warnings.slice(warningsBefore).filter((w) => /fail-safe|not provided/i.test(w))
      ).toEqual([])
    }
  )

  it.each(variants)(
    'PP-4 %s 布局 · %s：/private/tmp 与 ~/.npm 照问（它们只归沙箱视图豁免，沙箱套上时才放行）',
    (layout, wsName) => {
      const paths = LAYOUTS[layout]
      const ws = WORKSPACES[wsName](paths)
      const spec = specFor(paths, { workingDirectory: ws })
      const inactive = workspaceOnly(paths, spec)
      const active = contextFor(paths, spec)
      for (const path of ['/private/tmp/x', `${paths.home}/.npm/x`]) {
        expect({
          path,
          inactive: inactive.evaluate('write', { type: 'path', path })
        }).toMatchObject({ path, inactive: { effect: 'ask', winning: 'ask-on-write#0' } })
        // 对照：同一份规格、沙箱视图套上时这两处不问 —— 放行它们的只是沙箱视图
        expect({ path, active: active.evaluate('write', { type: 'path', path }).effect }).toEqual({
          path,
          active: 'allow'
        })
      }
    }
  )
})
