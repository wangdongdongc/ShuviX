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
  settings: undefined as { autoAllow?: boolean; allowList?: string[] } | undefined,
  /** sessionService.addAllowListPaths 收到的实参 */
  granted: [] as Array<{ sessionId: string; mode: string; paths: string[] }>,
  // 内置策略的事实源 —— 运行时读随包发布的目录，这里直接读仓库里那一份（同一批文件）。
  // src/main/services/__tests__ 往上六级是仓库根
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

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
  getBuiltinKnowledgeDir: () => join(state.root, 'builtin-knowledge')
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  getDesktopSecurityContext,
  isPathWithinWorkspace,
  type ProjectConfig
} from '../toolContext'
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

  const config: ProjectConfig = { workingDirectory: '' }
  const asks: InputRequest[] = []
  let respond: (req: InputRequest) => InputResponse = () => ({ kind: 'ask', allowed: false })

  const context = (): SecurityContext =>
    getDesktopSecurityContext(
      {
        sessionId: 's1',
        requestUserInput: async (req) => {
          asks.push(req)
          return respond(req)
        }
      },
      () => config
    )
  const evaluatePath = (mode: 'read' | 'write', path: string): SecurityDecision =>
    context().evaluate(mode, { type: 'path', path })

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

  it('RPP-4 工作区本身经链接打开：区内读照旧放行、写照旧询问 —— 路径用哪种写法都一样；反过来（工作区写真实路径、交来经链接的写法）也一样', () => {
    config.workingDirectory = WS_LINK
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
  })

  it('RPP-5 工作区在 $TMPDIR 底下（macOS 解析后在 /private/var/folders）：写照常询问（ask-on-write#0），不被 protect-system 拒；区内读照旧放行', () => {
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
        write: { effect: 'allow', winning: 'session-path-grants#1' }
      })
    }
  })

  it('RPP-8 早先按真实去处记下的授权对经链接的写法同样生效；按 tmpdir 原写法（/var/folders）记下的旧授权、目录授权也对得上', () => {
    const link = join(WS, 'rlink')
    // 没授权：它指向区外 → ask-on-read
    expect(verdict(evaluatePath('read', link))).toEqual({ effect: 'ask', winning: 'ask-on-read#0' })

    for (const entry of [
      `Read(${join(REAL_ROOT, 'outside', 'doc.txt')})`,
      `Read(${join(ROOT, 'outside', 'doc.txt')})`,
      `Read(${join(REAL_ROOT, 'outside')})`
    ]) {
      state.settings = { allowList: [entry] }
      expect({ entry, read: verdict(evaluatePath('read', link)) }).toEqual({
        entry,
        read: { effect: 'allow', winning: 'session-path-grants#0' }
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
})
