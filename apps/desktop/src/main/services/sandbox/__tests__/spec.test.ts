/**
 * 沙箱规格（spec.ts）—— 纯函数：会话 → 规格、规格 → 策略变量。
 *
 *  - SP-1/SP-2 哪些会话不套沙箱（逐条询问）、哪些套得上（按路径段边界判）；
 *  - SP-3/SP-4 写的四层：可写根 → 整片拒写 → 放回 → 最后一层（凭据 / 沙箱外会执行的位置 / 根顶层的别家配置）；
 *  - SP-5 读的四层与 socket；
 *  - SP-6 `real` 在一切判断之前应用；
 *  - SP-7 策略那一面（toPolicyView）与规格同源；
 *  - SP-8/SP-9 清单守卫与正则语义（JS 方言 = SBPL 文本）；
 *  - SP-10 受保护模式（protectedWritePatterns）：沙箱视图与工作区写入视图共用的那一组。
 *
 * 夹具宿主（见测试计划 Conventions）：home=/Users/u，userData 在 ~/Library/Application Support/ShuviX，
 * 工作区 /Users/u/proj；e2e 布局把假 HOME 放在 /private/tmp 下（它本身是可写根，几处结论不同）。
 */
import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'

// spec.ts → utils/paths 会连带 import electron（只在调用时才用 app）
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', isPackaged: false } }))

import {
  buildSandboxSpec,
  isWithin,
  protectedWritePatterns,
  sessionTmpName,
  toPolicyView
} from '../spec'
import {
  CACHE_DIRS_HOME_RELATIVE,
  CREDENTIAL_DIRS_HOME_RELATIVE,
  EXECUTED_LATER_HOME_RELATIVE,
  GIT_ENTRY_PATTERN,
  GIT_PATTERNS,
  LAUNCHD_TMP_PATTERN,
  PERSONAL_DIRS_HOME_RELATIVE,
  ROOT_PROTECTED_NAMES
} from '../tables'
import type { SandboxHostPaths, SandboxSessionInput, SandboxSpec } from '../types'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'

const HOME = '/Users/u'
const USER_DATA = '/Users/u/Library/Application Support/ShuviX'
const SHUVIX = '/Users/u/.shuvix'
const SID = 'sess-1'
const WS = '/Users/u/proj'
const TMP_ROOT = '/private/tmp/shuvix-501'

const PATHS: SandboxHostPaths = {
  home: HOME,
  userData: USER_DATA,
  shuvixHome: SHUVIX,
  uid: 501,
  cliSocket: '/Users/u/.shuvix/cli.sock',
  tmpRoot: TMP_ROOT
}

/** e2e 布局：假 HOME 在 /private/tmp 下 */
const E2E_HOME = '/private/tmp/shuvix-e2e-x'
const E2E_PATHS: SandboxHostPaths = {
  home: E2E_HOME,
  userData: `${E2E_HOME}/Library/Application Support/ShuviX`,
  shuvixHome: `${E2E_HOME}/.shuvix`,
  uid: 501,
  cliSocket: `${E2E_HOME}/.shuvix/cli.sock`,
  tmpRoot: TMP_ROOT
}

const identity = (p: string): string => p

function input(over: Partial<SandboxSessionInput> = {}): SandboxSessionInput {
  return { sessionId: SID, workingDirectory: WS, grantedWrite: [], grantedRead: [], ...over }
}

function build(
  over: Partial<SandboxSessionInput> = {},
  paths: SandboxHostPaths = PATHS,
  real: (p: string) => string = identity
): ReturnType<typeof buildSandboxSpec> {
  return buildSandboxSpec(paths, input(over), real)
}

/** 必须套得上的会话：返回规格 */
function specOf(
  over: Partial<SandboxSessionInput> = {},
  paths: SandboxHostPaths = PATHS,
  real: (p: string) => string = identity
): SandboxSpec {
  const result = build(over, paths, real)
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
  return result.spec
}

const h = (rel: string, home = HOME): string => `${home}/${rel}`
const TMP_DIR = `${TMP_ROOT}/${sessionTmpName(SID)}`
const ARTIFACTS = `${SHUVIX}/artifacts/${SID}`
const TEMP_WS = `${USER_DATA}/temp_workspace/${SID}`

