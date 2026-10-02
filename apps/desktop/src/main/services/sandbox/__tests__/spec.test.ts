/**
 * 沙箱规格（spec.ts）—— 纯函数：会话 → 会话目录清单 → 规格。
 *
 * 2026-10-01 起沙箱只做一件事：把命令的文件访问收进本会话的目录。没有放行清单（包缓存、/tmp）、
 * 没有围栏（git 元数据、~/.shuvix、凭据清单）——这里钉住剩下的全部：
 *
 *  - SP-1 哪些会话不套沙箱：坏会话 id；工作目录与**每个写授权**过同一套判定（覆盖家目录、是 ShuviX
 *    自己的配置、在应用数据里、**包含** ShuviX 的配置或应用数据）；以及原因的先后；
 *  - SP-2 套得上的工作目录与授权（按路径段边界判；读授权不过这套判定）；
 *  - SP-3 会话目录清单（sessionDirsFor）：工作目录、本会话临时目录、artifacts、工具结果；
 *    工作目录不适合时它不在清单里；坏 id 没有清单；
 *  - SP-3x 会话设置带来的目录（extras，宿主现算：勾选的知识库可读写，技能目录 / 内置知识库只读）：
 *    realpath、去重、空串 / `/` / 覆盖家目录的丢掉，只读的里去掉已在读写清单里的；
 *  - SP-4 规格的各个字段：可读根 = 会话目录 + 只读会话目录 + 写授权 + 读授权 + ShuviX 自己的程序，
 *    可写根 = 会话目录 + 写授权，可读文件只有 cli-token，socket；
 *  - SP-5 上级目录的元数据（metadataPaths）：家目录里可读根 / 可读文件 / CLI socket 的每一级上级，到家目录为止；
 *  - SP-6 `real` 在一切判断之前应用；
 *  - SP-7 isWithin 按路径段边界比。
 *
 * 夹具宿主：home=/Users/u，userData 在 ~/Library/Application Support/ShuviX，工具结果在 userData/tool_results，
 * 工作目录 /Users/u/proj，ShuviX 自己的程序在 /Applications/ShuviX.app（打包后的布局，家目录以外）；
 * e2e 布局把假 HOME 放在 /private/tmp 下。
 */
import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'

// spec.ts → utils/paths 会连带 import electron（只在调用时才用 app）
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', isPackaged: false } }))

import { buildSandboxSpec, isWithin, sessionDirsFor, sessionTmpName } from '../spec'
import { MDNS_RESPONDER_SOCKET } from '../tables'
import type { SandboxHostPaths, SandboxSessionInput, SandboxSpec } from '../types'

const HOME = '/Users/u'
const USER_DATA = '/Users/u/Library/Application Support/ShuviX'
const SHUVIX = '/Users/u/.shuvix'
const TOOL_RESULTS = `${USER_DATA}/tool_results`
const SID = 'sess-1'
const WS = '/Users/u/proj'
const TMP_ROOT = '/private/tmp/shuvix-501'
const CLI_SOCKET = `${SHUVIX}/cli.sock`
const CLI_TOKEN = `${SHUVIX}/cli-token`
const APP = '/Applications/ShuviX.app'

const PATHS: SandboxHostPaths = {
  home: HOME,
  userData: USER_DATA,
  shuvixHome: SHUVIX,
  toolResultsBase: TOOL_RESULTS,
  uid: 501,
  cliSocket: CLI_SOCKET,
  cliToken: CLI_TOKEN,
  appPaths: [APP],
  tmpRoot: TMP_ROOT
}

/** e2e 布局：假 HOME 在 /private/tmp 下 */
const E2E_HOME = '/private/tmp/shuvix-e2e-x'
const E2E_PATHS: SandboxHostPaths = {
  home: E2E_HOME,
  userData: `${E2E_HOME}/Library/Application Support/ShuviX`,
  shuvixHome: `${E2E_HOME}/.shuvix`,
  toolResultsBase: `${E2E_HOME}/Library/Application Support/ShuviX/tool_results`,
  uid: 501,
  cliSocket: `${E2E_HOME}/.shuvix/cli.sock`,
  cliToken: `${E2E_HOME}/.shuvix/cli-token`,
  appPaths: [APP],
  tmpRoot: TMP_ROOT
}

const identity = (p: string): string => p

