/**
 * 路径策略按**真实去处**判 —— 桌面端到端：真临时目录树 + 真符号链接 + 真的桌面 provider
 * （makeDesktopSecurityProvider：realPath = resolveRealPath）+ 真的内置策略 md + 真的
 * isPathWithinWorkspace。
 *
 * mock 照 askPolicy.test.ts：dao / sessionService / skillService / policyService / paths / logger；
 * 另把 `os.homedir` 换成本用例的临时家目录 —— 凭据门（protect-credentials）的 credentialDirs
 * 由 vars.home 算出，家目录得真在盘上，链接才有地方可指。fs / path 不 mock：realPath.ts 读的是
 * node:fs / node:path，要测的恰是真文件系统上的解析。sessionService.addAllowListPaths 抄一份实参
 * （RPP-7 看「允许并记住」记下的是哪个位置），sessionDao.pickSettings 喂会话授权。
 *
 * macOS 上 tmpdir 在 /var → /private/var 这条系统级链接之下：变量表照写法给（/var/folders/…），
 * 解析之后是 /private/var/folders/…（protect-system 的 /private/var 里挖掉了它）。期望一律按
 * realpathSync.native 算，写法一律从 mkdtemp 的原样起算。符号链接在 Windows 上要开发者模式，整份跳过。
 *
 * RPP-A 一组：ask-on-write 对**本会话自己的** artifacts 目录（vars.sessionArtifactsDir
 * = getSessionArtifactsDir(ctx.sessionId)，这里是 <ROOT>/artifacts/<id>）免询问（读哪儿都不问，只有凭据
 * 位置例外）。豁免同样按真实去处判：
 * 目录里的链接按它指向哪儿过门（凭据照拒、区外照问），`..` 与链接走出这个目录就不再豁免；
 * artifact store 真正写出来的文件只对自己的会话免询问，也不留下任何授权。
 *
 * 工作区写入视图（ask-on-write 的 vars.workspace*，sandbox.workspaceWriteView 给、与沙箱开没开无关）：
 * sandbox 模块用真实实现 + workspaceWriteView 的透传 spy（照 askPolicy.test.ts），electron 的 app.getPath
 * 有替身（<ROOT>/userData）。**旧用例在 beforeEach 里显式拿到空视图** —— 它们钉的是询问链本身，「区内写
 * 要问」只在空视图下成立；过去这一点靠的是没 mock electron 时 app.getPath 抛错被吞掉。RPP-W1 与 RPP-4 /
 * RPP-5 的后半段换回真实实现：视图算得出来（[真实工作区]），豁免同样按真实去处判。
 *
 * RPP-C1：protect-shuvix-config（force-ask）守 vars.shuvixConfigDirs，同样按真实去处判 —— 工作区里指向
 * <~/.shuvix>/agents 的链接照问（这里 agents 目录是 <ROOT>/agents）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AskInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'

const state = vi.hoisted(() => ({
  /** 本用例的临时根（beforeAll 建）；paths mock 的各目录都挂在它下面 */
  root: '',
  /** os.homedir() 给出的家目录（用例可换成 .ssh 本身是链接的那一个） */
  home: '',
  /** app.getPath('userData') 的替身（工作区写入视图的规格要它；盘上不存在也行） */
  userData: '/nonexistent-shuvix-rpp-userdata',
  settings: undefined as { autoAllow?: boolean; allowList?: string[] } | undefined,
  /** sessionService.addAllowListPaths 收到的实参 */
  granted: [] as Array<{ sessionId: string; mode: string; paths: string[] }>,
  // 内置策略的事实源 —— 运行时读随包发布的目录，这里直接读仓库里那一份（同一批文件）。
  // src/main/services/__tests__ 往上六级是仓库根
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