describe('SP-1 不套沙箱的会话（契约 4）：一律 {ok:false} 并说明原因', () => {
  const cases: Array<[string, Partial<SandboxSessionInput>, string]> = [
    ['会话 id 为空', { sessionId: '' }, 'unsafe session id'],
    ['会话 id 是 ..', { sessionId: '..' }, 'unsafe session id'],
    ['会话 id 带 /', { sessionId: 'a/b' }, 'unsafe session id'],
    ['会话 id 含 ..', { sessionId: 'x..y' }, 'unsafe session id'],
    ['工作区是 /', { workingDirectory: '/' }, 'working directory covers the home folder'],
    ['工作区就是家目录', { workingDirectory: HOME }, 'working directory covers the home folder'],
    ['工作区是 /Users', { workingDirectory: '/Users' }, 'working directory covers the home folder'],
    ['写授权是 /', { grantedWrite: ['/'] }, 'a write grant covers the home folder'],
    ['写授权是家目录', { grantedWrite: [HOME] }, 'a write grant covers the home folder'],
    ['写授权是 /Users', { grantedWrite: ['/Users'] }, 'a write grant covers the home folder'],
    ['工作区是 ~/.shuvix', { workingDirectory: SHUVIX }, "ShuviX's own configuration"],
    [
      '工作区是 ~/.shuvix/agents',
      { workingDirectory: `${SHUVIX}/agents` },
      "ShuviX's own configuration"
    ],
    [
      '工作区是 ~/.shuvix/knowledgeX（同前缀兄弟，不是内容目录）',
      { workingDirectory: `${SHUVIX}/knowledgeX` },
      "ShuviX's own configuration"
    ],
    ['工作区是 userData', { workingDirectory: USER_DATA }, 'application data'],
    [
      '工作区是 userData/tool_results',
      { workingDirectory: `${USER_DATA}/tool_results` },
      'application data'
    ],
    [
      '工作区是别的会话的临时工作区',
      { workingDirectory: `${USER_DATA}/temp_workspace/OTHER` },
      'application data'
    ],
    ['工作区是 ~/.ssh', { workingDirectory: h('.ssh') }, 'credential directory'],
    ['工作区在 ~/.ssh 里', { workingDirectory: h('.ssh/k') }, 'credential directory'],
    ['工作区是 ~/.config/gh', { workingDirectory: h('.config/gh') }, 'credential directory'],
    // 根**严格包含**敏感目录（实现后改动：放回根会把里面的邮件、钥匙串、ShuviX 数据一起放出来）
    [
      '工作区是 ~/Library（包含个人资料目录）',
      { workingDirectory: h('Library') },
      `working directory contains ${h('Library/Mobile Documents')}`
    ],
    [
      '工作区是 ~/.config（包含 ~/.config/gh）',
      { workingDirectory: h('.config') },
      `working directory contains ${h('.config/gh')}`
    ],
    [
      '工作区是 ~/Library/Application Support（包含 AddressBook 与 userData）',
      { workingDirectory: h('Library/Application Support') },
      'working directory contains'
    ],
    [
      '写授权是 ~/Library',
      { grantedWrite: [h('Library')] },
      `a write grant contains ${h('Library/Mobile Documents')}`
    ],
    [
      '写授权是 ~/.config',
      { grantedWrite: [h('.config')] },
      `a write grant contains ${h('.config/gh')}`
    ]
  ]
  it.each(cases)('%s', (_label, over, reason) => {
    const result = build(over)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain(reason)
  })
})

