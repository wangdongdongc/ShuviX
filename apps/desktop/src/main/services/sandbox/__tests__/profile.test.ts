/**
 * Seatbelt profile 编译（backends/seatbelt/profile.ts）—— 纯函数，golden 钉住输出。
 *
 *  - PR-1 golden：profile 文本与参数表整体快照 + 关键行逐条断言；信号只有一条、只到同一个沙箱
 *    （FU-9：`(target others)` 实测连主进程、Finder 这些不在沙箱里的同用户进程都够得到）；
 *  - PR-2 参数纪律（契约 9）：用户路径只经 `(param "Pk")` 进 profile，敌意路径不改变 profile 结构；
 *  - PR-3 空清单永远不产出不带过滤器的规则（那会变成该操作的缺省值）；
 *  - PR-4 正则只来自 tables.ts 的固定文本；
 *  - PR-5 各层的先后与操作名（放回必须写与拒绝相同的操作名）；
 *  - PR-6 .git 规则只限定在 git 根里；
 *  - PR-3b 凭据清单为空就没有拒读那一行；PR-7 根顶层的 .vscode 之类不再出现在 profile 里；
 *    PR-8 围栏（~/.shuvix、userData、凭据、git 全局配置、LaunchAgents、ssh / tmux 目录）都在。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', isPackaged: false } }))

import { compileSeatbeltProfile } from '../backends/seatbelt/profile'
import { buildSandboxSpec } from '../spec'
import { GIT_ENTRY_PATTERN, GIT_PATTERNS, LAUNCHD_TMP_PATTERN } from '../tables'
import type { SandboxHostPaths, SandboxSessionInput, SandboxSpec } from '../types'

const PATHS: SandboxHostPaths = {
  home: '/Users/u',
  userData: '/Users/u/Library/Application Support/ShuviX',
  shuvixHome: '/Users/u/.shuvix',
  uid: 501,
  cliSocket: '/Users/u/.shuvix/cli.sock',
  tmpRoot: '/private/tmp/shuvix-501'
}
const WS = '/Users/u/proj'
const GRANT_W = '/Volumes/data/shared'
/** 出厂 protect-credentials 的 `credentialDirs`（调用方交给沙箱的凭据位置） */
const CREDENTIALS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.netrc',
  '.shuvix/.session-state',
  'AppData/Local/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Credentials'
].map((d) => `${PATHS.home}/${d}`)

function specOf(over: Partial<SandboxSessionInput> = {}): SandboxSpec {
  const result = buildSandboxSpec(
    PATHS,
    {
      sessionId: 'sess-1',
      workingDirectory: WS,
      grantedWrite: [],
      credentialPaths: CREDENTIALS,
      ...over
    },
    (p) => p
  )
  if (!result.ok) throw new Error(result.reason)
  return result.spec
}

/** 本文件编出来的每一份 profile —— 末尾统一查「绝不出现 allow default / no-sandbox」 */
const compiledTexts: string[] = []
function compile(spec: SandboxSpec): { profile: string; params: Record<string, string> } {
  const out = compileSeatbeltProfile(spec)
  compiledTexts.push(out.profile)
  return out
}

const lines = (profile: string): string[] => profile.split('\n').filter((l) => l !== '')

/** 一行里引用的参数值（按出现顺序） */
function paramValues(line: string, params: Record<string, string>): string[] {
  return [...line.matchAll(/\(param "(P\d+)"\)/g)].map((m) => params[m[1]])
}

const FIXTURE = (): SandboxSpec => specOf({ grantedWrite: [GRANT_W] })

/** 不带过滤器的 allow / deny 行：只允许这一组固定内容 */
const FIXED_BARE_LINES = [
  '(deny default)',
  '(allow process-exec process-fork)',
  '(allow mach-task-name)',
  '(allow sysctl-read)',
  '(allow pseudo-tty)',
  '(allow ipc-posix-sem)',
  '(allow ipc-posix-shm*)',
  '(allow file-map-executable)',
  '(allow file-read*)',
  '(deny lsopen)',
  '(deny appleevent-send)',
  '(deny job-creation)'
]
const isBare = (l: string): boolean => /^\((allow|deny)( [a-z*-]+)+\)$/.test(l)