vi.mock('electron', () => ({ app: { getPath: () => state.userData, isPackaged: false } }))
// 真实模块 + workspaceWriteView 换成透传 spy：旧用例按用例给空视图，RPP-W1 等回到真实实现
vi.mock('../sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandbox')>()
  return { ...actual, workspaceWriteView: vi.fn(actual.workspaceWriteView) }
})
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, default: actual, homedir: () => state.home || actual.homedir() }
})
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pickSettings: () => state.settings }
}))
vi.mock('../sessionService', () => ({
  sessionService: {
    getById: () => undefined,
    addAllowListPaths: (sessionId: string, mode: string, paths: string[]) =>
      void state.granted.push({ sessionId, mode, paths })
  }
}))
vi.mock('../skillService', () => ({ skillService: { listExternalDirs: () => [] } }))
vi.mock('../policyService', () => ({
  policyService: {
    getUserPolicies: () => [],
    readBuiltinPolicyMd: (fileName: string) => {
      try {
        return readFileSync(join(state.builtinDir, fileName), 'utf-8')
      } catch {
        return null
      }
    }
  }
}))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: () => join(state.root, 'ws'),
  getToolResultsBase: () => join(state.root, 'tool-results'),
  getDefaultSkillsDir: () => join(state.root, 'skills'),
  getBuiltinSkillsDir: () => join(state.root, 'builtin-skills'),
  getMemoryRootDir: () => join(state.root, 'memory'),
  getDefaultBotsDir: () => join(state.root, 'bots'),
  // protect-shuvix-config 的四个目录（getVars 的 shuvixConfigDirs）
  getDefaultPoliciesDir: () => join(state.root, 'policies'),
  getDefaultAgentsDir: () => join(state.root, 'agents'),
  getDefaultHooksDir: () => join(state.root, 'hooks'),
  getBuiltinKnowledgeDir: () => join(state.root, 'builtin-knowledge'),
  getSessionArtifactsDir: (id: string) => join(state.root, 'artifacts', id),
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  getDesktopSecurityContext,
  isPathWithinWorkspace,
  makeDesktopSecurityProvider,
  type ProjectConfig
} from '../toolContext'
import { writeArtifact } from '../artifacts/store'
import { workspaceWriteView } from '../sandbox'
import type { SecurityContext, SecurityDecision } from '@shuvix/agent-runtime'

/** 抓住一次拒绝的原话 */
async function rejectionOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected the promise to reject')
}

const verdict = (d: SecurityDecision): { effect: string; winning: string } => ({
  effect: d.effect,
  winning: d.winning
})

const workspaceWriteViewSpy = vi.mocked(workspaceWriteView)
/** 空的工作区写入视图（Windows、工作区不适合、规格算不出来时 workspaceWriteView 给的就是它） */
const emptyWorkspaceView = (): ReturnType<typeof workspaceWriteView> => ({
  workspaceWritable: [],
  workspaceWriteDenied: [],
  workspaceProtectedPatterns: []
})
/** 回到真实的 workspaceWriteView（vi.fn(impl) 的 mockReset = 透传原实现） */
const restoreComputedWorkspaceView = (): void => {
  workspaceWriteViewSpy.mockReset()
}