describe('SP-2 套得上的工作区（按路径段边界判）', () => {
  const accepted: Array<[string, Partial<SandboxSessionInput>]> = [
    ['~/.shuvix/knowledge 里的库', { workingDirectory: `${SHUVIX}/knowledge/b` }],
    [
      '~/.shuvix/knowledge-shuvix 里的项目库',
      { workingDirectory: `${SHUVIX}/knowledge-shuvix/projects/p` }
    ],
    ['~/.shuvix/widgets 里的 widget', { workingDirectory: `${SHUVIX}/widgets/w` }],
    ['本会话的 artifacts', { workingDirectory: ARTIFACTS }],
    ['本会话的临时工作区', { workingDirectory: TEMP_WS }],
    ['本会话临时工作区的子目录', { workingDirectory: `${TEMP_WS}/sub` }],
    ['~/.sshfoo（段边界：不是 ~/.ssh）', { workingDirectory: h('.sshfoo') }],
    ['~/Documents 里的项目', { workingDirectory: h('Documents/proj') }],
    // 根**等于**个人资料目录不算包含（那是用户选的项目）
    ['工作区就是 ~/Documents', { workingDirectory: h('Documents') }],
    ['外接卷', { workingDirectory: '/Volumes/x' }],
    ['读授权等于家目录（只有写授权会被拒）', { grantedRead: [HOME] }],
    ['读授权是 /', { grantedRead: ['/'] }],
    ['写授权恰好等于凭据目录（等于不算包含）', { grantedWrite: [h('.ssh')] }],
    ['写授权恰好等于 ~/Library/LaunchAgents', { grantedWrite: [h('Library/LaunchAgents')] }]
  ]
  it.each(accepted)('%s', (_label, over) => {
    const result = build(over)
    expect(result.ok, !result.ok ? result.reason : '').toBe(true)
  })
})

describe('SP-3 可写根与临时目录', () => {
  it('SP-3 tmpDir = tmpRoot/<sha256(id) 前 8 位>；稳定、不同 id 不同', () => {
    const expected = createHash('sha256').update(SID).digest('hex').slice(0, 8)
    expect(sessionTmpName(SID)).toBe(expected)
    expect(sessionTmpName(SID)).toMatch(/^[0-9a-f]{8}$/)
    expect(sessionTmpName(SID)).toBe(sessionTmpName(SID))
    expect(sessionTmpName('sess-2')).not.toBe(sessionTmpName(SID))
    expect(specOf().tmpDir).toBe(`${TMP_ROOT}/${expected}`)
  })

  it('SP-3 writableRoots 恰为 [ws, tmpDir, /private/tmp, …19 个缓存（清单顺序）, 本会话 artifacts, …写授权]', () => {
    expect(CACHE_DIRS_HOME_RELATIVE).toHaveLength(19)
    const grant = '/Volumes/data/shared'
    const spec = specOf({ grantedWrite: [grant] })
    expect(spec.writableRoots).toEqual([
      WS,
      TMP_DIR,
      '/private/tmp',
      ...CACHE_DIRS_HOME_RELATIVE.map((d) => h(d)),
      ARTIFACTS,
      grant
    ])
  })

  it('SP-3 去重：等于工作区的写授权只出现一次；writeDenied 恰为 [~/.shuvix, userData]', () => {
    const spec = specOf({ grantedWrite: [WS, WS] })
    expect(spec.writableRoots.filter((r) => r === WS)).toHaveLength(1)
    expect(spec.writableRoots).toHaveLength(3 + 19 + 1)
    expect(spec.writeDenied).toEqual([SHUVIX, USER_DATA])
  })
})

