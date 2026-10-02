/**
 * Seatbelt profile 编译（backends/seatbelt/profile.ts）—— 纯函数，golden 钉住输出。
 *
 *  - PR-1 golden：profile 文本与参数表整体快照 + 关键行逐条断言；信号只有一条、只到同一个沙箱
 *    （FU-9：`(target others)` 实测连主进程、Finder 这些不在沙箱里的同用户进程都够得到）；
 *  - PR-2 参数纪律：用户路径只经 `(param "Pk")` 进 profile，敌意路径不改变 profile 结构；
 *  - PR-3 空清单永远不产出不带过滤器的规则（那会变成该操作的缺省值）；
 *  - PR-4 正则只剩 /dev/ttys 那一条固定文本（git 元数据、launchd 的正则随围栏一起删了）；
 *  - PR-5 读的四行：全读 < 拒读家目录 < 放回上级目录的元数据 < 放回可读根与 cli-token
 *    （放回必须写与拒绝相同的操作名，元数据用更具体的 file-read-metadata）；
 *  - PR-6 写只有一行：可写根；没有任何拒写（围栏没了）；
 *  - PR-7 尾部：沙箱外代为执行的入口（lsopen / appleevent / job-creation / LaunchServices）在所有文件规则之后；
 *  - PR-8 放行清单与围栏都不在了：包缓存、/private/tmp、~/.gitconfig、LaunchAgents、ssh / tmux 目录。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', isPackaged: false } }))

import { compileSeatbeltProfile } from '../backends/seatbelt/profile'
import { buildSandboxSpec } from '../spec'
import type { SandboxHostPaths, SandboxSessionInput, SandboxSpec } from '../types'

const PATHS: SandboxHostPaths = {
  home: '/Users/u',
  userData: '/Users/u/Library/Application Support/ShuviX',
  shuvixHome: '/Users/u/.shuvix',
  toolResultsBase: '/Users/u/Library/Application Support/ShuviX/tool_results',
  uid: 501,
  cliSocket: '/Users/u/.shuvix/cli.sock',
  cliToken: '/Users/u/.shuvix/cli-token',
  appPaths: ['/Applications/ShuviX.app'],
  tmpRoot: '/private/tmp/shuvix-501'
}
const HOME = PATHS.home
const WS = '/Users/u/proj'
const GRANT_W = '/Volumes/data/shared'
const GRANT_R = '/Users/u/ref'
const KB = '/Users/u/.shuvix/knowledge/b'
const SKILLS = '/Users/u/.shuvix/skills'

function specOf(
  over: Partial<SandboxSessionInput> = {},
  paths: SandboxHostPaths = PATHS
): SandboxSpec {
  const result = buildSandboxSpec(
    paths,
    {
      sessionId: 'sess-1',
      workingDirectory: WS,
      grantedRead: [],
      grantedWrite: [],
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

/** 夹具：一个写授权、一个读授权、勾选的知识库（可读写）、技能目录（只读） */
const FIXTURE = (): SandboxSpec =>
  specOf({
    grantedWrite: [GRANT_W],
    grantedRead: [GRANT_R],
    extras: { readWrite: [KB], readOnly: [SKILLS] }
  })

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

/** 文件读写相关的那几行（不含 /dev/ptmx 那一行） */
const READ_DENY = (l: string): boolean => l.startsWith('(deny file-read* ')
const METADATA_ALLOW = (l: string): boolean => l.startsWith('(allow file-read-metadata ')
const READ_ALLOW = (l: string): boolean => /^\(allow file-read\*\s+\(/.test(l)
const WRITE_ALLOW = (l: string): boolean => l.startsWith('(allow file-write* ')

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
  it('PR-1 夹具规格的 profile 与参数表', () => {
    const { profile, params } = compile(FIXTURE())
    expect(profile).toMatchSnapshot('profile')
    expect(params).toMatchSnapshot('params')
  })

  it('PR-1 开头三行、进程块、网络、socket、信号与尾部拒绝', () => {
    const spec = FIXTURE()
    const { profile, params } = compile(spec)
    const ls = lines(profile)
    expect(ls.slice(0, 3)).toEqual(['(version 1)', '(deny default)', '(import "system.sb")'])
    expect(profile.endsWith('\n')).toBe(true)

    expect(ls).toContain('(allow process-info* (target same-sandbox))')
    expect(ls).toContain(
      '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))'
    )
    expect(ls).toContain('(system-network)')
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
    ['夹具', FIXTURE],
    [
      '临时工作区会话',
      () => specOf({ workingDirectory: `${PATHS.userData}/temp_workspace/sess-1` })
    ],
    ['没有授权、没有 extras', () => specOf()],
    [
      '好几个授权',
      () =>
        specOf({
          grantedWrite: [GRANT_W, '/Users/u/w2', '/Users/u/.shuvix/widgets/w'],
          grantedRead: [GRANT_R, '/opt/r']
        })
    ]
  ] as const)(
    'PR-1 FU-9 %s：信号规则恰好一条 (allow signal (target same-sandbox))，没有 target others',
    (_label, make) => {
      expectSameSandboxSignalOnly(compile(make()).profile)
    }
  )
})

