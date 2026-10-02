/**
 * 路径策略按**真实去处**判 —— 桌面端到端：真临时目录树 + 真符号链接 + 真的桌面 provider
 * （makeDesktopSecurityProvider：realPath = resolveRealPath）+ 真的内置策略 md + 真的会话目录
 * （sandbox.sessionDirsView）+ 真的 isPathWithinWorkspace。
 *
 * mock 照 askPolicy.test.ts：dao / sessionService / skillService / knowledge/sessionBundle / policyService /
 * paths / logger；另把 `os.homedir` 换成本用例的临时家目录 —— ask-on-external-path 的读规则看 vars.home，
 * 会话目录里的 artifacts 也挂在 <家目录>/.shuvix/artifacts 下（getSessionArtifactsDir 的 mock 与生产同形），
 * 家目录得真在盘上，链接才有地方可指。fs / path 不 mock：realPath.ts 读的是 node:fs / node:path，要测的
 * 恰是真文件系统上的解析。electron 的 app.getPath 有替身（<ROOT>/userData）：会话目录的规格要它。
 * sessionService.addAllowListPaths 抄一份实参（RPP-2 / RPP-7 看「允许并记住」记下的是哪个位置），
 * sessionDao.pickSettings 喂会话授权。
 *
 * 会话目录（vars.sessionDirs）在这里是：工作区 <ROOT>/ws、<家目录>/.shuvix/artifacts/<id>、
 * <ROOT>/tool-results/<id> 与会话 TMPDIR。家目录与工作区是 ROOT 下的兄弟：工作区与 outside/ 里的读不问
 * （家目录外），家目录里会话目录以外的读问（ask-on-external-path#0）；会话目录以外的写问（#1）。
 *
 * macOS 上 tmpdir 在 /var → /private/var 这条系统级链接之下：vars.home 照写法给（/var/folders/…），
 * 会话目录是解析过的（/private/var/folders/…），路径客体两侧都经 realPath 比。期望一律按
 * realpathSync.native 算，写法一律从 mkdtemp 的原样起算。符号链接在 Windows 上要开发者模式，整份跳过。
 *
 * RPP-A 一组：本会话自己的 artifacts 目录是会话目录之一，豁免同样按真实去处判 —— 目录里的链接按它指向
 * 哪儿过门，`..` 与链接走出这个目录就不再豁免（别的会话的目录在家目录里，读也问）；artifact store 真正写出来
 * 的文件只对自己的会话免询问，也不留下任何授权。
 *
 * 2026-10-01 起出厂只有两份询问（ask-on-external-path / ask-on-command）：没有 deny、没有 force-ask，凭据位置
 * 也不另算（它们就是「家目录里、会话目录外」）。退役那几份的原文是测试夹具（retiredPolicy），要看「拒绝原话
 * 带着真实去处」（protect-system）、「force-ask 按真实去处判」（protect-shuvix-config）、「策略里的目录变量本身
 * 是链接」（protect-credentials 的 ~/.ssh）的用例把它装进 state.userPolicies。
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
import type { UserPolicyFile } from '@shuvix/agent-runtime'
import { retiredPolicy } from '../../../../../../packages/agent-runtime/src/security/__tests__/fixtures/retiredPolicies'

const state = vi.hoisted(() => ({
  /** 本用例的临时根（beforeAll 建）；paths mock 的各目录都挂在它下面 */
  root: '',
  /** os.homedir() 给出的家目录（用例可换成 .ssh 本身是链接的那一个） */
  home: '',
  /** app.getPath('userData') 的替身（会话目录的规格要它；盘上不存在也行） */
  userData: '/nonexistent-shuvix-rpp-userdata',
  settings: undefined as { allowList?: string[] } | undefined,
  /** ~/.shuvix/policies 的替身（policyService.getUserPolicies 现扫的结果） */
  userPolicies: [] as UserPolicyFile[],
  /** sessionService.addAllowListPaths 收到的实参 */
  granted: [] as Array<{ sessionId: string; mode: string; paths: string[] }>,
  // 内置策略的事实源 —— 运行时读随包发布的目录，这里直接读仓库里那一份（同一批文件）。
  // src/main/services/__tests__ 往上六级是仓库根
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