describe('SP-4 放回、最后一层、git 根', () => {
  it('SP-4 项目会话：writeAllowBack 只有本会话 artifacts', () => {
    expect(specOf().writeAllowBack).toEqual([ARTIFACTS])
  })

  it('SP-4 临时工作区会话：writeAllowBack = [ws, artifacts]', () => {
    expect(specOf({ workingDirectory: TEMP_WS }).writeAllowBack).toEqual([TEMP_WS, ARTIFACTS])
  })

  it('SP-4 ~/.shuvix 内容目录里的写授权被放回；policies 等配置目录里的写授权**不**放回（实现后改动）', () => {
    const widget = `${SHUVIX}/widgets/w`
    const knowledge = `${SHUVIX}/knowledge`
    const policies = `${SHUVIX}/policies`
    const agentMd = `${SHUVIX}/agents/x.md`
    const spec = specOf({ grantedWrite: [widget, knowledge, policies, agentMd] })
    expect(spec.writeAllowBack).toEqual([ARTIFACTS, widget, knowledge])
    // 它们仍是可写根（profile 第 1 层），只是被第 2 层整片拒写压住、没放回
    expect(spec.writableRoots).toEqual(expect.arrayContaining([policies, agentMd]))
  })

  it('SP-4 放回的永远不是 ~/.shuvix / userData 本身（即便写授权恰好等于它们）', () => {
    const spec = specOf({ grantedWrite: [SHUVIX, USER_DATA] })
    expect(spec.writeAllowBack).toEqual([ARTIFACTS])
    expect(spec.writeAllowBack).not.toContain(SHUVIX)
    expect(spec.writeAllowBack).not.toContain(USER_DATA)
  })

  it('SP-4 writeDeniedFinal：凭据 7 项 + 沙箱外会执行的 14 项 + ssh/tmux 目录 + 每个 git 根（工作区与写授权）顶层的受保护名', () => {
    expect(CREDENTIAL_DIRS_HOME_RELATIVE).toHaveLength(7)
    expect(EXECUTED_LATER_HOME_RELATIVE).toHaveLength(14)
    const grant = '/Volumes/data/shared'
    const spec = specOf({ grantedWrite: [grant] })
    expect(spec.writeDeniedFinal).toEqual([
      ...CREDENTIAL_DIRS_HOME_RELATIVE.map((d) => h(d)),
      ...EXECUTED_LATER_HOME_RELATIVE.map((d) => h(d)),
      '/private/tmp/shuvix-ssh-501',
      '/private/tmp/tmux-501',
      ...ROOT_PROTECTED_NAMES.map((n) => `${WS}/${n}`),
      ...ROOT_PROTECTED_NAMES.map((n) => `${grant}/${n}`)
    ])
    // 临时目录 / 缓存 / /private/tmp 不是 git 根：那里不拦 .vscode 之类
    for (const root of [TMP_DIR, '/private/tmp', h('.npm')]) {
      for (const n of ROOT_PROTECTED_NAMES) {
        expect(spec.writeDeniedFinal).not.toContain(`${root}/${n}`)
      }
    }
  })

  it('SP-4 gitRoots = [ws, …写授权]；writeDeniedPatterns = [launchd 临时目录]', () => {
    const spec = specOf({ grantedWrite: ['/Volumes/a', '/Volumes/b'] })
    expect(spec.gitRoots).toEqual([WS, '/Volumes/a', '/Volumes/b'])
    expect(spec.writeDeniedPatterns).toEqual([LAUNCHD_TMP_PATTERN])
  })
})

describe('SP-5 读的四层与 socket', () => {
  it('SP-5 readDenied = 22 个个人资料目录 + userData', () => {
    expect(PERSONAL_DIRS_HOME_RELATIVE).toHaveLength(22)
    expect(specOf().readDenied).toEqual([
      ...PERSONAL_DIRS_HOME_RELATIVE.map((d) => h(d)),
      USER_DATA
    ])
  })

  it('SP-5 readAllowBack = [ws, 本会话 tool_results, …读授权, …写授权]（去重）', () => {
    const r = h('Documents/ref')
    const w = h('Documents/out')
    const spec = specOf({ grantedRead: [r, WS], grantedWrite: [w, r] })
    expect(spec.readAllowBack).toEqual([WS, `${USER_DATA}/tool_results/${SID}`, r, w])
  })

  it('SP-5 readDeniedFinal = 凭据目录 + ~/.shuvix/.session-state + userData/data；cli-token 不在里面（命令要读它）', () => {
    const spec = specOf()
    expect(spec.readDeniedFinal).toEqual([
      ...CREDENTIAL_DIRS_HOME_RELATIVE.map((d) => h(d)),
      `${SHUVIX}/.session-state`,
      `${USER_DATA}/data`
    ])
    expect(spec.readDeniedFinal).not.toContain(`${SHUVIX}/cli-token`)
  })

  it('SP-5 unixSockets = [real(cliSocket), mDNSResponder]；unixSocketDirs = [tmpDir, ws]', () => {
    const real = (p: string): string => (p === PATHS.cliSocket ? '/private/var/cli.sock' : p)
    const spec = specOf({}, PATHS, real)
    expect(spec.unixSockets).toEqual(['/private/var/cli.sock', '/private/var/run/mDNSResponder'])
    expect(spec.unixSocketDirs).toEqual([TMP_DIR, WS])
  })

  it('SP-5 工作区 = ~/Library 不再被接受（它严格包含 Mail / Keychains / Containers …）—— 放回它会把这些一起放出来', () => {
    const result = build({ workingDirectory: h('Library') })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('working directory contains')
  })
})