afterAll(() => {
  // PR-2 尾巴：本文件里所有 spec 编出来的文本都不含这两种「整个关掉」的写法
  expect(compiledTexts.length).toBeGreaterThan(3)
  for (const text of compiledTexts) {
    expect(text).not.toContain('with no-sandbox')
    expect(text).not.toContain('(allow default)')
    // FU-9：本文件编出来的每一份都只有那一条同沙箱的信号规则
    expectSameSandboxSignalOnly(text)
  }
})

/**
 * FU-9：信号规则恰好一条、只到同一个沙箱。不带过滤器的 `(allow signal)` 会放行所有信号，
 * `(target others)` 能打到沙箱外的同用户进程（主进程、Finder）。
 */
function expectSameSandboxSignalOnly(profile: string): void {
  const ls = lines(profile)
  expect(ls.filter((l) => l.includes('target others'))).toEqual([])
  expect(ls.filter((l) => l.startsWith('(allow signal'))).toEqual([
    '(allow signal (target same-sandbox))'
  ])
}

describe('PR-1 golden', () => {
  it('PR-1 夹具规格（一个写授权）的 profile 与参数表', () => {
    const { profile, params } = compile(FIXTURE())
    expect(profile).toMatchSnapshot('profile')
    expect(params).toMatchSnapshot('params')
  })

  it('PR-1 开头三行、网络、socket、信号与尾部拒绝', () => {
    const spec = FIXTURE()
    const { profile, params } = compile(spec)
    const ls = lines(profile)
    expect(ls.slice(0, 3)).toEqual(['(version 1)', '(deny default)', '(import "system.sb")'])
    expect(profile.endsWith('\n')).toBe(true)

    expect(ls).toContain('(allow network-outbound (remote ip "*:*"))')
    expect(ls).toContain('(allow network-bind network-inbound (local ip "*:*"))')
    expect(ls).toContain('(allow signal (target same-sandbox))')

    // 每个 socket 一条 remote unix-socket path-literal
    const socketLine = ls.find((l) => l.startsWith('(allow network-outbound (remote unix-socket'))!
    expect(socketLine).toBeDefined()
    expect(
      socketLine.match(/\(remote unix-socket \(path-literal \(param "P\d+"\)\)\)/g)
    ).toHaveLength(spec.unixSockets.length)
    expect(paramValues(socketLine, params)).toEqual(spec.unixSockets)

    // 每个 socket 目录：local + remote 两条 subpath，同一个参数
    const dirLine = ls.find((l) => l.startsWith('(allow network-bind network-outbound '))!
    expect(dirLine).toBeDefined()
    for (const dir of spec.unixSocketDirs) {
      const key = Object.keys(params).find(
        (k) => params[k] === dir && dirLine.includes(`(param "${k}")`)
      )
      expect(key, dir).toBeDefined()
      expect(dirLine).toContain(
        `(local unix-socket (subpath (param "${key}"))) (remote unix-socket (subpath (param "${key}")))`
      )
    }

    const tail = ls.slice(-4)
    expect(tail.slice(0, 3)).toEqual([
      '(deny lsopen)',
      '(deny appleevent-send)',
      '(deny job-creation)'
    ])
    expect(tail[3]).toBe(
      '(deny mach-lookup' +
        ' (global-name "com.apple.coreservices.launchservicesd")' +
        ' (global-name "com.apple.CoreServices.coreservicesd")' +
        ' (global-name "com.apple.coreservices.appleevents")' +
        ' (global-name "com.apple.lsd.mapdb")' +
        ' (global-name "com.apple.lsd.modifydb"))'
    )
  })

  it.each([
    ['夹具（一个写授权）', FIXTURE],
    [
      '临时工作区会话',
      () => specOf({ workingDirectory: `${PATHS.userData}/temp_workspace/sess-1` })
    ],
    ['没有授权', () => specOf()],
    [
      '好几个授权',
      () =>
        specOf({
          grantedWrite: [GRANT_W, '/Users/u/w2', '/Users/u/.shuvix/widgets/w']
        })
    ]
  ] as const)(
    'PR-1 FU-9 %s：信号规则恰好一条 (allow signal (target same-sandbox))，没有 target others',
    (_label, make) => {
      expectSameSandboxSignalOnly(compile(make()).profile)
    }
  )
})