describe('PR-2 参数纪律 + 敌意路径', () => {
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
    const hostileToken = '/Users/u/.shuvix/tok") (allow file-write* (subpath "/'
    const hostileApp = '/opt/app")(allow default'
    const hostile = specOf(
      {
        workingDirectory: hostileWs,
        grantedWrite: [hostileGlob, hostileNewline],
        grantedRead: [hostileRegex]
      },
      { ...PATHS, cliToken: hostileToken, appPaths: [hostileApp] }
    )
    // 同形：每份清单长度相同，家目录里的路径上级目录的层数也相同（元数据清单因此一样长）
    const benign = specOf(
      {
        workingDirectory: '/Users/u/p',
        grantedWrite: ['/Users/u/g/x', '/Users/u/g2'],
        grantedRead: ['/Users/u/r1']
      },
      { ...PATHS, cliToken: '/Users/u/.shuvix/tok', appPaths: ['/opt/app'] }
    )
    expect(hostile.metadataPaths).toHaveLength(benign.metadataPaths.length)
    const h = compile(hostile)
    const b = compile(benign)
    // 结构只取决于各清单的长度
    expect(h.profile).toBe(b.profile)

    for (const value of [
      hostileWs,
      hostileGlob,
      hostileNewline,
      hostileRegex,
      hostileToken,
      hostileApp
    ]) {
      expect(h.profile).not.toContain(value)
      expect(Object.values(h.params)).toContain(value)
    }
    // 规格里的每条路径都只以参数出现
    const allPaths = new Set<string>([
      hostile.home,
      ...hostile.readableRoots,
      ...hostile.readableFiles,
      ...hostile.metadataPaths,
      ...hostile.writableRoots,
      ...hostile.unixSockets,
      ...hostile.unixSocketDirs
    ])
    for (const p of allPaths) {
      expect(h.profile, p).not.toContain(`"${p}"`)
      expect(h.profile, p).not.toContain(p)
    }
  })
})

describe('PR-3 空清单不产出不带过滤器的规则', () => {
  const EMPTY: SandboxSpec = {
    sessionId: 's',
    workingDirectory: '/w',
    home: '/h',
    sessionDirs: [],
    sessionReadDirs: [],
    readableRoots: [],
    readableFiles: [],
    metadataPaths: [],
    writableRoots: [],
    unixSockets: [],
    unixSocketDirs: [],
    tmpDir: '/t'
  }

  it('PR-3 只有家目录的规格：只剩拒读家目录那一条带参数的规则；不带过滤器的行恰是固定那一组', () => {
    const { profile, params } = compile(EMPTY)
    const ls = lines(profile)
    for (const bare of [
      '(allow file-write*)',
      '(deny file-write*)',
      '(deny file-read*)',
      '(allow file-read-metadata)',
      '(allow network-outbound)',
      '(allow network-bind network-outbound)'
    ]) {
      expect(ls, bare).not.toContain(bare)
    }
    expect(ls.filter(isBare)).toEqual(FIXED_BARE_LINES)
    expect(params).toEqual({ P0: '/h' })
    expect(ls.filter((l) => l.includes('(param '))).toEqual([
      '(deny file-read* (subpath (param "P0")))'
    ])
    expect(ls.filter(METADATA_ALLOW)).toEqual([])
    expect(ls.filter(READ_ALLOW)).toEqual([])
    expect(ls.filter(WRITE_ALLOW)).toEqual([])
  })

  it('PR-3 只有可读文件、没有可读根：放回那一行只有 literal（生产里会话目录恒非空，走不到这里）', () => {
    const { profile, params } = compile({ ...EMPTY, readableFiles: ['/h/tok'] })
    // 空的 subpath 段拼出一个多余的空格，SBPL 不在乎
    const allow = lines(profile)
      .filter(READ_ALLOW)
      .map((l) => l.replace(/\s+/g, ' '))
    expect(allow).toEqual(['(allow file-read* (literal (param "P1")))'])
    expect(params.P1).toBe('/h/tok')
  })

  it('PR-3 真实夹具里不带过滤器的行也恰是固定那一组', () => {
    const { profile } = compile(FIXTURE())
    expect(lines(profile).filter(isBare)).toEqual(FIXED_BARE_LINES)
  })
})