describe('SP-6 `real` 在一切判断之前应用', () => {
  const MAP = new Map<string, string>([
    ['/tmp/ws', '/private/tmp/ws'],
    ['/Users/link', HOME],
    ['/g1', '/Volumes/data/shared'],
    ['/g2', '/Volumes/data/shared']
  ])
  const real = (p: string): string => MAP.get(p) ?? p

  it('SP-6 工作区按解析后的路径记', () => {
    expect(specOf({ workingDirectory: '/tmp/ws' }, PATHS, real).workingDirectory).toBe(
      '/private/tmp/ws'
    )
  })

  it('SP-6 解析到家目录的符号链接写授权被拒', () => {
    const result = build({ grantedWrite: ['/Users/link'] }, PATHS, real)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('a write grant covers the home folder')
  })

  it('SP-6 指向同一处的两个写授权合成一个根', () => {
    const spec = specOf({ grantedWrite: ['/g1', '/g2'] }, PATHS, real)
    expect(spec.writableRoots.filter((r) => r === '/Volumes/data/shared')).toHaveLength(1)
    expect(spec.writableRoots).not.toContain('/g1')
    expect(spec.gitRoots).toEqual([WS, '/Volumes/data/shared'])
  })

  it('SP-6 家目录相对的清单拼在**解析后**的家目录上', () => {
    const spec = specOf({}, { ...PATHS, home: '/Users/link' }, real)
    expect(spec.writableRoots).toContain(h('.npm'))
    expect(spec.writeDeniedFinal).toContain(h('.ssh'))
    expect(spec.readDenied).toContain(h('Documents'))
    expect(JSON.stringify(spec)).not.toContain('/Users/link')
  })
})