describe('PR-2 参数纪律 + 敌意路径（契约 9）', () => {
  it('PR-2 每个被引用的参数都在表里、表里的每个键都被引用、键是连续的 P0…Pn', () => {
    const { profile, params } = compile(FIXTURE())
    const referenced = new Set([...profile.matchAll(/\(param "([^"]+)"\)/g)].map((m) => m[1]))
    const keys = Object.keys(params)
    expect([...referenced].sort()).toEqual([...keys].sort())
    expect(keys).toEqual(keys.map((_, i) => `P${i}`))
    expect(keys.length).toBeGreaterThan(10)
  })

  it('PR-2 敌意路径：profile 文本与同形的良性规格逐字节相同；路径不进文本；原样进参数', () => {
    const hostileWs = '/Users/u/p")(allow default)(x "'
    const hostileGlob = '/Users/u/**/x'
    const hostileNewline = '/Users/u/a\nb'
    const hostileRegex = '/Users/u/#"x'
    const hostile = specOf({
      workingDirectory: hostileWs,
      grantedWrite: [hostileGlob, hostileNewline],
      credentialPaths: [hostileRegex]
    })
    const benign = specOf({
      workingDirectory: '/Users/u/p',
      grantedWrite: ['/Users/u/g1', '/Users/u/g2'],
      credentialPaths: ['/Users/u/c1']
    })
    const h = compile(hostile)
    const b = compile(benign)
    // 结构只取决于各清单的长度
    expect(h.profile).toBe(b.profile)

    for (const value of [hostileWs, hostileGlob, hostileNewline, hostileRegex]) {
      expect(h.profile).not.toContain(value)
      expect(Object.values(h.params)).toContain(value)
    }
    // 规格里的每条路径都只以参数出现（'/private/tmp' 恰是 launchd 固定正则的前缀，故只查带引号的写法）
    const allPaths = new Set<string>([
      ...hostile.writableRoots,
      ...hostile.writeDenied,
      ...hostile.writeAllowBack,
      ...hostile.writeDeniedFinal,
      ...hostile.gitRoots,
      ...hostile.readDenied,
      ...hostile.unixSockets,
      ...hostile.unixSocketDirs
    ])
    for (const p of allPaths) {
      expect(h.profile, p).not.toContain(`"${p}"`)
      if (p !== '/private/tmp') expect(h.profile, p).not.toContain(p)
    }
  })
})

describe('PR-3 空清单不产出不带过滤器的规则', () => {
  const EMPTY: SandboxSpec = {
    sessionId: 's',
    workingDirectory: '/w',
    writableRoots: [],
    writeDenied: [],
    writeAllowBack: [],
    writeDeniedFinal: [],
    writeDeniedPatterns: [],
    gitRoots: [],
    readDenied: [],
    unixSockets: [],
    unixSocketDirs: [],
    tmpDir: '/t'
  }

  it('PR-3 全空的规格：这些裸规则一条都不出现；不带过滤器的行恰是固定那一组；参数表为空', () => {
    const { profile, params } = compile(EMPTY)
    const ls = lines(profile)
    for (const bare of [
      '(allow file-write*)',
      '(deny file-write*)',
      '(deny file-read*)',
      '(deny file-write-create file-write-unlink)',
      '(allow network-outbound)',
      '(allow network-bind network-outbound)'
    ]) {
      expect(ls, bare).not.toContain(bare)
    }
    expect(ls.filter(isBare)).toEqual(FIXED_BARE_LINES)
    expect(params).toEqual({})
    expect(profile).not.toContain('(param ')
  })

  it('PR-3 真实夹具里不带过滤器的行也恰是固定那一组', () => {
    const { profile } = compile(FIXTURE())
    expect(lines(profile).filter(isBare)).toEqual(FIXED_BARE_LINES)
  })
})

describe('PR-4 正则的来源', () => {
  it('PR-4 文本里的每个 #"…" 都来自 tables.ts 的固定文本（或 /dev/ttys）', () => {
    const allowed = new Set([
      ...GIT_PATTERNS.map((p) => p.sbpl),
      GIT_ENTRY_PATTERN.sbpl,
      LAUNCHD_TMP_PATTERN.sbpl,
      '^/dev/ttys[0-9]+$'
    ])
    const { profile } = compile(specOf({ grantedWrite: [GRANT_W, '/Volumes/other'] }))
    const literals = [...profile.matchAll(/#"([^"]*)"/g)].map((m) => m[1])
    expect(literals.length).toBeGreaterThan(5)
    for (const lit of literals) expect(allowed.has(lit), lit).toBe(true)
  })

  it('PR-4 writeDeniedPatterns 里混进带双引号的正则 → 编译直接抛', () => {
    const spec = FIXTURE()
    spec.writeDeniedPatterns = [{ sbpl: '^/x")(allow default)("', js: '^/x' }]
    expect(() => compileSeatbeltProfile(spec)).toThrow(/quote/)
  })
})

describe('PR-5 层序与操作名', () => {
  it('PR-5 读：全读 < 拒读凭据（连元数据都拒）；写：根 < 整片拒 < 放回 < 最后一层 < .git 项本身', () => {
    const spec = FIXTURE()
    const { profile, params } = compile(spec)
    const ls = lines(profile)
    const at = (pred: (l: string) => boolean, what: string): number => {
      const i = ls.findIndex(pred)
      expect(i, what).toBeGreaterThanOrEqual(0)
      return i
    }

    const readAll = at((l) => l === '(allow file-read*)', 'allow file-read*')
    const readDeny = at((l) => l.startsWith('(deny file-read* '), 'deny file-read*')
    expect(readAll).toBeLessThan(readDeny)
    expect(paramValues(ls[readDeny], params)).toEqual(spec.readDenied)
    expect(spec.readDenied).toEqual(CREDENTIALS)
    // 读只有这两行：没有 file-read-data 那一层的拒绝与放回
    expect(ls.filter((l) => l.includes('file-read-data'))).toEqual([])

    const writeAllows = ls
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l.startsWith('(allow file-write* '))
      .map(([, i]) => i)
    const writeDenies = ls
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l.startsWith('(deny file-write* '))
      .map(([, i]) => i)
    expect(writeAllows).toHaveLength(2)
    expect(writeDenies).toHaveLength(2)
    const createUnlink = at(
      (l) => l.startsWith('(deny file-write-create file-write-unlink '),
      'deny create/unlink'
    )
    expect(writeAllows[0]).toBeLessThan(writeDenies[0])
    expect(writeDenies[0]).toBeLessThan(writeAllows[1])
    expect(writeAllows[1]).toBeLessThan(writeDenies[1])
    expect(writeDenies[1]).toBeLessThan(createUnlink)
    expect(paramValues(ls[writeAllows[0]], params)).toEqual(spec.writableRoots)
    expect(paramValues(ls[writeDenies[0]], params)).toEqual(spec.writeDenied)
    expect(paramValues(ls[writeAllows[1]], params)).toEqual(spec.writeAllowBack)
    // 最后一层：先是 writeDeniedFinal 的 subpath，后面是 git 规则引用的 git 根
    expect(paramValues(ls[writeDenies[1]], params).slice(0, spec.writeDeniedFinal.length)).toEqual(
      spec.writeDeniedFinal
    )
  })

  it('PR-5 读没有放回：从不写带过滤器的 allow file-read*', () => {
    const { profile } = compile(FIXTURE())
    for (const l of lines(profile)) {
      expect(l, l).not.toMatch(/^\(allow file-read\* \((subpath|literal|regex|require)/)
    }
  })
})

describe('PR-6 .git 规则只在 git 根里', () => {
  const GIT_REGEXES = GIT_PATTERNS.map((p) => p.sbpl)

  it('PR-6 每个 git 根：最后一层拒写里各 GIT_PATTERNS 条 require-all，.git 项本身的创建 / 删除一条；参数只指向工作区与写授权', () => {
    const spec = specOf({ grantedWrite: [GRANT_W, '/Volumes/other'] })
    expect(spec.gitRoots).toEqual([WS, GRANT_W, '/Volumes/other'])
    const { profile, params } = compile(spec)
    const ls = lines(profile)
    const finalDeny = ls.filter((l) => l.startsWith('(deny file-write* '))[1]
    const createUnlink = ls.find((l) => l.startsWith('(deny file-write-create file-write-unlink '))!

    const gitFilter = /\(require-all \(subpath \(param "(P\d+)"\)\) \(regex #"([^"]*)"\)\)/g
    const finalFilters = [...finalDeny.matchAll(gitFilter)]
    expect(finalFilters).toHaveLength(spec.gitRoots.length * GIT_PATTERNS.length)
    for (const [i, root] of spec.gitRoots.entries()) {
      const mine = finalFilters.slice(i * GIT_PATTERNS.length, (i + 1) * GIT_PATTERNS.length)
      expect(mine.map((m) => params[m[1]])).toEqual(GIT_PATTERNS.map(() => root))
      expect(mine.map((m) => m[2])).toEqual(GIT_REGEXES)
    }

    const entryFilters = [...createUnlink.matchAll(gitFilter)]
    expect(entryFilters.map((m) => params[m[1]])).toEqual(spec.gitRoots)
    expect(entryFilters.map((m) => m[2])).toEqual(spec.gitRoots.map(() => GIT_ENTRY_PATTERN.sbpl))
    // create/unlink 那一行只有这些 require-all
    expect(createUnlink.replace(gitFilter, '').replace(/\s+/g, '')).toBe(
      '(denyfile-write-createfile-write-unlink)'
    )

    // git 正则从不出现在 require-all 之外
    const allGitRegexes = new Set([...GIT_REGEXES, GIT_ENTRY_PATTERN.sbpl])
    const everyRegex = [
      ...profile.matchAll(/(\(require-all \(subpath \(param "P\d+"\)\) )?\(regex #"([^"]*)"\)/g)
    ]
    for (const m of everyRegex) {
      if (allGitRegexes.has(m[2])) expect(m[1], m[2]).toBeDefined()
    }

    // git 过滤器引用的参数只解析到工作区 / 写授权，绝不是临时目录、/private/tmp、缓存
    const gitParamValues = new Set([...finalFilters, ...entryFilters].map((m) => params[m[1]]))
    expect([...gitParamValues].sort()).toEqual([...spec.gitRoots].sort())
    for (const bad of [spec.tmpDir, '/private/tmp', '/Users/u/.npm']) {
      expect(gitParamValues.has(bad)).toBe(false)
    }
  })
})

describe('PR-3b / PR-7 / PR-8 读只有凭据一层；别家工具的配置不再受保护；围栏在', () => {
  const HOME = PATHS.home
  const ROOT_NAMES = [
    '.vscode',
    '.idea',
    '.claude',
    '.cursor',
    '.codex',
    '.zed',
    '.mcp.json',
    '.envrc'
  ]

  it('PR-3b 凭据清单为空的真实规格：没有任何 (deny file-read* 行；不带过滤器的行仍恰是固定那一组', () => {
    const spec = specOf({ grantedWrite: [GRANT_W], credentialPaths: [] })
    expect(spec.readDenied).toEqual([])
    const { profile } = compile(spec)
    const ls = lines(profile)
    expect(ls.filter((l) => l.startsWith('(deny file-read*'))).toEqual([])
    expect(ls).toContain('(allow file-read*)')
    expect(ls.filter(isBare)).toEqual(FIXED_BARE_LINES)
  })

  it('PR-7 根顶层的 .vscode / .claude / .mcp.json …：没有哪个参数以它们结尾，也没有哪条正则提到它们', () => {
    const { profile, params } = compile(specOf({ grantedWrite: [GRANT_W, '/Volumes/other'] }))
    for (const value of Object.values(params)) {
      for (const name of ROOT_NAMES) {
        expect(value.endsWith(`/${name}`), `${value} ends with ${name}`).toBe(false)
      }
    }
    const regexes = [...profile.matchAll(/#"([^"]*)"/g)].map((m) => m[1])
    for (const re of regexes) {
      for (const name of ROOT_NAMES) {
        const bare = name.replace(/^\./, '')
        expect(re.toLowerCase().includes(bare), `${re} mentions ${name}`).toBe(false)
        // 语义上也不命中（正则是按字母 [Xx] 写的，字面查找之外再实测一遍）
        for (const path of [`${WS}/${name}`, `${WS}/${name}/x`, `${GRANT_W}/${name}/x`]) {
          expect(new RegExp(re).test(path), `${re} matches ${path}`).toBe(false)
        }
      }
    }
  })

  it('PR-8 围栏：整片拒写是 ~/.shuvix 与 userData；最后一层拒写里有每个凭据位置、~/.gitconfig、LaunchAgents、ssh / tmux 目录', () => {
    const spec = FIXTURE()
    const { profile, params } = compile(spec)
    const ls = lines(profile)
    const denies = ls.filter((l) => l.startsWith('(deny file-write* '))
    expect(denies).toHaveLength(2)
    expect(paramValues(denies[0], params)).toEqual([PATHS.shuvixHome, PATHS.userData])

    const finalLayer = paramValues(denies[1], params)
    for (const expected of [
      ...CREDENTIALS,
      `${HOME}/.gitconfig`,
      `${HOME}/Library/LaunchAgents`,
      '/private/tmp/shuvix-ssh-501',
      '/private/tmp/tmux-501'
    ]) {
      expect(finalLayer, expected).toContain(expected)
    }
  })
})