function input(over: Partial<SandboxSessionInput> = {}): SandboxSessionInput {
  return {
    sessionId: SID,
    workingDirectory: WS,
    grantedRead: [],
    grantedWrite: [],
    ...over
  }
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
const TOOL_RESULTS_SID = `${TOOL_RESULTS}/${SID}`
const TEMP_WS = `${USER_DATA}/temp_workspace/${SID}`
/** 正常工作目录下本会话的会话目录（顺序即实现的顺序） */
const SESSION_DIRS = [WS, TMP_DIR, ARTIFACTS, TOOL_RESULTS_SID]

describe('SP-1 不套沙箱的会话：一律 {ok:false} 并说明原因', () => {
  const COVERS = 'covers the home folder'
  const CONFIG = "is ShuviX's own configuration"
  const APP_DATA = "is inside ShuviX's application data"
  const CONTAINS = "contains ShuviX's own configuration or application data"
  const cases: Array<[string, Partial<SandboxSessionInput>, string]> = [
    ['会话 id 为空', { sessionId: '' }, 'unsafe session id'],
    ['会话 id 是 ..', { sessionId: '..' }, 'unsafe session id'],
    ['会话 id 是 .', { sessionId: '.' }, 'unsafe session id'],
    ['会话 id 带 /', { sessionId: 'a/b' }, 'unsafe session id'],
    ['会话 id 带 \\', { sessionId: 'a\\b' }, 'unsafe session id'],
    ['会话 id 含 ..', { sessionId: 'x..y' }, 'unsafe session id'],
    // 工作目录
    ['工作目录是 /', { workingDirectory: '/' }, `working directory ${COVERS}`],
    ['工作目录就是家目录', { workingDirectory: HOME }, `working directory ${COVERS}`],
    ['工作目录是 /Users', { workingDirectory: '/Users' }, `working directory ${COVERS}`],
    ['工作目录是 ~/.shuvix', { workingDirectory: SHUVIX }, `working directory ${CONFIG}`],
    [
      '工作目录是 ~/.shuvix/agents',
      { workingDirectory: `${SHUVIX}/agents` },
      `working directory ${CONFIG}`
    ],
    [
      '工作目录在 ~/.shuvix/policies 里',
      { workingDirectory: `${SHUVIX}/policies/sub` },
      `working directory ${CONFIG}`
    ],
    [
      '工作目录是 ~/.shuvix/knowledgeX（同前缀兄弟，不是内容目录）',
      { workingDirectory: `${SHUVIX}/knowledgeX` },
      `working directory ${CONFIG}`
    ],
    ['工作目录是 userData', { workingDirectory: USER_DATA }, `working directory ${APP_DATA}`],
    [
      '工作目录是 userData/tool_results',
      { workingDirectory: TOOL_RESULTS },
      `working directory ${APP_DATA}`
    ],
    [
      '工作目录是本会话的工具结果（它是会话目录，但当不了工作目录）',
      { workingDirectory: TOOL_RESULTS_SID },
      `working directory ${APP_DATA}`
    ],
    [
      '工作目录是别的会话的临时工作区',
      { workingDirectory: `${USER_DATA}/temp_workspace/OTHER` },
      `working directory ${APP_DATA}`
    ],
    [
      '工作目录是 temp_workspace 本身',
      { workingDirectory: `${USER_DATA}/temp_workspace` },
      `working directory ${APP_DATA}`
    ],
    // 「包含」：数据库里有沙箱开关与「允许并记住」，命令改得到它们就等于出得了沙箱
    [
      '工作目录是 ~/Library（包含 userData）',
      { workingDirectory: h('Library') },
      `working directory ${CONTAINS}`
    ],
    [
      '工作目录是 ~/Library/Application Support（包含 userData）',
      { workingDirectory: h('Library/Application Support') },
      `working directory ${CONTAINS}`
    ],
    // 写授权：每一个都过同一套判定
    ['写授权是 /', { grantedWrite: ['/'] }, `a write grant ${COVERS}`],
    ['写授权是家目录', { grantedWrite: [HOME] }, `a write grant ${COVERS}`],
    ['写授权是 /Users', { grantedWrite: ['/Users'] }, `a write grant ${COVERS}`],
    ['写授权是 ~/.shuvix', { grantedWrite: [SHUVIX] }, `a write grant ${CONFIG}`],
    [
      '写授权在 ~/.shuvix/policies 里',
      { grantedWrite: [`${SHUVIX}/policies`] },
      `a write grant ${CONFIG}`
    ],
    [
      '写授权是 ~/.shuvix/agents 里的一个文件',
      { grantedWrite: [`${SHUVIX}/agents/x.md`] },
      `a write grant ${CONFIG}`
    ],
    ['写授权在 userData 里', { grantedWrite: [`${USER_DATA}/data`] }, `a write grant ${APP_DATA}`],
    [
      '写授权是别的会话的临时工作区',
      { grantedWrite: [`${USER_DATA}/temp_workspace/OTHER`] },
      `a write grant ${APP_DATA}`
    ],
    [
      '写授权是 ~/Library（包含 userData）',
      { grantedWrite: [h('Library')] },
      `a write grant ${CONTAINS}`
    ],
    [
      '写授权是 ~/Library/Application Support',
      { grantedWrite: [h('Library/Application Support')] },
      `a write grant ${CONTAINS}`
    ],
    [
      '几个写授权里只要有一个不合适',
      { grantedWrite: ['/Volumes/data', `${SHUVIX}/widgets/w`, `${SHUVIX}/hooks`] },
      `a write grant ${CONFIG}`
    ]
  ]
  it.each(cases)('SP-1 %s', (_label, over, reason) => {
    const result = build(over)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe(reason)
  })

  it('SP-1 「包含」看的是 ~/.shuvix 与 userData 本身：它们不在家目录根上时，包含它们的目录照样不合适', () => {
    const moved: SandboxHostPaths = {
      ...PATHS,
      shuvixHome: '/Volumes/cfg/.shuvix',
      cliSocket: '/Volumes/cfg/.shuvix/cli.sock',
      cliToken: '/Volumes/cfg/.shuvix/cli-token'
    }
    const ws = build({ workingDirectory: '/Volumes/cfg' }, moved)
    expect(!ws.ok && ws.reason).toBe(`working directory ${CONTAINS}`)
    const grant = build({ grantedWrite: ['/Volumes'] }, moved)
    expect(!grant.ok && grant.reason).toBe(`a write grant ${CONTAINS}`)
    // 同一个目录在默认布局里不包含任何东西
    expect(build({ workingDirectory: '/Volumes/cfg' }).ok).toBe(true)
  })

  it('SP-1 原因的先后：坏会话 id 先于工作目录，工作目录先于写授权；覆盖家目录先于「是 / 在里面」先于「包含」', () => {
    const badIdAndRoot = build({ sessionId: '', workingDirectory: '/', grantedWrite: ['/'] })
    expect(!badIdAndRoot.ok && badIdAndRoot.reason).toBe('unsafe session id')
    const rootAndGrant = build({ workingDirectory: '/', grantedWrite: [HOME] })
    expect(!rootAndGrant.ok && rootAndGrant.reason).toBe(`working directory ${COVERS}`)
    const libraryAndGrant = build({ workingDirectory: h('Library'), grantedWrite: [HOME] })
    expect(!libraryAndGrant.ok && libraryAndGrant.reason).toBe(`working directory ${CONTAINS}`)
    // / 覆盖家目录，也包含 ~/.shuvix —— 说的是前者
    const root = build({ grantedWrite: ['/'] })
    expect(!root.ok && root.reason).toBe(`a write grant ${COVERS}`)
  })
})

describe('SP-2 套得上的工作目录与授权（按路径段边界判）', () => {
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
    ['~/Documents 里的项目', { workingDirectory: h('Documents/proj') }],
    ['工作目录就是 ~/Documents', { workingDirectory: h('Documents') }],
    ['~/Library 里不含 ShuviX 东西的目录', { workingDirectory: h('Library/Caches/x') }],
    ['家目录以外：外接卷', { workingDirectory: '/Volumes/x' }],
    ['家目录以外：/private/tmp 里', { workingDirectory: '/private/tmp/x' }],
    // 凭据不再单列：~/.ssh 在家目录里，平时由「会话目录以外」挡住；用户把它选成工作目录就是他的项目
    ['~/.ssh（凭据不再单列）', { workingDirectory: h('.ssh') }],
    ['写授权在家目录以外', { grantedWrite: ['/Volumes/data/shared'] }],
    ['写授权在家目录里的普通目录', { grantedWrite: [h('w2')] }],
    [
      '写授权在 ~/.shuvix 的内容目录里（知识库、widget）',
      { grantedWrite: [`${SHUVIX}/knowledge/b`, `${SHUVIX}/widgets/w`] }
    ],
    ['写授权是本会话的临时工作区', { grantedWrite: [TEMP_WS] }],
    // 读授权不过这套判定：读不到沙箱开关之外的东西，「允许并记住」读哪儿是用户的事
    ['读授权是 /（读授权覆盖家目录不拒）', { grantedRead: ['/'] }],
    ['读授权是家目录', { grantedRead: [HOME] }],
    ['读授权是 ~/Library', { grantedRead: [h('Library')] }],
    ['读授权在 ~/.shuvix/policies 里', { grantedRead: [`${SHUVIX}/policies`] }],
    ['读授权在 userData 里', { grantedRead: [`${USER_DATA}/data`] }]
  ]
  it.each(accepted)('SP-2 %s', (_label, over) => {
    const result = build(over)
    expect(result.ok, !result.ok ? result.reason : '').toBe(true)
  })
})