describe('SP-7 toPolicyView：策略那一面与规格同源', () => {
  const CLI_TOKEN = `${SHUVIX}/cli-token`
  const PROTECTED_JS = [
    '/\\.[Gg][Ii][Tt]/([Hh][Oo][Oo][Kk][Ss](/|$)|[Cc][Oo][Nn][Ff][Ii][Gg]$|[Cc][Oo][Nn][Ff][Ii][Gg]\\.[Ww][Oo][Rr][Kk][Tt][Rr][Ee][Ee]$|[Cc][Oo][Mm][Mm][Oo][Nn][Dd][Ii][Rr]$)',
    '/\\.[Gg][Ii][Tt]/([Mm][Oo][Dd][Uu][Ll][Ee][Ss]|[Ww][Oo][Rr][Kk][Tt][Rr][Ee][Ee][Ss])/.*/([Hh][Oo][Oo][Kk][Ss](/|$)|[Cc][Oo][Nn][Ff][Ii][Gg]$|[Cc][Oo][Nn][Ff][Ii][Gg]\\.[Ww][Oo][Rr][Kk][Tt][Rr][Ee][Ee]$|[Cc][Oo][Mm][Mm][Oo][Nn][Dd][Ii][Rr]$)',
    '/\\.[Gg][Ii][Tt]$',
    '^/private/tmp/com\\.apple\\.launchd\\.'
  ]

  it('SP-7 生产布局：active；可写根 = spec.writableRoots（是副本）；写拒 = writeDeniedFinal；读拒 = 三者并集', () => {
    const spec = specOf({ grantedWrite: ['/Volumes/data/shared'] })
    const view = toPolicyView(spec, CLI_TOKEN)
    expect(view.sandboxActive).toBe(true)
    expect(view.sandboxWritableRoots).toEqual(spec.writableRoots)
    view.sandboxWritableRoots.push('/mutated')
    expect(spec.writableRoots).not.toContain('/mutated')
    // ~/.shuvix / userData 不落在任何「非放回」的根里：不用列出来
    expect(view.sandboxWriteDenied).toEqual(spec.writeDeniedFinal)
    expect(view.sandboxWriteDenied).not.toContain(SHUVIX)
    expect(view.sandboxWriteDenied).not.toContain(USER_DATA)
    expect(view.sandboxProtectedPatterns).toEqual([
      ...GIT_PATTERNS.map((p) => p.js),
      GIT_ENTRY_PATTERN.js,
      LAUNCHD_TMP_PATTERN.js
    ])
    // 与 agent-runtime 的 DESKTOP_VARS_ACTIVE 用的是同一串字面量（那边不能 import 桌面）
    expect(view.sandboxProtectedPatterns).toEqual(PROTECTED_JS)
    expect(view.sandboxReadDenied).toEqual([
      ...new Set([...spec.readDenied, ...spec.readDeniedFinal, CLI_TOKEN])
    ])
    expect(view.sandboxReadDenied).toContain(CLI_TOKEN)
    expect(view.sandboxReadAllowed).toEqual(spec.readAllowBack)
    view.sandboxReadAllowed.push('/mutated')
    expect(spec.readAllowBack).not.toContain('/mutated')
  })

  it('SP-7 可写根只列**实际**可写的：~/.shuvix/policies 里的写授权（没放回）不列；内容目录里的列', () => {
    const policies = `${SHUVIX}/policies`
    const widget = `${SHUVIX}/widgets/w`
    const spec = specOf({ grantedWrite: [policies, widget] })
    const view = toPolicyView(spec, CLI_TOKEN)
    expect(spec.writableRoots).toContain(policies)
    expect(view.sandboxWritableRoots).not.toContain(policies)
    expect(view.sandboxWritableRoots).toContain(widget)
    expect(view.sandboxWritableRoots).toContain(ARTIFACTS)
    expect(view.sandboxWritableRoots).toEqual(spec.writableRoots.filter((r) => r !== policies))
  })

  it('SP-7 e2e 布局：~/.shuvix 与 userData 都落在 /private/tmp 这个根里 → 列进 sandboxWriteDenied', () => {
    const spec = specOf({ workingDirectory: `${E2E_HOME}/proj` }, E2E_PATHS)
    const view = toPolicyView(spec, `${E2E_PATHS.shuvixHome}/cli-token`)
    expect(view.sandboxWriteDenied).toContain(E2E_PATHS.shuvixHome)
    expect(view.sandboxWriteDenied).toContain(E2E_PATHS.userData)
    expect(view.sandboxWriteDenied).toEqual([
      E2E_PATHS.shuvixHome,
      E2E_PATHS.userData,
      ...spec.writeDeniedFinal
    ])
  })
})

describe('SP-8 清单守卫', () => {
  it('SP-8 凭据目录清单与内置 protect-credentials 的 credentialDirs let 逐项相同（en / zh / ja）', () => {
    const read = createInlinePolicyMdReader()
    for (const file of [
      'protect-credentials.md',
      'protect-credentials.zh.md',
      'protect-credentials.ja.md'
    ]) {
      const md = read(file)
      expect(md, file).toBeTruthy()
      const let_ = /credentialDirs:\s*>-\s*\n([\s\S]*?)\]\.map\(/.exec(md!)
      expect(let_, file).not.toBeNull()
      const items = [...let_![1].matchAll(/'([^']*)'/g)].map((m) => m[1])
      expect({ file, items }).toEqual({ file, items: [...CREDENTIAL_DIRS_HOME_RELATIVE] })
    }
  })

  it('SP-8 每条正则：sbpl === js、不含双引号、能编成 JS RegExp', () => {
    for (const p of [...GIT_PATTERNS, GIT_ENTRY_PATTERN, LAUNCHD_TMP_PATTERN]) {
      expect(p.sbpl).toBe(p.js)
      expect(p.sbpl).not.toContain('"')
      expect(() => new RegExp(p.js)).not.toThrow()
    }
  })
})