describe.skipIf(process.platform === 'win32')('路径策略按真实去处判（桌面端到端）', () => {
  /** 写法（mkdtemp 原样）与真实去处 */
  let ROOT = ''
  let REAL_ROOT = ''
  let WS = ''
  let REAL_WS = ''
  let WS_LINK = ''
  /** 家目录 A：.ssh 是真目录；家目录 B：.ssh → dotfiles/ssh */
  let HOME = ''
  let REAL_HOME = ''
  let HOME_B = ''
  /** 所有会话的 artifacts 根（写法；getSessionArtifactsDir 的 mock 挂在这下面） */
  let ART = ''

  const config: ProjectConfig = { workingDirectory: '' }
  const asks: InputRequest[] = []
  let respond: (req: InputRequest) => InputResponse = () => ({ kind: 'ask', allowed: false })

  const context = (sessionId = 's1'): SecurityContext =>
    getDesktopSecurityContext(
      {
        sessionId,
        requestUserInput: async (req) => {
          asks.push(req)
          return respond(req)
        }
      },
      () => config
    )
  const evaluatePath = (mode: 'read' | 'write', path: string, sessionId = 's1'): SecurityDecision =>
    context(sessionId).evaluate(mode, { type: 'path', path })
  /** 这一刻的桌面变量表（前提断言用：工作区写入视图是哪一组） */
  const varsNow = (sessionId = 's1'): Record<string, unknown> =>
    makeDesktopSecurityProvider({ sessionId }, () => config).getVars() as Record<string, unknown>

  /**
   * 目录树（ROOT 下）：
   *   home/.ssh/id_rsa、home/.ssh/config
   *   home-b/dotfiles/ssh/id_rsa；home-b/.ssh → home-b/dotfiles/ssh
   *   outside/target.txt、outside/doc.txt
   *   sibling/
   *   ws/notes.txt
   *   ws/key → home/.ssh/id_rsa          ws/sshlink → home/.ssh       ws/etclink → /etc
   *   ws/vlink → /var/log/shuvix-rpp-never/x（悬空）
   *   ws/wlink → outside/target.txt      ws/rlink → outside/doc.txt
   *   wslink → ws
   *   home/.bashrc
   *   artifacts/s1/、artifacts/s2/（本会话 s1 与另一场会话的 artifacts 目录）
   *   artifacts/s1/rc → home/.bashrc          artifacts/s1/key → home/.ssh/id_rsa
   *   artifacts/s1/sshlink → home/.ssh        artifacts/s1/dangling → home/.ssh/authorized_keys（悬空）
   *   artifacts/s1/up → artifacts
   *   agents/x.md（ShuviX 自己的配置 —— getDefaultAgentsDir 的 mock）；ws/agentlink → agents/x.md
   *   ws/.git/hooks/pre-commit；outside/nlink → ws/notes.txt；outside/hooklink → ws/.git/hooks/pre-commit
   *   userData（app.getPath 的替身，不建出来）
   */
  beforeAll(() => {
    ROOT = mkdtempSync(join(tmpdir(), 'shuvix-rpp-'))
    REAL_ROOT = realpathSync.native(ROOT)
    state.root = ROOT
    HOME = join(ROOT, 'home')
    HOME_B = join(ROOT, 'home-b')
    WS = join(ROOT, 'ws')
    WS_LINK = join(ROOT, 'wslink')

    mkdirSync(join(HOME, '.ssh'), { recursive: true })
    writeFileSync(join(HOME, '.ssh', 'id_rsa'), 'PRIVATE KEY')
    writeFileSync(join(HOME, '.ssh', 'config'), 'Host x')
    mkdirSync(join(HOME_B, 'dotfiles', 'ssh'), { recursive: true })
    writeFileSync(join(HOME_B, 'dotfiles', 'ssh', 'id_rsa'), 'PRIVATE KEY B')
    symlinkSync(join(HOME_B, 'dotfiles', 'ssh'), join(HOME_B, '.ssh'))
    mkdirSync(join(ROOT, 'outside'))
    writeFileSync(join(ROOT, 'outside', 'target.txt'), 'old\n')
    writeFileSync(join(ROOT, 'outside', 'doc.txt'), 'doc')
    mkdirSync(join(ROOT, 'sibling'))
    mkdirSync(WS)
    writeFileSync(join(WS, 'notes.txt'), 'notes')
    symlinkSync(join(HOME, '.ssh', 'id_rsa'), join(WS, 'key'))
    symlinkSync(join(HOME, '.ssh'), join(WS, 'sshlink'))
    symlinkSync('/etc', join(WS, 'etclink'))
    symlinkSync('/var/log/shuvix-rpp-never/x', join(WS, 'vlink'))
    symlinkSync(join(ROOT, 'outside', 'target.txt'), join(WS, 'wlink'))
    symlinkSync(join(ROOT, 'outside', 'doc.txt'), join(WS, 'rlink'))
    symlinkSync(WS, WS_LINK)

    ART = join(ROOT, 'artifacts')
    mkdirSync(join(ART, 's1'), { recursive: true })
    mkdirSync(join(ART, 's2'))
    writeFileSync(join(HOME, '.bashrc'), 'export X=1')
    symlinkSync(join(HOME, '.bashrc'), join(ART, 's1', 'rc'))
    symlinkSync(join(HOME, '.ssh', 'id_rsa'), join(ART, 's1', 'key'))
    symlinkSync(join(HOME, '.ssh'), join(ART, 's1', 'sshlink'))
    symlinkSync(join(HOME, '.ssh', 'authorized_keys'), join(ART, 's1', 'dangling'))
    symlinkSync(ART, join(ART, 's1', 'up'))

    mkdirSync(join(ROOT, 'agents'))
    writeFileSync(join(ROOT, 'agents', 'x.md'), '---\nname: x\n---\n')
    symlinkSync(join(ROOT, 'agents', 'x.md'), join(WS, 'agentlink'))
    mkdirSync(join(WS, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(WS, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n')
    symlinkSync(join(WS, 'notes.txt'), join(ROOT, 'outside', 'nlink'))
    symlinkSync(join(WS, '.git', 'hooks', 'pre-commit'), join(ROOT, 'outside', 'hooklink'))
    state.userData = join(ROOT, 'userData')

    REAL_WS = realpathSync.native(WS)
    REAL_HOME = realpathSync.native(HOME)
  })

  afterAll(() => {
    if (ROOT) rmSync(ROOT, { recursive: true, force: true })
  })

  beforeEach(() => {
    state.home = HOME
    state.settings = undefined
    state.granted = []
    config.workingDirectory = WS
    asks.length = 0
    respond = () => ({ kind: 'ask', allowed: false })
    // 旧用例一律显式拿空视图（见文件头）；要看真实视图的用例自己换回去
    workspaceWriteViewSpy.mockReset()
    workspaceWriteViewSpy.mockImplementation(emptyWorkspaceView)
  })

  it('RPP-1 旗舰：工作区里的 key → ~/.ssh/id_rsa，路径门把它判成私钥 —— protect-credentials 询问，卡片以私钥领头、注着 key；拒绝则原话（read 工具在门前就拒了链接本身，这里看的是门自己的裁决）', async () => {
    const link = join(WS, 'key')
    const target = join(REAL_HOME, '.ssh', 'id_rsa')

    const decision = evaluatePath('read', link)
    expect(verdict(decision)).toEqual({ effect: 'ask', winning: 'protect-credentials#1' })
    expect(decision.prompt?.rules).toContain('protect-credentials#1')

    expect(
      await rejectionOf(
        context().enforcePath('read', link, {
          toolCallId: 'r1',
          toolName: 'read',
          displayPath: 'key'
        })
      )
    ).toBe('User denied access to key')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      kind: 'ask',
      toolName: 'read',
      command: `Read(${target})`,
      requestedPath: link
    })
    expect((asks[0] as AskInputRequest).policyPrompt?.text).toBeTruthy()
  })

  it('RPP-2 同一条链接写入 → protect-credentials#0 直接拒（免询问也不管用）：拒绝文案把写法与真实去处都说出来，不弹卡', async () => {
    state.settings = { autoAllow: true }
    const link = join(WS, 'key')
    const target = join(REAL_HOME, '.ssh', 'id_rsa')

    expect(verdict(evaluatePath('write', link))).toEqual({
      effect: 'deny',
      winning: 'protect-credentials#0'
    })
    const message = await rejectionOf(
      context().enforcePath('write', link, {
        toolCallId: 'w2',
        toolName: 'write',
        displayPath: 'key'
      })
    )
    expect(
      message.startsWith(
        `Denied by security policy rule 'protect-credentials#0' (${link} resolves to ${target})\n\n`
      )
    ).toBe(true)
    expect(asks).toEqual([])
  })

  it('RPP-3 ~/.ssh 本身是链接（dotfiles 仓库）：真实位置上的私钥照样归凭据门 —— 读问、写拒；经 ~/.ssh 的写法与还不存在的新 key 一样', () => {
    state.home = HOME_B
    for (const p of [join(HOME_B, 'dotfiles', 'ssh', 'id_rsa'), join(HOME_B, '.ssh', 'id_rsa')]) {
      expect({ p, read: verdict(evaluatePath('read', p)) }).toEqual({
        p,
        read: { effect: 'ask', winning: 'protect-credentials#1' }
      })
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({
        p,
        write: { effect: 'deny', winning: 'protect-credentials#0' }
      })
    }
    expect(verdict(evaluatePath('write', join(HOME_B, 'dotfiles', 'ssh', 'new_key')))).toEqual({
      effect: 'deny',
      winning: 'protect-credentials#0'
    })
  })

  it('RPP-4 工作区本身经链接打开：区内读照旧放行；工作区写入视图为空时写照旧询问 —— 路径用哪种写法都一样；反过来（工作区写真实路径、交来经链接的写法）也一样；换成算出来的视图，两种写法的写一起放行', () => {
    config.workingDirectory = WS_LINK
    // 显式给空视图（Windows / 工作区不适合 / 规格算不出来时就是它），并确认变量表里确实是空的
    workspaceWriteViewSpy.mockImplementation(emptyWorkspaceView)
    expect(varsNow()).toMatchObject({
      workspaceWritable: [],
      workspaceWriteDenied: [],
      workspaceProtectedPatterns: []
    })
    for (const p of [join(WS, 'notes.txt'), join(WS_LINK, 'notes.txt')]) {
      expect({ p, read: verdict(evaluatePath('read', p)) }).toEqual({
        p,
        read: { effect: 'allow', winning: 'default:path' }
      })
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({
        p,
        write: { effect: 'ask', winning: 'ask-on-write#0' }
      })
    }

    config.workingDirectory = WS
    expect(verdict(evaluatePath('read', join(WS_LINK, 'notes.txt')))).toEqual({
      effect: 'allow',
      winning: 'default:path'
    })

    // 算出来的视图：工作区经链接打开，可写记的是真实工作区 —— 两种写法都落在里面
    restoreComputedWorkspaceView()
    config.workingDirectory = WS_LINK
    expect(varsNow().workspaceWritable).toEqual([REAL_WS])
    for (const p of [join(WS, 'notes.txt'), join(WS_LINK, 'notes.txt')]) {
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({
        p,
        write: { effect: 'allow', winning: 'default:path' }
      })
    }
  })

  it('RPP-5 工作区在 $TMPDIR 底下（macOS 解析后在 /private/var/folders）：工作区写入视图为空时写照常询问（ask-on-write#0），不被 protect-system 拒；区内读照旧放行；换成算出来的视图写就放行，同样不被 protect-system 拒', () => {
    workspaceWriteViewSpy.mockImplementation(emptyWorkspaceView)
    expect(varsNow().workspaceWritable).toEqual([])
    const p = join(WS, 'new.txt')
    const decision = evaluatePath('write', p)
    expect(verdict(decision)).toEqual({ effect: 'ask', winning: 'ask-on-write#0' })
    expect(decision.matched).not.toContain('protect-system#0')
    expect(decision.ask?.command).toBe(`Write(${join(REAL_WS, 'new.txt')})`)
    // macOS 上 /var 本身就是链接：写法与真实去处不同，卡片如实注上写法；两者相同的系统上不多这一栏
    const expectedRequested = join(REAL_WS, 'new.txt') === p ? undefined : p
    expect(decision.ask?.requestedPath).toBe(expectedRequested)

    expect(verdict(evaluatePath('read', join(WS, 'notes.txt')))).toEqual({
      effect: 'allow',
      winning: 'default:path'
    })

    restoreComputedWorkspaceView()
    expect(varsNow().workspaceWritable).toEqual([REAL_WS])
    const allowed = evaluatePath('write', p)
    expect(verdict(allowed)).toEqual({ effect: 'allow', winning: 'default:path' })
    expect(allowed.matched).not.toContain('protect-system#0')
  })

  it.skipIf(process.platform !== 'darwin')(
    'RPP-6 工作区里的 vlink → /var/log/…（macOS：/var 是 /private/var）：写入 → protect-system#0 拒绝，文案带着真实去处',
    async () => {
      const link = join(WS, 'vlink')
      const target = join(realpathSync.native('/var/log'), 'shuvix-rpp-never', 'x')
      expect(target.startsWith('/private/var/log/')).toBe(true)

      expect(verdict(evaluatePath('write', link))).toEqual({
        effect: 'deny',
        winning: 'protect-system#0'
      })
      const message = await rejectionOf(
        context().enforcePath('write', link, {
          toolCallId: 'w6',
          toolName: 'write',
          displayPath: 'vlink'
        })
      )
      expect(
        message.startsWith(
          `Denied by security policy rule 'protect-system#0' (${link} resolves to ${target})\n\n`
        )
      ).toBe(true)
      expect(asks).toEqual([])
    }
  )

  it('RPP-7 「允许并记住」记下的是真实去处（addAllowListPaths 收到的就是它）；落库之后，经链接的写法与真实路径都被放行', async () => {
    respond = () => ({ kind: 'ask', allowed: true, extra: { rememberPath: true } })
    const link = join(WS, 'wlink')
    const target = join(REAL_ROOT, 'outside', 'target.txt')

    await context().enforcePath('write', link, { toolCallId: 'w7', toolName: 'write' })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ command: `Write(${target})`, requestedPath: link })
    expect(state.granted).toEqual([{ sessionId: 's1', mode: 'write', paths: [target] }])

    // 那一条落进会话 allowList 之后（生产里是 SQLite；这里直接喂给 sessionDao）
    state.settings = { allowList: [`Write(${target})`] }
    for (const p of [link, target, join(ROOT, 'outside', 'target.txt')]) {
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({
        p,
        write: { effect: 'allow', winning: 'session-grants#2' }
      })
    }
  })

  it('RPP-8 早先按真实去处记下的授权对经链接的写法同样生效；按 tmpdir 原写法（/var/folders）记下的旧授权、目录授权也对得上', () => {
    const link = join(WS, 'rlink')
    // 没授权：读没有询问门，放行的是 default —— 下面看的是授权有没有被认出来（归因）
    expect(verdict(evaluatePath('read', link))).toEqual({
      effect: 'allow',
      winning: 'default:path'
    })

    for (const entry of [
      `Read(${join(REAL_ROOT, 'outside', 'doc.txt')})`,
      `Read(${join(ROOT, 'outside', 'doc.txt')})`,
      `Read(${join(REAL_ROOT, 'outside')})`
    ]) {
      state.settings = { allowList: [entry] }
      expect({ entry, read: verdict(evaluatePath('read', link)) }).toEqual({
        entry,
        read: { effect: 'allow', winning: 'session-grants#1' }
      })
    }
  })

  it('RPP-9 isPathWithinWorkspace 按位置比：指向 /etc 的链接不在区内；/var/folders 与 /private/var/folders 是同一处；兄弟目录与链接后的 `..` 不在区内', () => {
    expect(isPathWithinWorkspace(WS, WS)).toBe(true)
    expect(isPathWithinWorkspace(join(WS, 'notes.txt'), WS)).toBe(true)
    // 写法在区内、位置在 /etc
    expect(isPathWithinWorkspace(join(WS, 'etclink'), WS)).toBe(false)
    expect(isPathWithinWorkspace(join(WS, 'etclink', 'hosts'), WS)).toBe(false)
    // 工作区写成 /var/folders…、路径是解析过的 /private/var/folders…（或反过来）：同一处；还不存在的也一样
    expect(isPathWithinWorkspace(join(REAL_WS, 'notes.txt'), WS)).toBe(true)
    expect(isPathWithinWorkspace(join(WS, 'notes.txt'), REAL_WS)).toBe(true)
    expect(isPathWithinWorkspace(join(WS, 'new', 'file.txt'), REAL_WS)).toBe(true)
    // 工作区经链接打开
    expect(isPathWithinWorkspace(join(WS, 'notes.txt'), WS_LINK)).toBe(true)
    // 兄弟目录（含同前缀的）
    expect(isPathWithinWorkspace(`${WS}/../sibling/f`, WS)).toBe(false)
    expect(isPathWithinWorkspace(`${WS}-sibling/f`, WS)).toBe(false)
    // 链接后的 `..`：字面折叠会说「在区内」（<ws>/.ssh/id_rsa），物理上是家目录里的私钥
    expect(isPathWithinWorkspace(`${WS}/sshlink/../.ssh/id_rsa`, WS)).toBe(false)
  })

  it('RPP-9b isPathWithinWorkspace × 大小写不敏感的卷：大小写不同的写法是同一处 —— 卷区分大小写时跳过', (ctx) => {
    const upper = join(ROOT, 'WS', 'NOTES.TXT')
    if (!existsSync(upper)) ctx.skip()
    expect(isPathWithinWorkspace(upper, WS)).toBe(true)
    expect(isPathWithinWorkspace(join(WS, 'notes.txt'), join(ROOT, 'WS'))).toBe(true)
  })

  it('RPP-10 `..` 穿过链接（绝对路径原样交给门）：<ws>/sshlink/../.ssh/id_rsa 物理上就是私钥 —— 读问（卡片是私钥、注着原写法），写一把新 key 直接拒', async () => {
    const readPath = `${WS}/sshlink/../.ssh/id_rsa`
    const target = join(REAL_HOME, '.ssh', 'id_rsa')

    expect(verdict(evaluatePath('read', readPath))).toEqual({
      effect: 'ask',
      winning: 'protect-credentials#1'
    })
    expect(
      await rejectionOf(
        context().enforcePath('read', readPath, { toolCallId: 'r10', toolName: 'read' })
      )
    ).toBe(`User denied access to ${readPath}`)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ command: `Read(${target})`, requestedPath: readPath })

    const writePath = `${WS}/sshlink/../.ssh/new_key`
    expect(verdict(evaluatePath('write', writePath))).toEqual({
      effect: 'deny',
      winning: 'protect-credentials#0'
    })
    const message = await rejectionOf(
      context().enforcePath('write', writePath, { toolCallId: 'w10', toolName: 'write' })
    )
    expect(
      message.startsWith(
        `Denied by security policy rule 'protect-credentials#0' (${writePath} resolves to ${join(REAL_HOME, '.ssh', 'new_key')})\n\n`
      )
    ).toBe(true)
    // 写是直接拒，不弹卡
    expect(asks).toHaveLength(1)
  })

  // ── ShuviX 自己的配置、工作区写入豁免同样按真实去处判 ─────────────────────────────────

  it('RPP-C1 工作区里的链接指向 <~/.shuvix>/agents/x.md：按真实去处归 protect-shuvix-config —— force-ask（工作区视图空着或算出来、免询问开没开都一样）；卡片 command 是真实去处、requestedPath 是链接写法', async () => {
    const link = join(WS, 'agentlink')
    const target = join(REAL_ROOT, 'agents', 'x.md')

    for (const view of ['empty', 'computed'] as const) {
      if (view === 'computed') restoreComputedWorkspaceView()
      expect(varsNow().workspaceWritable).toEqual(view === 'computed' ? [REAL_WS] : [])
      for (const autoAllow of [false, true]) {
        state.settings = { autoAllow }
        const decision = evaluatePath('write', link)
        expect({
          view,
          autoAllow,
          effect: decision.effect,
          tier: decision.tier,
          winning: decision.winning
        }).toEqual({
          view,
          autoAllow,
          effect: 'ask',
          tier: 'force-ask',
          winning: 'protect-shuvix-config#0'
        })
        expect(decision.ask?.command).toBe(`Write(${target})`)
        expect(decision.ask?.requestedPath).toBe(link)
      }
    }

    // 走一遍真的门：卡片上是真实去处，注着链接写法；拒绝的原话用交来的显示名
    state.settings = { autoAllow: true }
    expect(
      await rejectionOf(
        context().enforcePath('write', link, {
          toolCallId: 'wc1',
          toolName: 'write',
          displayPath: 'agentlink'
        })
      )
    ).toBe('User denied access to agentlink')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      kind: 'ask',
      toolName: 'write',
      command: `Write(${target})`,
      requestedPath: link
    })
  })

  it('RPP-W1 工作区写入豁免按真实去处判（视图照生产算出来 = [真实工作区]）：区内链接指向区外 → 问；区外链接指向区内普通文件 → 放行、指向区内受保护位置 → 问；链接后的 `..` 走出工作区 → 问', () => {
    restoreComputedWorkspaceView()
    const vars = varsNow()
    expect(vars.workspaceWritable).toEqual([REAL_WS])
    expect(vars.workspaceProtectedPatterns).not.toEqual([])

    // 前提：区内普通文件确实被豁免（视图生效，不是整片都在问）
    expect(verdict(evaluatePath('write', join(WS, 'notes.txt')))).toEqual({
      effect: 'allow',
      winning: 'default:path'
    })

    // 写法在区内、去处在区外
    const wlink = join(WS, 'wlink')
    const out = evaluatePath('write', wlink)
    expect(verdict(out)).toEqual({ effect: 'ask', winning: 'ask-on-write#0' })
    expect(out.ask?.command).toBe(`Write(${join(REAL_ROOT, 'outside', 'target.txt')})`)
    expect(out.ask?.requestedPath).toBe(wlink)

    // 写法在区外、去处是区内的普通文件
    expect(verdict(evaluatePath('write', join(ROOT, 'outside', 'nlink')))).toEqual({
      effect: 'allow',
      winning: 'default:path'
    })
    // 写法在区外、去处是工作区里 git 的 hooks（受保护模式按真实去处比）
    const hooklink = join(ROOT, 'outside', 'hooklink')
    const hook = evaluatePath('write', hooklink)
    expect(verdict(hook)).toEqual({ effect: 'ask', winning: 'ask-on-write#0' })
    expect(hook.ask?.command).toBe(`Write(${join(REAL_WS, '.git', 'hooks', 'pre-commit')})`)

    // 字面折叠会说「在区内」（<ws>/notes-x.txt），物理上是 ~/.ssh 的上一级 —— 家目录里的文件
    const dotdot = `${WS}/sshlink/../notes-x.txt`
    const escaped = evaluatePath('write', dotdot)
    expect(verdict(escaped)).toEqual({ effect: 'ask', winning: 'ask-on-write#0' })
    expect(escaped.ask?.command).toBe(`Write(${join(REAL_HOME, 'notes-x.txt')})`)
  })

  // ── 本会话 artifacts 的豁免同样按真实去处判 ─────────────────────────────────────────

  it('RPP-A1 本会话目录里的链接按它真正指向哪儿过门：rc → ~/.bashrc 写照问（卡片是真实去处、注着写法）、读不问；key / sshlink / 悬空的 authorized_keys 归凭据门 —— 写拒（免询问也拒）、读问', async () => {
    const rc = join(ART, 's1', 'rc')
    const rcWrite = evaluatePath('write', rc)
    expect(verdict(rcWrite)).toEqual({ effect: 'ask', winning: 'ask-on-write#0' })
    expect(rcWrite.ask?.command).toBe(`Write(${REAL_HOME}/.bashrc)`)
    expect(rcWrite.ask?.requestedPath).toBe(rc)
    expect(verdict(evaluatePath('read', rc))).toEqual({ effect: 'allow', winning: 'default:path' })

    const key = join(ART, 's1', 'key')
    expect(verdict(evaluatePath('write', key))).toEqual({
      effect: 'deny',
      winning: 'protect-credentials#0'
    })
    expect(verdict(evaluatePath('read', key))).toEqual({
      effect: 'ask',
      winning: 'protect-credentials#1'
    })
    for (const p of [join(ART, 's1', 'sshlink', 'new_key'), join(ART, 's1', 'dangling')]) {
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({
        p,
        write: { effect: 'deny', winning: 'protect-credentials#0' }
      })
    }

    state.settings = { autoAllow: true }
    expect(verdict(evaluatePath('write', key))).toEqual({
      effect: 'deny',
      winning: 'protect-credentials#0'
    })
    const message = await rejectionOf(
      context().enforcePath('write', key, { toolCallId: 'wa1', toolName: 'write' })
    )
    expect(
      message.startsWith(
        `Denied by security policy rule 'protect-credentials#0' (${key} resolves to ${REAL_HOME}/.ssh/id_rsa)`
      )
    ).toBe(true)
    expect(asks).toEqual([])
  })

  it('RPP-A2 `..` 与链接走出本会话目录就不再豁免（别的会话、同前缀兄弟、区外、经 up 链接落进 s2）；留在目录里的 `..` 照旧豁免；还没建出来的会话目录同样豁免、不被 protect-system 拒', () => {
    const toS2 = `${ART}/s1/../s2/x.svg`
    const s2Write = evaluatePath('write', toS2)
    expect(verdict(s2Write)).toEqual({ effect: 'ask', winning: 'ask-on-write#0' })
    expect(s2Write.ask?.command).toBe(`Write(${REAL_ROOT}/artifacts/s2/x.svg)`)

    for (const p of [
      `${ART}/s1/../s1-evil/x.svg`,
      `${ART}/s1/../../outside/target.txt`,
      // 写法在 s1 底下，物理上在 s2
      `${ART}/s1/up/s2/x.svg`
    ]) {
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({
        p,
        write: { effect: 'ask', winning: 'ask-on-write#0' }
      })
    }

    expect(verdict(evaluatePath('write', `${ART}/s1/sub/../chart.svg`))).toEqual({
      effect: 'allow',
      winning: 'default:path'
    })

    // 会话的目录要等第一件 artifact 才建出来；macOS 上两侧都从 /var/folders 解析成 /private/var/folders
    const fresh = context('fresh').evaluate('write', {
      type: 'path',
      path: join(ART, 'fresh', 'new.svg')
    })
    expect(verdict(fresh)).toEqual({ effect: 'allow', winning: 'default:path' })
    expect(fresh.matched).not.toContain('protect-system#0')
  })

  it('RPP-A3 artifact store 真写出来的文件只对自己的会话免询问：s1 读写直接过门、不弹卡、不留授权；换成 s2 写照问（读哪儿都不问）；别处的写照旧问', async () => {
    const info = writeArtifact({
      sessionId: 's1',
      title: 'Revenue',
      ext: 'svg',
      content: '<svg aria-label="Revenue"></svg>'
    })
    expect(info.path.startsWith(join(ART, 's1'))).toBe(true)

    expect(verdict(evaluatePath('write', info.path))).toEqual({
      effect: 'allow',
      winning: 'default:path'
    })
    expect(verdict(evaluatePath('read', info.path))).toEqual({
      effect: 'allow',
      winning: 'default:path'
    })

    expect(verdict(evaluatePath('write', info.path, 's2'))).toEqual({
      effect: 'ask',
      winning: 'ask-on-write#0'
    })
    expect(verdict(evaluatePath('read', info.path, 's2'))).toEqual({
      effect: 'allow',
      winning: 'default:path'
    })

    await expect(
      context().enforcePath('write', info.path, { toolCallId: 'wa', toolName: 'edit' })
    ).resolves.toBeUndefined()
    await expect(
      context().enforcePath('read', info.path, { toolCallId: 'ra', toolName: 'read' })
    ).resolves.toBeUndefined()
    expect(asks).toEqual([])
    // 豁免不是「允许并记住」：什么都没记进会话授权
    expect(state.granted).toEqual([])

    expect(verdict(evaluatePath('write', join(WS, 'notes.txt')))).toEqual({
      effect: 'ask',
      winning: 'ask-on-write#0'
    })
  })
})