describe('SP-3 会话目录清单（sessionDirsFor）', () => {
  it('SP-3 tmpDir = tmpRoot/<sha256(id) 前 8 位>；稳定、不同 id 不同', () => {
    const expected = createHash('sha256').update(SID).digest('hex').slice(0, 8)
    expect(sessionTmpName(SID)).toBe(expected)
    expect(sessionTmpName(SID)).toMatch(/^[0-9a-f]{8}$/)
    expect(sessionTmpName(SID)).toBe(sessionTmpName(SID))
    expect(sessionTmpName('sess-2')).not.toBe(sessionTmpName(SID))
    expect(sessionDirsFor(PATHS, input(), identity)!.tmpDir).toBe(`${TMP_ROOT}/${expected}`)
  })

  it('SP-3 正常工作目录：恰为 [工作目录, 本会话临时目录, 本会话 artifacts, 本会话工具结果]', () => {
    expect(sessionDirsFor(PATHS, input(), identity)).toEqual({
      dirs: SESSION_DIRS,
      readDirs: [],
      workspaceUnsuitable: null,
      tmpDir: TMP_DIR
    })
  })

  it('SP-3 只看会话 id 与工作目录：授权、ShuviX 自己的程序都不是会话目录', () => {
    const dirs = sessionDirsFor(
      { ...PATHS, appPaths: [APP, h('dev/shuvix')] },
      input({ grantedRead: [h('ref')], grantedWrite: ['/Volumes/data'] }),
      identity
    )!.dirs
    expect(dirs).toEqual(SESSION_DIRS)
  })

  it.each([
    ['/', 'working directory covers the home folder'],
    [HOME, 'working directory covers the home folder'],
    [`${SHUVIX}/agents`, "ShuviX's own configuration"],
    [`${USER_DATA}/data`, "ShuviX's application data"],
    [h('Library'), "contains ShuviX's own configuration or application data"]
  ])(
    'SP-3 工作目录 %s 不适合：不在清单里（其余三项照旧），并说明原因',
    (workingDirectory, reason) => {
      const session = sessionDirsFor(PATHS, input({ workingDirectory }), identity)!
      expect(session.dirs).toEqual([TMP_DIR, ARTIFACTS, TOOL_RESULTS_SID])
      expect(session.workspaceUnsuitable).toContain(reason)
      expect(session.tmpDir).toBe(TMP_DIR)
    }
  )

  it.each(['', '.', '..', 'a/b', 'a\\b', 'x..y'])(
    'SP-3 会话 id %j 不安全：没有清单（null），不是空清单',
    (sessionId) => {
      expect(sessionDirsFor(PATHS, input({ sessionId }), identity)).toBeNull()
    }
  )

  it('SP-3 去重：工作目录就是本会话 artifacts 时只出现一次（排在最前）', () => {
    const session = sessionDirsFor(PATHS, input({ workingDirectory: ARTIFACTS }), identity)!
    expect(session.dirs).toEqual([ARTIFACTS, TMP_DIR, TOOL_RESULTS_SID])
  })

  it('SP-3 本会话临时工作区：工作目录在清单里，别的会话的临时工作区不在', () => {
    const session = sessionDirsFor(PATHS, input({ workingDirectory: TEMP_WS }), identity)!
    expect(session.dirs).toEqual([TEMP_WS, TMP_DIR, ARTIFACTS, TOOL_RESULTS_SID])
    expect(session.dirs.some((d) => isWithin(`${USER_DATA}/temp_workspace/OTHER`, d))).toBe(false)
  })

  it('SP-3 规格的 sessionDirs 就是这份清单（同一个函数算的，两面不会漂移）', () => {
    for (const workingDirectory of [WS, TEMP_WS, h('Documents/proj'), '/Volumes/x']) {
      const spec = specOf({ workingDirectory, grantedWrite: ['/Volumes/w'] })
      expect(spec.sessionDirs).toEqual(
        sessionDirsFor(PATHS, input({ workingDirectory }), identity)!.dirs
      )
    }
  })
})