describe('SP-9 正则语义（JS 方言 = SBPL 文本）', () => {
  const git = (p: string): boolean => GIT_PATTERNS.some((x) => new RegExp(x.js).test(p))

  it.each([
    '/w/.git/hooks/pre-commit',
    '/w/.git/hooks',
    '/w/.GIT/Config',
    '/w/.git/config.worktree',
    '/w/.git/commondir',
    '/w/a/b/.git/config',
    '/w/.git/modules/m/config',
    '/w/.git/modules/a/modules/b/hooks/x',
    '/w/.git/worktrees/wt/config.worktree'
  ])('SP-9 git 元数据命中：%s', (p) => {
    expect(git(p)).toBe(true)
  })

  it.each([
    '/w/.git/HEAD',
    '/w/.git/config.lock',
    '/w/.git/info/exclude',
    '/w/.github/workflows/ci.yml',
    '/w/.gitignore',
    '/w/.git/refs/heads/config'
  ])('SP-9 git 元数据不命中：%s', (p) => {
    expect(git(p)).toBe(false)
  })

  it('SP-9 .git 这一项本身：/w/.git、/w/sub/.Git 命中；/w/.github、/w/.git/x 不命中', () => {
    const entry = new RegExp(GIT_ENTRY_PATTERN.js)
    expect(entry.test('/w/.git')).toBe(true)
    expect(entry.test('/w/sub/.Git')).toBe(true)
    expect(entry.test('/w/.github')).toBe(false)
    expect(entry.test('/w/.git/x')).toBe(false)
  })

  it('SP-9 launchd：/private/tmp/com.apple.launchd.<x>/… 命中；launchdX 与未解析的 /tmp 写法不命中', () => {
    const launchd = new RegExp(LAUNCHD_TMP_PATTERN.js)
    expect(launchd.test('/private/tmp/com.apple.launchd.AbC/Listeners')).toBe(true)
    expect(launchd.test('/private/tmp/com.apple.launchdX')).toBe(false)
    expect(launchd.test('/tmp/com.apple.launchd.x')).toBe(false)
  })

  it('isWithin 按路径段边界比', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
    expect(isWithin('/a/b/c', '/a/b')).toBe(true)
    expect(isWithin('/a/bc', '/a/b')).toBe(false)
    expect(isWithin('/a/b/c', '/a/b/')).toBe(true)
  })
})

describe('SP-10 protectedWritePatterns：两个视图共用的受保护模式', () => {
  it.each([
    ['生产布局', PATHS, WS],
    ['e2e 布局', E2E_PATHS, `${E2E_HOME}/proj`],
    ['临时工作区', PATHS, TEMP_WS]
  ] as const)(
    'SP-10 %s：恰为 [...GIT_PATTERNS.js, GIT_ENTRY_PATTERN.js, ...writeDeniedPatterns.js]，且与 toPolicyView 的 sandboxProtectedPatterns 相同',
    (_label, paths, ws) => {
      const spec = specOf({ workingDirectory: ws }, paths)
      const patterns = protectedWritePatterns(spec)
      expect(patterns).toEqual([
        ...GIT_PATTERNS.map((p) => p.js),
        GIT_ENTRY_PATTERN.js,
        ...spec.writeDeniedPatterns.map((p) => p.js)
      ])
      expect(patterns).toEqual(
        toPolicyView(spec, `${paths.shuvixHome}/cli-token`).sandboxProtectedPatterns
      )
    }
  )

  it('SP-10 读的是规格自己的 writeDeniedPatterns（取 js 那一面，不是 sbpl），不是写死的 launchd 那一条', () => {
    const spec = specOf()
    const extra = { sbpl: '^/sbpl-only', js: '^/js-side' }
    const widened: SandboxSpec = {
      ...spec,
      writeDeniedPatterns: [...spec.writeDeniedPatterns, extra]
    }
    const patterns = protectedWritePatterns(widened)
    expect(patterns.at(-1)).toBe('^/js-side')
    expect(patterns).not.toContain('^/sbpl-only')
    expect(patterns).toEqual(toPolicyView(widened, `${SHUVIX}/cli-token`).sandboxProtectedPatterns)
    // 规格里一条拒写模式都没有时，只剩 git 那几条
    const none = protectedWritePatterns({ ...spec, writeDeniedPatterns: [] })
    expect(none).toEqual([...GIT_PATTERNS.map((p) => p.js), GIT_ENTRY_PATTERN.js])
  })
})