describe('PR-4 正则的来源', () => {
  it('PR-4 文本里的 #"…" 只有 /dev/ttys 那一条；没有 require-all', () => {
    const { profile } = compile(specOf({ grantedWrite: [GRANT_W, '/Volumes/other'] }))
    const literals = [...profile.matchAll(/#"([^"]*)"/g)].map((m) => m[1])
    expect(literals).toEqual(['^/dev/ttys[0-9]+$'])
    expect(profile).not.toContain('require-all')
  })
})

describe('PR-5 读：全读 < 拒读家目录 < 元数据 < 放回', () => {
  it('PR-5 四行的先后、操作名与各自的参数', () => {
    const spec = FIXTURE()
    const { profile, params } = compile(spec)
    const ls = lines(profile)
    const at = (pred: (l: string) => boolean, what: string): number => {
      const found = ls.filter(pred)
      expect(found, what).toHaveLength(1)
      return ls.indexOf(found[0])
    }

    const readAll = at((l) => l === '(allow file-read*)', 'allow file-read*')
    const denyHome = at(READ_DENY, 'deny file-read*')
    const metadata = at(METADATA_ALLOW, 'allow file-read-metadata')
    const allowBack = at(READ_ALLOW, 'allow file-read* (…)')
    expect(readAll).toBeLessThan(denyHome)
    expect(denyHome).toBeLessThan(metadata)
    expect(metadata).toBeLessThan(allowBack)

    expect(ls[denyHome]).toMatch(/^\(deny file-read\* \(subpath \(param "P\d+"\)\)\)$/)
    expect(paramValues(ls[denyHome], params)).toEqual([HOME])

    // 元数据：每个上级目录一个 literal（只放这一级本身，不放它里面）
    expect(ls[metadata]).not.toContain('subpath')
    expect(ls[metadata].match(/\(literal \(param "P\d+"\)\)/g)).toHaveLength(
      spec.metadataPaths.length
    )
    expect(paramValues(ls[metadata], params)).toEqual(spec.metadataPaths)

    // 放回：可读根是 subpath，可读文件是 literal，操作名与拒绝那一行相同（file-read*）
    expect(paramValues(ls[allowBack], params)).toEqual([
      ...spec.readableRoots,
      ...spec.readableFiles
    ])
    expect(ls[allowBack].match(/\(subpath \(param "P\d+"\)\)/g)).toHaveLength(
      spec.readableRoots.length
    )
    expect(ls[allowBack].match(/\(literal \(param "P\d+"\)\)/g)).toHaveLength(
      spec.readableFiles.length
    )
    expect(spec.readableFiles).toEqual([PATHS.cliToken])

    // 没有 file-read-data 那一层：具体操作名会压过通配，放回就失效了
    expect(ls.filter((l) => l.includes('file-read-data'))).toEqual([])
  })

  it('PR-5 可读根里有只读会话目录与读授权，不止会话目录', () => {
    const spec = FIXTURE()
    const { profile, params } = compile(spec)
    const values = paramValues(lines(profile).find(READ_ALLOW)!, params)
    for (const p of [WS, KB, SKILLS, GRANT_R, GRANT_W, '/Applications/ShuviX.app']) {
      expect(values, p).toContain(p)
    }
  })
})

describe('PR-6 写：只有一行可写根，没有拒写', () => {
  it('PR-6 恰好一行 (allow file-write* (subpath …))，参数就是 writableRoots；只读的目录不在里面', () => {
    const spec = FIXTURE()
    const { profile, params } = compile(spec)
    const ls = lines(profile)
    const writes = ls.filter(WRITE_ALLOW)
    expect(writes).toHaveLength(1)
    expect(paramValues(writes[0], params)).toEqual(spec.writableRoots)
    expect(writes[0].match(/\(subpath \(param "P\d+"\)\)/g)).toHaveLength(spec.writableRoots.length)
    for (const readOnly of [GRANT_R, SKILLS, '/Applications/ShuviX.app', PATHS.cliToken]) {
      expect(paramValues(writes[0], params), readOnly).not.toContain(readOnly)
    }
  })

  it('PR-6 围栏没了：没有任何 deny file-write* / file-write-create / file-write-unlink 规则', () => {
    const { profile } = compile(FIXTURE())
    const ls = lines(profile)
    expect(ls.filter((l) => l.startsWith('(deny file-write'))).toEqual([])
    expect(profile).not.toContain('file-write-create')
    expect(profile).not.toContain('file-write-unlink')
  })
})

describe('PR-7 尾部：沙箱外代为执行的入口在所有文件规则之后', () => {
  it('PR-7 lsopen / appleevent-send / job-creation / LaunchServices 是最后四行，晚于读写规则', () => {
    const { profile } = compile(FIXTURE())
    const ls = lines(profile)
    const lastFileRule = Math.max(
      ls.findIndex(READ_ALLOW),
      ls.findIndex(WRITE_ALLOW),
      ls.findIndex(METADATA_ALLOW)
    )
    const lsopen = ls.indexOf('(deny lsopen)')
    expect(lsopen).toBe(ls.length - 4)
    expect(lastFileRule).toBeLessThan(lsopen)
  })
})

describe('PR-8 放行清单与围栏都不在了', () => {
  it('PR-8 参数里没有包缓存、/private/tmp 本身、~/.gitconfig、LaunchAgents、shell 启动文件、ssh / tmux 目录', () => {
    const { params } = compile(FIXTURE())
    const values = Object.values(params)
    for (const gone of [
      `${HOME}/.npm`,
      `${HOME}/.cache`,
      `${HOME}/Library/Caches/pip`,
      '/private/tmp',
      `${HOME}/.gitconfig`,
      `${HOME}/.config/git`,
      `${HOME}/Library/LaunchAgents`,
      `${HOME}/.zshrc`,
      '/private/tmp/shuvix-ssh-501',
      '/private/tmp/tmux-501',
      `${HOME}/.ssh`
    ]) {
      expect(values, gone).not.toContain(gone)
    }
  })
})