describe('SP-3x 会话设置带来的目录（extras）', () => {
  /** 可读写：本会话勾选的知识库 */
  const KB = `${SHUVIX}/knowledge/notes`
  const KB_PROJECT = `${SHUVIX}/knowledge-shuvix/projects/p1`
  /** 只读：技能目录（用户的、外部的、内置的）与只读的内置知识库 */
  const SKILLS = `${SHUVIX}/skills`
  const SKILLS_EXT = h('my-skills')
  const SKILLS_BUILTIN = `${APP}/Contents/Resources/skills/en`
  const BUILTIN_KB = `${APP}/Contents/Resources/knowledge/shuvix/en`
  const EXTRAS = {
    readWrite: [KB, KB_PROJECT],
    readOnly: [SKILLS, SKILLS_EXT, SKILLS_BUILTIN, BUILTIN_KB]
  }

  it('SP-3x 可读写的接在会话目录后面；只读的单独成一份 readDirs（各按给的顺序）', () => {
    expect(sessionDirsFor(PATHS, input({ extras: EXTRAS }), identity)).toEqual({
      dirs: [...SESSION_DIRS, KB, KB_PROJECT],
      readDirs: [SKILLS, SKILLS_EXT, SKILLS_BUILTIN, BUILTIN_KB],
      workspaceUnsuitable: null,
      tmpDir: TMP_DIR
    })
  })

  it('SP-3x 没有 extras 与两份空清单一样：readDirs 为空', () => {
    const none = sessionDirsFor(PATHS, input(), identity)
    const empty = sessionDirsFor(
      PATHS,
      input({ extras: { readWrite: [], readOnly: [] } }),
      identity
    )
    expect(empty).toEqual(none)
    expect(none!.readDirs).toEqual([])
  })

  it.each([
    ['空串', ''],
    ['/', '/'],
    ['家目录', HOME],
    ['覆盖家目录的 /Users', '/Users']
  ])('SP-3x %s：两份清单里都丢掉，旁边的照留', (_label, bad) => {
    const session = sessionDirsFor(
      PATHS,
      input({ extras: { readWrite: [bad, KB], readOnly: [bad, SKILLS] } }),
      identity
    )!
    expect(session.dirs).toEqual([...SESSION_DIRS, KB])
    expect(session.readDirs).toEqual([SKILLS])
  })

  it('SP-3x 去重：可读写里重复的只留一个；只读里与读写清单（含工作目录、artifacts）相同的去掉，重复的只留一个', () => {
    const session = sessionDirsFor(
      PATHS,
      input({
        extras: {
          readWrite: [KB, KB, WS],
          readOnly: [KB, WS, ARTIFACTS, SKILLS, SKILLS]
        }
      }),
      identity
    )!
    expect(session.dirs).toEqual([...SESSION_DIRS, KB])
    expect(session.readDirs).toEqual([SKILLS])
  })

  it('SP-3x 工作目录不适合时 extras 照给（它们与工作目录无关）', () => {
    const session = sessionDirsFor(
      PATHS,
      input({ workingDirectory: HOME, extras: EXTRAS }),
      identity
    )!
    expect(session.workspaceUnsuitable).toContain('covers the home folder')
    expect(session.dirs).toEqual([TMP_DIR, ARTIFACTS, TOOL_RESULTS_SID, KB, KB_PROJECT])
    expect(session.readDirs).toEqual(EXTRAS.readOnly)
  })

  it('SP-3x 坏会话 id：有 extras 也没有清单', () => {
    expect(sessionDirsFor(PATHS, input({ sessionId: '..', extras: EXTRAS }), identity)).toBeNull()
  })

  it('SP-3x extras 先过 `real`：链接按指向记；指向家目录的链接丢掉；两项指向同一处只留一个', () => {
    const LINKS = new Map<string, string>([
      ['/Volumes/kb-link', KB],
      ['/Volumes/kb-link-2', KB],
      ['/Volumes/home-link', HOME],
      ['/Volumes/skills-link', SKILLS]
    ])
    const real = (p: string): string => LINKS.get(p) ?? p
    const session = sessionDirsFor(
      PATHS,
      input({
        extras: {
          readWrite: ['/Volumes/kb-link', '/Volumes/kb-link-2', '/Volumes/home-link'],
          readOnly: ['/Volumes/skills-link', '/Volumes/home-link', '/Volumes/kb-link']
        }
      }),
      real
    )!
    expect(session.dirs).toEqual([...SESSION_DIRS, KB])
    expect(session.readDirs).toEqual([SKILLS])
  })

  it('SP-3x 规格：可读写的 extras 进会话目录（可读可写）；只读的进 sessionReadDirs（可读不可写）；可读根的顺序 = 会话目录、只读会话目录、写授权、读授权、程序', () => {
    const GRANT_W = '/Volumes/data/shared'
    const GRANT_R = h('ref')
    const spec = specOf({ extras: EXTRAS, grantedWrite: [GRANT_W], grantedRead: [GRANT_R, SKILLS] })
    const sessionDirs = [...SESSION_DIRS, KB, KB_PROJECT]
    expect(spec.sessionDirs).toEqual(sessionDirs)
    expect(spec.sessionReadDirs).toEqual(EXTRAS.readOnly)
    // 与读授权重复的只读目录只出现一次（排在只读会话目录那一段）
    expect(spec.readableRoots).toEqual([...sessionDirs, ...EXTRAS.readOnly, GRANT_W, GRANT_R, APP])
    expect(spec.writableRoots).toEqual([...sessionDirs, GRANT_W])
    for (const ro of EXTRAS.readOnly) {
      expect(
        spec.writableRoots.some((r) => isWithin(ro, r)),
        ro
      ).toBe(false)
    }
  })

  it('SP-3x 规格：家目录里的 extras 也有上级目录的元数据（~/.shuvix/knowledge、~/.shuvix/skills 的上级）', () => {
    const spec = specOf({ extras: EXTRAS })
    expect(spec.metadataPaths).toEqual(
      expect.arrayContaining([
        `${SHUVIX}/knowledge`,
        `${SHUVIX}/knowledge-shuvix/projects`,
        SHUVIX,
        HOME
      ])
    )
    // 只读的那几个本身不只是元数据：它们是可读根
    expect(spec.metadataPaths).not.toContain(SKILLS)
    expect(spec.metadataPaths).not.toContain(SKILLS_EXT)
  })
})