vi.mock('electron', () => ({ app: { getPath: () => state.userData, isPackaged: false } }))
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
// 会话设置带来的那部分会话目录（勾选的知识库、技能目录）与本文件无关：一个都不给
vi.mock('../skillService', () => ({
  skillService: { listExternalDirs: () => [], enabledSkillRoots: () => [] }
}))
vi.mock('../knowledge/sessionBundle', () => ({ enabledTargets: () => [] }))
vi.mock('../policyService', () => ({
  policyService: {
    getUserPolicies: () => state.userPolicies,
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
  // getVars 的 shuvixConfigDirs（退役的 protect-shuvix-config 引用它们）
  getDefaultPoliciesDir: () => join(state.root, 'policies'),
  getDefaultAgentsDir: () => join(state.root, 'agents'),
  getDefaultHooksDir: () => join(state.root, 'hooks'),
  getBuiltinKnowledgeDir: () => join(state.root, 'builtin-knowledge'),
  // 与生产同形（<家目录>/.shuvix/artifacts/<id>）：会话目录里的那一项按 os.homedir() 算，两边得是同一处
  getSessionArtifactsDir: (id: string) => join(state.home, '.shuvix', 'artifacts', id),
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

const ALLOW = { effect: 'allow', winning: 'default:path' }
/** 家目录里、会话目录外的读 */
const ASK_READ = { effect: 'ask', winning: 'ask-on-external-path#0' }
/** 会话目录外的写 */
const ASK_WRITE = { effect: 'ask', winning: 'ask-on-external-path#1' }

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
  /** 所有会话的 artifacts 根（写法；<家目录 A>/.shuvix/artifacts） */
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
  /** 这一刻的桌面变量表（前提断言用：会话目录是哪一组） */
  const varsNow = (sessionId = 's1'): Record<string, unknown> =>
    makeDesktopSecurityProvider({ sessionId }, () => config).getVars() as Record<string, unknown>

  /**
   * 目录树（ROOT 下）：
   *   home/.ssh/id_rsa、home/.ssh/config、home/.bashrc、home/docs/doc.txt
   *   home-b/dotfiles/ssh/id_rsa；home-b/.ssh → home-b/dotfiles/ssh
   *   outside/target.txt、outside/doc.txt
   *   sibling/
   *   ws/notes.txt
   *   ws/key → home/.ssh/id_rsa          ws/sshlink → home/.ssh       ws/etclink → /etc
   *   ws/vlink → /var/log/shuvix-rpp-never/x（悬空）
   *   ws/wlink → outside/target.txt      ws/hlink → home/docs/doc.txt
   *   wslink → ws
   *   home/.shuvix/artifacts/s1/、home/.shuvix/artifacts/s2/（本会话 s1 与另一场会话的 artifacts 目录）
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
    mkdirSync(join(HOME, 'docs'))
    writeFileSync(join(HOME, 'docs', 'doc.txt'), 'doc')
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
    symlinkSync(join(HOME, 'docs', 'doc.txt'), join(WS, 'hlink'))
    symlinkSync(WS, WS_LINK)

    ART = join(HOME, '.shuvix', 'artifacts')
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
    state.userPolicies = []
    state.granted = []
    config.workingDirectory = WS
    asks.length = 0
    respond = () => ({ kind: 'ask', allowed: false })
  })

  it('RPP-0 前提：会话目录是解析过的工作区、<家目录>/.shuvix/artifacts/s1 与 tool-results/s1；工作区与家目录外的读不问，区内写不问', () => {
    const dirs = varsNow().sessionDirs as string[]
    expect(dirs).toEqual(
      expect.arrayContaining([
        REAL_WS,
        join(REAL_HOME, '.shuvix', 'artifacts', 's1'),
        join(REAL_ROOT, 'tool-results', 's1')
      ])
    )
    expect(verdict(evaluatePath('read', join(WS, 'notes.txt')))).toEqual(ALLOW)
    expect(verdict(evaluatePath('read', join(ROOT, 'outside', 'doc.txt')))).toEqual(ALLOW)
    expect(verdict(evaluatePath('write', join(WS, 'notes.txt')))).toEqual(ALLOW)
  })

  it('RPP-1 旗舰：工作区里的 key → ~/.ssh/id_rsa，路径门把它判成家目录里的私钥 —— ask-on-external-path#0 询问，卡片以私钥领头、注着 key；拒绝则原话（read 工具在门前就拒了链接本身，这里看的是门自己的裁决）', async () => {
    const link = join(WS, 'key')
    const target = join(REAL_HOME, '.ssh', 'id_rsa')

    // 写法在工作区里（会话目录、家目录外 —— 照写法判读本不该问）
    const decision = evaluatePath('read', link)
    expect(verdict(decision)).toEqual(ASK_READ)
    expect(decision.prompt?.rules).toContain('ask-on-external-path#0')

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

  it('RPP-2 同一条链接写入 → 会话目录外的写：ask-on-external-path#1 问，卡片以私钥领头、注着 key；「允许并记住」记下的是私钥本身', async () => {
    const link = join(WS, 'key')
    const target = join(REAL_HOME, '.ssh', 'id_rsa')

    const decision = evaluatePath('write', link)
    expect(verdict(decision)).toEqual(ASK_WRITE)
    // 询问材料给出「记住」—— 记的就是它领头的那个位置（真实去处，不是链接写法）
    expect(decision.ask?.rememberEntry).toBe(`Write(${target})`)
    expect(
      await rejectionOf(
        context().enforcePath('write', link, {
          toolCallId: 'w2',
          toolName: 'write',
          displayPath: 'key'
        })
      )
    ).toBe('User denied access to key')
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      kind: 'ask',
      toolName: 'write',
      command: `Write(${target})`,
      requestedPath: link
    })

    respond = () => ({ kind: 'ask', allowed: true, extra: { rememberPath: true } })
    await context().enforcePath('write', link, { toolCallId: 'w2b', toolName: 'write' })
    expect(state.granted).toEqual([{ sessionId: 's1', mode: 'write', paths: [target] }])
  })

  it('RPP-3 ~/.ssh 本身是链接（dotfiles 仓库）：真实位置与经 ~/.ssh 的写法都在家目录里 —— 读问 #0、写问 #1（还不存在的新 key 也一样）；装回 protect-credentials：它的 credentialDirs（vars.home + /.ssh，本身是链接）按真实去处展开，真实位置上的私钥同样命中它', () => {
    state.home = HOME_B
    const keys = [join(HOME_B, 'dotfiles', 'ssh', 'id_rsa'), join(HOME_B, '.ssh', 'id_rsa')]
    for (const p of keys) {
      expect({ p, read: verdict(evaluatePath('read', p)) }).toEqual({ p, read: ASK_READ })
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({ p, write: ASK_WRITE })
    }
    expect(verdict(evaluatePath('write', join(HOME_B, 'dotfiles', 'ssh', 'new_key')))).toEqual(
      ASK_WRITE
    )

    // 策略里的目录变量本身经链接：inDir 解析 `<home-b>/.ssh` 再比，两种写法都落在它里面
    state.userPolicies = [retiredPolicy('protect-credentials')]
    for (const p of keys) {
      const d = evaluatePath('read', p)
      expect({ p, effect: d.effect }).toEqual({ p, effect: 'ask' })
      expect(d.matched, p).toContain('protect-credentials#0')
    }
    // 对照：dotfiles 里 ssh 以外的文件不归它（家目录里，只是外部目录访问的那一问）
    const other = evaluatePath('read', join(HOME_B, 'dotfiles', 'gitconfig'))
    expect(verdict(other)).toEqual(ASK_READ)
    expect(other.matched).not.toContain('protect-credentials#0')
  })

  it('RPP-4 工作区本身经链接打开：会话目录记的是真实工作区 —— 两种写法的读写都放行；反过来（工作区写真实路径、交来经链接的写法）也一样', () => {
    config.workingDirectory = WS_LINK
    const dirs = varsNow().sessionDirs as string[]
    expect(dirs).toContain(REAL_WS)
    expect(dirs).not.toContain(WS_LINK)
    for (const p of [join(WS, 'notes.txt'), join(WS_LINK, 'notes.txt')]) {
      expect({ p, read: verdict(evaluatePath('read', p)) }).toEqual({ p, read: ALLOW })
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({ p, write: ALLOW })
    }

    config.workingDirectory = WS
    for (const mode of ['read', 'write'] as const) {
      expect({ mode, ...verdict(evaluatePath(mode, join(WS_LINK, 'notes.txt'))) }).toEqual({
        mode,
        ...ALLOW
      })
    }
  })

  it('RPP-5 工作区在 $TMPDIR 底下（macOS 解析后在 /private/var/folders）：区内读写放行，不被（装回的）protect-system 拒；会话目录外的写照常询问（#1）、同样不被它拒，卡片是真实去处、注着写法', () => {
    state.userPolicies = [retiredPolicy('protect-system')]
    const p = join(WS, 'new.txt')
    const allowed = evaluatePath('write', p)
    expect(verdict(allowed)).toEqual(ALLOW)
    expect(allowed.matched).not.toContain('protect-system#0')
    expect(verdict(evaluatePath('read', join(WS, 'notes.txt')))).toEqual(ALLOW)

    const out = join(ROOT, 'outside', 'new.txt')
    const realOut = join(REAL_ROOT, 'outside', 'new.txt')
    const decision = evaluatePath('write', out)
    expect(verdict(decision)).toEqual(ASK_WRITE)
    expect(decision.matched).not.toContain('protect-system#0')
    expect(decision.ask?.command).toBe(`Write(${realOut})`)
    // macOS 上 /var 本身就是链接：写法与真实去处不同，卡片如实注上写法；两者相同的系统上不多这一栏
    expect(decision.ask?.requestedPath).toBe(realOut === out ? undefined : out)
  })

  it.skipIf(process.platform !== 'darwin')(
    'RPP-6 装回 protect-system：工作区里的 vlink → /var/log/…（macOS：/var 是 /private/var）：写入 → protect-system#0 拒绝，文案带着真实去处；出厂（只有内置）时同一条写只是 ask-on-external-path#1',
    async () => {
      const link = join(WS, 'vlink')
      expect(verdict(evaluatePath('write', link))).toEqual(ASK_WRITE)

      state.userPolicies = [retiredPolicy('protect-system')]
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

  it('RPP-7 「允许并记住」记下的是真实去处（addAllowListPaths 收到的就是它）；落库之后，经链接的写法与真实路径都不再问', async () => {
    respond = () => ({ kind: 'ask', allowed: true, extra: { rememberPath: true } })
    const link = join(WS, 'wlink')
    const target = join(REAL_ROOT, 'outside', 'target.txt')

    await context().enforcePath('write', link, { toolCallId: 'w7', toolName: 'write' })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ command: `Write(${target})`, requestedPath: link })
    expect(state.granted).toEqual([{ sessionId: 's1', mode: 'write', paths: [target] }])

    // 落库之前三种写法都问，落库之后都放行 —— 前后只差那一条授权
    const forms = [link, target, join(ROOT, 'outside', 'target.txt')]
    for (const p of forms) {
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({ p, write: ASK_WRITE })
    }
    // 那一条落进会话 allowList 之后（生产里是 SQLite；这里直接喂给 sessionDao）
    state.settings = { allowList: [`Write(${target})`] }
    for (const p of forms) {
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({ p, write: ALLOW })
    }
  })

  it('RPP-8 读授权按位置认：经工作区里的链接读家目录里的文档 —— 没授权问 #0；按真实去处、按 tmpdir 原写法（/var/folders）记下的 Read 授权、目录授权与 Write 授权都对得上；Read 授权不放写', () => {
    const link = join(WS, 'hlink')
    expect(verdict(evaluatePath('read', link))).toEqual(ASK_READ)

    for (const entry of [
      `Read(${join(REAL_HOME, 'docs', 'doc.txt')})`,
      `Read(${join(HOME, 'docs', 'doc.txt')})`,
      `Read(${join(REAL_HOME, 'docs')})`,
      // 写授权覆盖读：信得过 agent 往那里写，读就不是额外的让步
      `Write(${join(HOME, 'docs')})`
    ]) {
      state.settings = { allowList: [entry] }
      expect({ entry, read: verdict(evaluatePath('read', link)) }).toEqual({ entry, read: ALLOW })
    }

    state.settings = { allowList: [`Read(${join(REAL_HOME, 'docs')})`] }
    expect(verdict(evaluatePath('write', link))).toEqual(ASK_WRITE)
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

  it('RPP-10 `..` 穿过链接（绝对路径原样交给门）：<ws>/sshlink/../.ssh/id_rsa 物理上就是私钥 —— 读问 #0（卡片是私钥、注着原写法），写一把新 key 按真实去处问 #1', async () => {
    const readPath = `${WS}/sshlink/../.ssh/id_rsa`
    const target = join(REAL_HOME, '.ssh', 'id_rsa')

    expect(verdict(evaluatePath('read', readPath))).toEqual(ASK_READ)
    expect(
      await rejectionOf(
        context().enforcePath('read', readPath, { toolCallId: 'r10', toolName: 'read' })
      )
    ).toBe(`User denied access to ${readPath}`)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ command: `Read(${target})`, requestedPath: readPath })

    const writePath = `${WS}/sshlink/../.ssh/new_key`
    expect(verdict(evaluatePath('write', writePath))).toEqual(ASK_WRITE)
    expect(
      await rejectionOf(
        context().enforcePath('write', writePath, { toolCallId: 'w10', toolName: 'write' })
      )
    ).toBe(`User denied access to ${writePath}`)
    // 写也弹卡：卡片是真实去处（家目录里的 new_key），注着原写法
    expect(asks).toHaveLength(2)
    expect(asks[1]).toMatchObject({
      command: `Write(${join(REAL_HOME, '.ssh', 'new_key')})`,
      requestedPath: writePath
    })
  })

  // ── ShuviX 自己的配置、会话目录的豁免同样按真实去处判 ─────────────────────────────────

  it('RPP-C1 装回 protect-shuvix-config：工作区里的链接指向 <~/.shuvix>/agents/x.md，按真实去处归它 —— force-ask（「允许并记住」了真实去处也一样）；卡片 command 是真实去处、requestedPath 是链接写法；出厂时同一条写只是 ask-on-external-path#1', async () => {
    const link = join(WS, 'agentlink')
    const target = join(REAL_ROOT, 'agents', 'x.md')

    // 出厂（只有内置）：普通的会话目录外的写（写法在工作区里，去处不在）
    const builtinOnly = evaluatePath('write', link)
    expect({ ...verdict(builtinOnly), tier: builtinOnly.tier }).toEqual({
      ...ASK_WRITE,
      tier: 'ask'
    })

    state.userPolicies = [retiredPolicy('protect-shuvix-config')]
    for (const granted of [false, true]) {
      state.settings = granted ? { allowList: [`Write(${target})`] } : undefined
      const decision = evaluatePath('write', link)
      expect({
        granted,
        effect: decision.effect,
        tier: decision.tier,
        winning: decision.winning
      }).toEqual({
        granted,
        effect: 'ask',
        tier: 'force-ask',
        winning: 'protect-shuvix-config#0'
      })
      expect(decision.ask?.command).toBe(`Write(${target})`)
      expect(decision.ask?.requestedPath).toBe(link)
    }

    // 走一遍真的门：卡片上是真实去处，注着链接写法；拒绝的原话用交来的显示名
    state.settings = { allowList: [`Write(${target})`] }
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

  it('RPP-W1 工作区（会话目录）的豁免按真实去处判：区内链接指向区外 → 问；区外链接指向区内普通文件 → 放行，指向区内 git 的 hooks 同样放行（.git 不再另算）；链接后的 `..` 走出工作区 → 问', () => {
    // 前提：区内普通文件确实被豁免（会话目录生效，不是整片都在问）
    expect(varsNow().sessionDirs).toContain(REAL_WS)
    expect(verdict(evaluatePath('write', join(WS, 'notes.txt')))).toEqual(ALLOW)

    // 写法在区内、去处在区外
    const wlink = join(WS, 'wlink')
    const out = evaluatePath('write', wlink)
    expect(verdict(out)).toEqual(ASK_WRITE)
    expect(out.ask?.command).toBe(`Write(${join(REAL_ROOT, 'outside', 'target.txt')})`)
    expect(out.ask?.requestedPath).toBe(wlink)

    // 写法在区外、去处是区内的普通文件
    expect(verdict(evaluatePath('write', join(ROOT, 'outside', 'nlink')))).toEqual(ALLOW)
    // 写法在区外、去处是工作区里 git 的 hooks：2026-10-01 起策略与沙箱都不再保护 .git，与区内普通文件一样
    expect(verdict(evaluatePath('write', join(ROOT, 'outside', 'hooklink')))).toEqual(ALLOW)

    // 字面折叠会说「在区内」（<ws>/notes-x.txt），物理上是 ~/.ssh 的上一级 —— 家目录里的文件
    const dotdot = `${WS}/sshlink/../notes-x.txt`
    const escaped = evaluatePath('write', dotdot)
    expect(verdict(escaped)).toEqual(ASK_WRITE)
    expect(escaped.ask?.command).toBe(`Write(${join(REAL_HOME, 'notes-x.txt')})`)
  })

  // ── 本会话 artifacts 的豁免同样按真实去处判 ─────────────────────────────────────────

  it('RPP-A1 本会话目录里的链接按它真正指向哪儿过门：rc → ~/.bashrc、key → ~/.ssh/id_rsa 读写都问（卡片是真实去处、注着写法）；sshlink 下的新 key、悬空的 authorized_keys 的写同样不豁免', async () => {
    // 前提：本会话的 artifacts 目录确实是会话目录（在家目录里，豁免的是它而不是「家目录外」）
    expect(varsNow().sessionDirs).toContain(join(REAL_HOME, '.shuvix', 'artifacts', 's1'))

    const rc = join(ART, 's1', 'rc')
    const rcWrite = evaluatePath('write', rc)
    expect(verdict(rcWrite)).toEqual(ASK_WRITE)
    expect(rcWrite.ask?.command).toBe(`Write(${REAL_HOME}/.bashrc)`)
    expect(rcWrite.ask?.requestedPath).toBe(rc)
    const rcRead = evaluatePath('read', rc)
    expect(verdict(rcRead)).toEqual(ASK_READ)
    expect(rcRead.ask?.command).toBe(`Read(${REAL_HOME}/.bashrc)`)

    const key = join(ART, 's1', 'key')
    expect(verdict(evaluatePath('write', key))).toEqual(ASK_WRITE)
    expect(verdict(evaluatePath('read', key))).toEqual(ASK_READ)
    for (const p of [join(ART, 's1', 'sshlink', 'new_key'), join(ART, 's1', 'dangling')]) {
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({ p, write: ASK_WRITE })
    }

    // 走一遍真的门：卡片是私钥本身，注着本会话目录里的写法
    expect(
      await rejectionOf(
        context().enforcePath('write', key, { toolCallId: 'wa1', toolName: 'write' })
      )
    ).toBe(`User denied access to ${key}`)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      command: `Write(${REAL_HOME}/.ssh/id_rsa)`,
      requestedPath: key
    })
  })

  it('RPP-A2 `..` 与链接走出本会话目录就不再豁免（别的会话 —— 读也问、同前缀兄弟、~/.shuvix/policies、经 up 链接落进 s2）；留在目录里的 `..` 照旧豁免；还没建出来的会话目录同样豁免、不被（装回的）protect-system 拒', () => {
    const toS2 = `${ART}/s1/../s2/x.svg`
    const s2Write = evaluatePath('write', toS2)
    expect(verdict(s2Write)).toEqual(ASK_WRITE)
    expect(s2Write.ask?.command).toBe(`Write(${REAL_HOME}/.shuvix/artifacts/s2/x.svg)`)
    // 别的会话的目录在家目录里、不在本会话的会话目录里：读同样问
    expect(verdict(evaluatePath('read', toS2))).toEqual(ASK_READ)

    for (const p of [
      `${ART}/s1/../s1-evil/x.svg`,
      // 走出 artifacts 落进 ShuviX 自己的策略目录
      `${ART}/s1/../../policies/x.md`,
      // 写法在 s1 底下，物理上在 s2
      `${ART}/s1/up/s2/x.svg`
    ]) {
      expect({ p, write: verdict(evaluatePath('write', p)) }).toEqual({ p, write: ASK_WRITE })
    }

    expect(verdict(evaluatePath('write', `${ART}/s1/sub/../chart.svg`))).toEqual(ALLOW)

    // 会话的目录要等第一件 artifact 才建出来；macOS 上两侧都从 /var/folders 解析成 /private/var/folders
    state.userPolicies = [retiredPolicy('protect-system')]
    const fresh = context('fresh').evaluate('write', {
      type: 'path',
      path: join(ART, 'fresh', 'new.svg')
    })
    expect(verdict(fresh)).toEqual(ALLOW)
    expect(fresh.matched).not.toContain('protect-system#0')
  })

  it('RPP-A3 artifact store 真写出来的文件只对自己的会话免询问：s1 读写直接过门、不弹卡、不留授权；换成 s2 读写都问（它在家目录里、不在 s2 的会话目录里）；别处的写照旧问', async () => {
    const info = writeArtifact({
      sessionId: 's1',
      title: 'Revenue',
      ext: 'svg',
      content: '<svg aria-label="Revenue"></svg>'
    })
    expect(info.path.startsWith(join(ART, 's1'))).toBe(true)

    expect(verdict(evaluatePath('write', info.path))).toEqual(ALLOW)
    expect(verdict(evaluatePath('read', info.path))).toEqual(ALLOW)

    expect(verdict(evaluatePath('write', info.path, 's2'))).toEqual(ASK_WRITE)
    expect(verdict(evaluatePath('read', info.path, 's2'))).toEqual(ASK_READ)

    await expect(
      context().enforcePath('write', info.path, { toolCallId: 'wa', toolName: 'edit' })
    ).resolves.toBeUndefined()
    await expect(
      context().enforcePath('read', info.path, { toolCallId: 'ra', toolName: 'read' })
    ).resolves.toBeUndefined()
    expect(asks).toEqual([])
    // 豁免不是「允许并记住」：什么都没记进会话授权
    expect(state.granted).toEqual([])

    expect(verdict(evaluatePath('write', join(ROOT, 'outside', 'target.txt')))).toEqual(ASK_WRITE)
  })
})