describe('SP-4 规格的各个字段', () => {
  const GRANT_W = '/Volumes/data/shared'
  const GRANT_R = h('ref')

  it('SP-4 一个写授权、一个读授权：每个字段逐一钉住，没有多余的键', () => {
    const spec = specOf({ grantedWrite: [GRANT_W], grantedRead: [GRANT_R] })
    expect(spec).toEqual({
      sessionId: SID,
      workingDirectory: WS,
      home: HOME,
      sessionDirs: SESSION_DIRS,
      sessionReadDirs: [],
      readableRoots: [...SESSION_DIRS, GRANT_W, GRANT_R, APP],
      readableFiles: [CLI_TOKEN],
      metadataPaths: expect.any(Array),
      writableRoots: [...SESSION_DIRS, GRANT_W],
      unixSockets: [CLI_SOCKET, MDNS_RESPONDER_SOCKET],
      unixSocketDirs: [TMP_DIR, WS],
      tmpDir: TMP_DIR
    })
    expect(MDNS_RESPONDER_SOCKET).toBe('/private/var/run/mDNSResponder')
  })

  it('SP-4 读授权只可读、不可写；写授权可读可写；ShuviX 自己的程序只可读', () => {
    const spec = specOf({ grantedWrite: [GRANT_W], grantedRead: [GRANT_R] })
    expect(spec.readableRoots).toContain(GRANT_R)
    expect(spec.writableRoots).not.toContain(GRANT_R)
    expect(spec.readableRoots).toContain(GRANT_W)
    expect(spec.writableRoots).toContain(GRANT_W)
    expect(spec.readableRoots).toContain(APP)
    expect(spec.writableRoots).not.toContain(APP)
  })

  it('SP-4 cli-token 是唯一的可读文件：只可读、不在任何根里、也不可写', () => {
    const spec = specOf()
    expect(spec.readableFiles).toEqual([CLI_TOKEN])
    expect(spec.readableRoots.some((r) => isWithin(CLI_TOKEN, r))).toBe(false)
    expect(spec.writableRoots.some((r) => isWithin(CLI_TOKEN, r))).toBe(false)
  })

  it('SP-4 去重：等于工作目录的写授权、同时是读授权的写授权、重复的程序目录各只出现一次（写授权排在读授权前）', () => {
    const spec = specOf(
      { grantedWrite: [WS, GRANT_W, GRANT_W], grantedRead: [GRANT_W, GRANT_R, GRANT_R] },
      { ...PATHS, appPaths: [APP, APP] }
    )
    expect(spec.readableRoots).toEqual([...SESSION_DIRS, GRANT_W, GRANT_R, APP])
    expect(spec.writableRoots).toEqual([...SESSION_DIRS, GRANT_W])
  })

  it('SP-4 没有授权、没有程序目录：可读根 = 可写根 = 会话目录', () => {
    const spec = specOf({}, { ...PATHS, appPaths: [] })
    expect(spec.readableRoots).toEqual(SESSION_DIRS)
    expect(spec.writableRoots).toEqual(SESSION_DIRS)
  })

  it('SP-4 没有放行清单：包缓存、/private/tmp、/tmp 都不是可写根', () => {
    const spec = specOf({ grantedWrite: [GRANT_W] })
    for (const p of [
      h('.npm'),
      h('.cache'),
      h('Library/Caches/pip'),
      h('.cargo/registry'),
      '/private/tmp',
      '/tmp',
      TMP_ROOT
    ]) {
      expect(
        spec.writableRoots.some((r) => isWithin(p, r)),
        p
      ).toBe(false)
    }
  })

  it('SP-4 读授权覆盖家目录：整个家目录可读，但不可写（与「写授权覆盖家目录就不套」不对称）', () => {
    const spec = specOf({ grantedRead: [HOME] })
    expect(spec.readableRoots).toContain(HOME)
    expect(spec.writableRoots).toEqual(SESSION_DIRS)
  })
})

describe('SP-5 上级目录的元数据（metadataPaths）', () => {
  it('SP-5 夹具：家目录里每个可读根 / cli-token / CLI socket 的每一级上级，到家目录为止，按出现顺序去重', () => {
    expect(specOf().metadataPaths).toEqual([
      // 工作目录 ~/proj
      HOME,
      // 本会话 artifacts ~/.shuvix/artifacts/<id>
      `${SHUVIX}/artifacts`,
      SHUVIX,
      // 本会话工具结果 userData/tool_results/<id>
      TOOL_RESULTS,
      USER_DATA,
      h('Library/Application Support'),
      h('Library')
      // 本会话临时目录与 /Applications 下的程序在家目录以外：没有；cli-token / cli.sock 的上级已经在里面
    ])
  })

  it.each<[string, Partial<SandboxSessionInput>, SandboxHostPaths]>([
    ['默认', {}, PATHS],
    [
      '嵌套的工作目录 + 家目录里的读写授权',
      {
        workingDirectory: h('Documents/a/proj'),
        grantedRead: [h('ref/x')],
        grantedWrite: [h('w/y')]
      },
      PATHS
    ],
    [
      '家目录以外的工作目录与授权',
      { workingDirectory: '/Volumes/p', grantedRead: ['/opt/r'], grantedWrite: ['/Volumes/w'] },
      PATHS
    ],
    [
      '开发态：程序在家目录里',
      {},
      { ...PATHS, appPaths: [h('dev/ShuviX/out/main'), h('dev/ShuviX/resources/cli')] }
    ],
    ['e2e 布局', { workingDirectory: `${E2E_HOME}/proj` }, E2E_PATHS]
  ])(
    'SP-5 性质（%s）：每一项都在家目录里、是某个可读根 / 可读文件 / CLI socket 的严格上级；家目录以外的一项都没有',
    (_label, over, paths) => {
      const spec = specOf(over, paths)
      const targets = [...spec.readableRoots, ...spec.readableFiles, paths.cliSocket]
      expect(spec.metadataPaths.length).toBeGreaterThan(0)
      expect(new Set(spec.metadataPaths).size).toBe(spec.metadataPaths.length)
      for (const m of spec.metadataPaths) {
        expect(isWithin(m, spec.home), m).toBe(true)
        expect(
          targets.some((t) => t !== m && isWithin(t, m)),
          `${m} is an ancestor of something readable`
        ).toBe(true)
      }
      // 反过来：家目录里的每个目标，它到家目录的每一级上级都在里面
      for (const t of targets) {
        if (!isWithin(t, spec.home) || t === spec.home) continue
        let cur = t.slice(0, t.lastIndexOf('/'))
        while (isWithin(cur, spec.home)) {
          expect(spec.metadataPaths, `${cur} (ancestor of ${t})`).toContain(cur)
          if (cur === spec.home) break
          cur = cur.slice(0, cur.lastIndexOf('/'))
        }
      }
    }
  )

  it('SP-5 嵌套的工作目录：~/Documents/a/proj → ~/Documents/a 与 ~/Documents 都只放元数据', () => {
    const spec = specOf({ workingDirectory: h('Documents/a/proj') })
    expect(spec.metadataPaths).toEqual(expect.arrayContaining([h('Documents/a'), h('Documents')]))
    expect(spec.readableRoots).not.toContain(h('Documents'))
  })

  it('SP-5 家目录以外的东西不产生元数据：/Users、/private/tmp、/Volumes、/Applications 都不在里面', () => {
    const spec = specOf({ workingDirectory: '/Volumes/p', grantedWrite: ['/Volumes/w'] })
    for (const p of ['/Users', '/', '/private/tmp', TMP_ROOT, '/Volumes', '/Applications']) {
      expect(spec.metadataPaths).not.toContain(p)
    }
  })

  it('SP-5 读授权就是家目录：它自己不产生元数据（家目录已整个可读）', () => {
    const withGrant = specOf({ grantedRead: [HOME] })
    expect(withGrant.metadataPaths).toEqual(specOf().metadataPaths)
  })

  it('SP-5 e2e 布局：家目录在 /private/tmp 里，本会话临时目录在它外面 —— /private/tmp 本身不放', () => {
    const spec = specOf({ workingDirectory: `${E2E_HOME}/proj` }, E2E_PATHS)
    expect(spec.home).toBe(E2E_HOME)
    expect(spec.metadataPaths[0]).toBe(E2E_HOME)
    expect(spec.metadataPaths).not.toContain('/private/tmp')
    expect(spec.metadataPaths.every((m) => isWithin(m, E2E_HOME))).toBe(true)
  })
})

describe('SP-6 `real` 在一切判断之前应用', () => {
  /** 按前缀映射的「真实路径」：/Users/link 指向家目录，/tmp → /private/tmp，几个链接指向别处 */
  const LINKS: Array<[string, string]> = [
    ['/Users/link', HOME],
    ['/tmp', '/private/tmp'],
    ['/g1', '/Volumes/data/shared'],
    ['/g2', '/Volumes/data/shared'],
    ['/Volumes/agents-link', `${SHUVIX}/agents`],
    ['/opt/app-link', APP]
  ]
  const real = (p: string): string => {
    for (const [from, to] of LINKS) {
      if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length)
    }
    return p
  }

  it('SP-6 工作目录按解析后的路径记（规格、socket 目录都是）', () => {
    const spec = specOf({ workingDirectory: '/tmp/ws' }, PATHS, real)
    expect(spec.workingDirectory).toBe('/private/tmp/ws')
    expect(spec.sessionDirs[0]).toBe('/private/tmp/ws')
    expect(spec.unixSocketDirs).toEqual([TMP_DIR, '/private/tmp/ws'])
  })

  it('SP-6 解析到家目录的写授权被拒；解析到 ~/.shuvix/agents 的工作目录被拒', () => {
    const grant = build({ grantedWrite: ['/Users/link'] }, PATHS, real)
    expect(!grant.ok && grant.reason).toContain('a write grant covers the home folder')
    const ws = build({ workingDirectory: '/Volumes/agents-link/x' }, PATHS, real)
    expect(!ws.ok && ws.reason).toContain("ShuviX's own configuration")
  })

  it('SP-6 指向同一处的两个写授权合成一个根；读授权同理', () => {
    const spec = specOf({ grantedWrite: ['/g1', '/g2'], grantedRead: ['/g2'] }, PATHS, real)
    expect(spec.writableRoots.filter((r) => r === '/Volumes/data/shared')).toHaveLength(1)
    expect(spec.readableRoots.filter((r) => r === '/Volumes/data/shared')).toHaveLength(1)
    expect(JSON.stringify(spec)).not.toMatch(/"\/g[12]"/)
  })

  it('SP-6 宿主路径整份按链接写（家目录是 /Users/link）：规格里只有解析后的家目录，元数据也按它算', () => {
    const linked: SandboxHostPaths = {
      ...PATHS,
      home: '/Users/link',
      userData: '/Users/link/Library/Application Support/ShuviX',
      shuvixHome: '/Users/link/.shuvix',
      toolResultsBase: '/Users/link/Library/Application Support/ShuviX/tool_results',
      cliSocket: '/Users/link/.shuvix/cli.sock',
      cliToken: '/Users/link/.shuvix/cli-token',
      appPaths: ['/opt/app-link']
    }
    const spec = specOf({ workingDirectory: '/Users/link/proj' }, linked, real)
    expect(JSON.stringify(spec)).not.toContain('/Users/link')
    expect(spec).toEqual(specOf({}, PATHS, identity))
  })

  it('SP-6 「工作目录在 userData 里」按解析后的 userData 判：userData 写成链接，工作目录写成真实路径，照样被拒', () => {
    const linked: SandboxHostPaths = {
      ...PATHS,
      userData: '/Users/link/Library/Application Support/ShuviX'
    }
    const result = build({ workingDirectory: `${USER_DATA}/data` }, linked, real)
    expect(!result.ok && result.reason).toContain('application data')
  })
})

describe('SP-7 isWithin', () => {
  it('SP-7 按路径段边界比', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
    expect(isWithin('/a/b/c', '/a/b')).toBe(true)
    expect(isWithin('/a/bc', '/a/b')).toBe(false)
    expect(isWithin('/a/b/c', '/a/b/')).toBe(true)
    expect(isWithin('/a', '/a/b')).toBe(false)
    expect(isWithin('/anything', '/')).toBe(true)
  })
})
