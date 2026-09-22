/**
 * 桌面 write/edit 的询问接线集成测试 —— 真实临时文件 + 真实 fileTime + **真实安全模块**
 * （createSecurityContext + 内置策略），只把宿主 provider 换成可编程实现（requestUserInput 是 spy）。
 *
 * 与同目录 write.test.ts / edit.test.ts 的分工：那两个把询问 mock 成恒放行，测的是写入内核；
 * 这里恒不放行，测的是「工作目录内写入要弹窗、read 不弹」以及 diff 预览与落盘的一致性。
 *
 * 可编程 provider 缺省**不带** realPath（路径照写法比，既有用例的 `Write(<TEST_DIR>/…)` 断言因此不随
 * macOS 的 /var → /private/var 换写法）；经符号链接的 PERM-R 系列用 `state.realPath` 打开桌面的
 * resolveRealPath，并用 `state.home` 换一个真有 .ssh 的临时家目录。
 *
 * PERM-R 系列的口径：路径**本身**是符号链接的，文件工具不跟（真的桌面 port.readLink）—— 在门之前就抛
 * 一句「它指向哪里、要操作就直接用那一条」，不弹卡、不记决策、两头一个字节都不动；照提示改用真实路径
 * 重发，那一次照常过门。**中间段**是链接的（链接目录、macOS 的 /var）不在此列，照常过门、按真实去处问。
 * 「门没被问」看决策日志（每次 enforce 都记一条，beforeEach 清空）；应答器缺省放行 —— 没弹卡不是
 * 因为被拒。`state.workspace` 换工作区（R19：工作区本身是链接），`state.grants` 喂会话授权（R15）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

const TEST_DIR = join(tmpdir(), 'shuvix-ask-on-write-' + Date.now())
const SESSION_ID = 'ask-session'

const state = vi.hoisted(() => ({
  requests: [] as InputRequest[],
  respond: (() => ({ kind: 'ask', allowed: true })) as (
    req: InputRequest
  ) => InputResponse | Promise<InputResponse>,
  persisted: [] as { mode: string; path: string }[],
  /** 打开桌面的真实路径解析（PERM-R 系列）；缺省关 */
  realPath: false,
  /** vars.home；空 = 一个不存在的家目录（凭据门对既有用例无从命中） */
  home: '',
  /** 工作区（resolveProjectConfig 与 vars.workspace 同一个）；空 = TEST_DIR */
  workspace: '',
  /** 会话授权；缺省 = 不免询问、allowList 空 */
  grants: undefined as { autoAllow: boolean; allowList: string[] } | undefined
}))

// 可编程 provider：桌面口径（内置 workspace-boundary 策略给出工作目录内 read 免询问、
// write 必询问），询问挂起走 spy —— 评估链本身用真实 createSecurityContext
vi.mock('../../services/toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { sep: pathSep } = await import('node:path')
  const { resolveRealPath } = await import('../../utils/toolUtils/realPath')
  const makeContext = (): unknown =>
    createSecurityContext(
      { kind: 'agent', sessionId: SESSION_ID, agentKind: 'root' },
      { host: 'desktop' },
      {
        host: 'desktop',
        pathSep,
        // 每次评估现读开关（工具实例先于开关建好也跟得上）
        get realPath() {
          return state.realPath ? resolveRealPath : undefined
        },
        getVars: () => ({
          workspace: state.workspace || TEST_DIR,
          toolResultsBase: join(TEST_DIR, '.nonexistent-tool-results'),
          skillsDirs: [],
          memoryDirs: [],
          knowledgeRoot: '/kb',
          knowledgeSessionDirs: [],
          home: state.home || join(TEST_DIR, '.nonexistent-home'),
          systemDirs: []
        }),
        readBuiltinPolicyMd: INLINE_POLICY_MD,
        getSessionGrants: () => state.grants ?? { autoAllow: false, allowList: [] },
        isDirectory: () => false,
        persistGrant: (mode: string, path: string) => void state.persisted.push({ mode, path }),
        requestUserInput: async (req: InputRequest) => {
          state.requests.push(req)
          return state.respond(req)
        }
      }
    )
  return {
    resolveProjectConfig: () => ({ workingDirectory: state.workspace || TEST_DIR }),
    isPathWithinWorkspace: (absolutePath: string, workingDirectory: string) => {
      const r = resolve(absolutePath)
      const base = resolve(workingDirectory)
      return r === base || r.startsWith(base + sep)
    },
    getDesktopSecurityContext: makeContext,
    TOOL_ABORTED: 'Aborted'
  }
})
vi.mock('../../services/toolRegistry', () => ({ registerBuiltinTool: () => {} }))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { makeWriteTool } from '../write'
import { makeEditTool } from '../edit'
import { makeReadTool } from '../read'
import { _resetAll, getReadTime } from '../../utils/toolUtils/fileTime'
import type { ToolContext } from '../../services/toolContext'
import { clearSessionDecisions, getSessionDecisions } from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'

/** 内置策略 md 的构建期内联读取口（真实装配链要它；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

const ctx: ToolContext = { sessionId: SESSION_ID }

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }))
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }))
beforeEach(() => {
  _resetAll()
  // 决策日志是模块级的：每条用例从空桶起，「门没被问」才看得出来
  clearSessionDecisions(SESSION_ID)
  state.requests = []
  state.persisted = []
  state.respond = () => ({ kind: 'ask', allowed: true })
  state.realPath = false
  state.home = ''
  state.workspace = ''
  state.grants = undefined
})

describe('桌面 write/edit — 工作目录内写入的询问接线', () => {
  it('PERM-2: 工作目录内 write 弹一次带 diff 预览的询问，同路径 read 不弹', async () => {
    const p = join(TEST_DIR, 'perm2.txt')

    await makeWriteTool(ctx).execute('w1', { path: p, content: 'hello\n' })
    expect(state.requests).toHaveLength(1)
    const req = state.requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    expect(req.toolName).toBe('write')
    expect(req.command).toBe(`Write(${p})`)
    expect(req.preview).toMatchObject({ kind: 'diff', path: p, isNewFile: true })
    expect(readFileSync(p, 'utf-8')).toBe('hello\n')

    state.requests = []
    await makeReadTool(ctx).execute('r1', { path: p })
    expect(state.requests).toEqual([])
  })

  it('PERM-2: 拒绝时不落盘', async () => {
    const p = join(TEST_DIR, 'perm2-denied.txt')
    writeFileSync(p, 'original\n')
    state.respond = () => ({ kind: 'ask', allowed: false })

    await expect(
      makeWriteTool(ctx).execute('w2', { path: p, content: 'overwritten\n' })
    ).rejects.toThrow(/User denied access/)
    expect(readFileSync(p, 'utf-8')).toBe('original\n')
  })

  it('CONS-6: CRLF 文件 edit —— 预览 diff 与 details.diff 一致，落盘仍是 CRLF', async () => {
    const p = join(TEST_DIR, 'crlf.txt')
    writeFileSync(p, 'a\r\nb\r\nc\r\n')

    // edit 要求先读；走真实 read 工具记录读取时间（顺带确认 read 不弹询问）
    await makeReadTool(ctx).execute('r2', { path: p })
    expect(state.requests).toEqual([])

    const res = await makeEditTool(ctx).execute('e1', { path: p, oldText: 'b', newText: 'B' })

    const req = state.requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    const details = res.details as { type: 'edit'; diff: string }
    expect(req.preview?.diff).toBe(details.diff)
    // 按 LF 比较，只有一行被标为改动 —— 不是整篇
    expect(details.diff.split('\n').filter((l) => l.startsWith('-'))).toEqual(['-2 b'])
    expect(details.diff.split('\n').filter((l) => l.startsWith('+'))).toEqual(['+2 B'])
    expect(details.diff).not.toContain('\r')
    // 落盘仍是 CRLF
    expect(readFileSync(p, 'utf-8')).toBe('a\r\nB\r\nc\r\n')
  })

  it('EG-13: 从未读文件 edit —— 询问停留期间外部改动，批准后仍被事后复检作废', async () => {
    const p = join(TEST_DIR, 'eg13.txt')
    writeFileSync(p, 'alpha\nbeta\n') // 不走 read 工具：本会话从未读
    state.respond = () => {
      // 用户在询问卡片上停留期间，外部编辑器改了同一个文件
      writeFileSync(p, 'someone else typed this\n')
      const future = new Date(Date.now() + 60_000)
      utimesSync(p, future, future) // 确保越过 50ms 容差
      return { kind: 'ask', allowed: true }
    }

    await expect(
      makeEditTool(ctx).execute('eg13', { path: p, oldText: 'beta', newText: 'BETA' })
    ).rejects.toThrow(/modified since/)

    expect(state.requests).toHaveLength(1) // 询问恰一次
    // 落盘内容保持外部改动，未被预览对应的写入覆盖
    expect(readFileSync(p, 'utf-8')).toBe('someone else typed this\n')
  })

  it('EG-14: 从未读文件 edit 正常批准 —— 预览 diff 与 details.diff 一致', async () => {
    const p = join(TEST_DIR, 'eg14.txt')
    writeFileSync(p, 'alpha\nbeta\ngamma\n') // 不走 read 工具：本会话从未读

    const res = await makeEditTool(ctx).execute('eg14', {
      path: p,
      oldText: 'beta',
      newText: 'BETA'
    })

    expect(state.requests).toHaveLength(1)
    const req = state.requests[0]
    if (req.kind !== 'ask') throw new Error('expected an ask request')
    const details = res.details as { type: 'edit'; diff: string }
    expect(req.preview?.diff).toBe(details.diff)
    expect(readFileSync(p, 'utf-8')).toBe('alpha\nBETA\ngamma\n')
  })

  it('EG-15: 从未读文件 edit 被拒 —— 内部整读的基线留存，随后无改动再 edit 成功', async () => {
    const p = join(TEST_DIR, 'eg15.txt')
    writeFileSync(p, 'alpha\nbeta\n') // 不走 read 工具：本会话从未读
    state.respond = () => ({ kind: 'ask', allowed: false })

    await expect(
      makeEditTool(ctx).execute('eg15a', { path: p, oldText: 'beta', newText: 'BETA' })
    ).rejects.toThrow(/User denied/)
    expect(readFileSync(p, 'utf-8')).toBe('alpha\nbeta\n')

    // 拒绝时内部整读已登记基线且无外部改动 → 第二次 edit 前置校验放行，批准后成功
    state.respond = () => ({ kind: 'ask', allowed: true })
    await makeEditTool(ctx).execute('eg15b', { path: p, oldText: 'beta', newText: 'BETA' })
    expect(readFileSync(p, 'utf-8')).toBe('alpha\nBETA\n')
  })
})

/** 取出一次询问（不是 ask 就判红） */
function askOf(req: InputRequest | undefined): Extract<InputRequest, { kind: 'ask' }> {
  if (req?.kind !== 'ask') throw new Error('expected an ask request')
  return req
}

/** 抓住一次拒绝的原话（没拒就判红） */
async function messageOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error('expected the call to be refused')
}

/** 结果里的全部文本块 */
function textOf(res: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return res.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('')
}

/**
 * 一条链接与它那头的现状：链接自己（仍是链接、存的原文）+ 那头的内容与 mtime（不存在 = null；
 * 目录记条目清单）。拒绝前后各拍一次，toEqual 即「两头一个字节都没动」
 */
function footprint(
  link: string,
  target: string
): {
  isLink: boolean
  linkText: string
  content: string | string[] | null
  mtimeMs: number | null
} {
  const st = existsSync(target) ? statSync(target) : null
  return {
    isLink: lstatSync(link).isSymbolicLink(),
    linkText: readlinkSync(link),
    content:
      st === null
        ? null
        : st.isDirectory()
          ? readdirSync(target).sort()
          : readFileSync(target, 'utf-8'),
    mtimeMs: st?.mtimeMs ?? null
  }
}

/** 没弹卡、门也没被问（每次 enforce 都记一条决策：一条都没有 = 门没被问到） */
function expectGateUntouched(): void {
  expect(state.requests).toEqual([])
  expect(getSessionDecisions(SESSION_ID)).toEqual([])
}

describe.skipIf(process.platform === 'win32')(
  '桌面 read/write/edit — 路径本身是链接就不跟；中间段的链接按真实去处询问',
  () => {
    /** 临时家目录（真有 .ssh/id_rsa）、区外文件的所在、R19 的真工作区与指向它的链接 */
    let HOME = ''
    let OUTSIDE = ''
    let REAL_WS = ''
    let WS_LINK = ''

    /**
     * 目录树：
     *   HOME/.ssh/id_rsa
     *   OUTSIDE/target.txt、edit-target.txt、doc.txt、chain-end.txt、ldir/real.txt、
     *           ldir/innerlink → real.txt（相对）、wslink → REAL_WS
     *   REAL_WS/plain-target.txt
     *   TEST_DIR（工作区）里：
     *     key → HOME/.ssh/id_rsa            wlink → OUTSIDE/target.txt     sshlink → HOME/.ssh
     *     .ssh/id_rsa（诱饵：`<ws>/sshlink/../.ssh/id_rsa` 按字面折叠会落到它身上）
     *     elink → OUTSIDE/edit-target.txt   dirlink → OUTSIDE              ldirlink → OUTSIDE/ldir
     *     dang → OUTSIDE/missing/deeper/new.txt（悬空，上级目录都没有）
     *     newkey → HOME/.ssh/authorized_keys（悬空，指进凭据目录）
     *     relkey → ../<HOME 的名字>/.ssh/id_rsa（相对原文）
     *     c1 → c2（相对）、c2 → OUTSIDE/chain-end.txt
     *     inside.txt、inlink → TEST_DIR/inside.txt（区内指区内）
     *     loop → loop（自己指向自己）
     */
    beforeAll(() => {
      HOME = mkdtempSync(join(tmpdir(), 'shuvix-ask-home-'))
      mkdirSync(join(HOME, '.ssh'))
      writeFileSync(join(HOME, '.ssh', 'id_rsa'), 'PRIVATE KEY\n')

      OUTSIDE = mkdtempSync(join(tmpdir(), 'shuvix-ask-outside-'))
      writeFileSync(join(OUTSIDE, 'target.txt'), 'old\n')
      writeFileSync(join(OUTSIDE, 'edit-target.txt'), 'alpha\nbeta\n')
      writeFileSync(join(OUTSIDE, 'doc.txt'), 'doc\n')
      writeFileSync(join(OUTSIDE, 'chain-end.txt'), 'end\n')
      mkdirSync(join(OUTSIDE, 'ldir'))
      writeFileSync(join(OUTSIDE, 'ldir', 'real.txt'), 'real\n')
      symlinkSync('real.txt', join(OUTSIDE, 'ldir', 'innerlink'))

      REAL_WS = mkdtempSync(join(tmpdir(), 'shuvix-ask-realws-'))
      writeFileSync(join(REAL_WS, 'plain-target.txt'), 'plain\n')
      WS_LINK = join(OUTSIDE, 'wslink')
      symlinkSync(REAL_WS, WS_LINK)

      symlinkSync(join(HOME, '.ssh', 'id_rsa'), join(TEST_DIR, 'key'))
      symlinkSync(join(OUTSIDE, 'target.txt'), join(TEST_DIR, 'wlink'))
      symlinkSync(join(HOME, '.ssh'), join(TEST_DIR, 'sshlink'))
      mkdirSync(join(TEST_DIR, '.ssh'))
      writeFileSync(join(TEST_DIR, '.ssh', 'id_rsa'), 'DECOY\n')
      symlinkSync(join(OUTSIDE, 'edit-target.txt'), join(TEST_DIR, 'elink'))
      symlinkSync(OUTSIDE, join(TEST_DIR, 'dirlink'))
      symlinkSync(join(OUTSIDE, 'ldir'), join(TEST_DIR, 'ldirlink'))
      symlinkSync(join(OUTSIDE, 'missing', 'deeper', 'new.txt'), join(TEST_DIR, 'dang'))
      symlinkSync(join(HOME, '.ssh', 'authorized_keys'), join(TEST_DIR, 'newkey'))
      symlinkSync(`../${basename(HOME)}/.ssh/id_rsa`, join(TEST_DIR, 'relkey'))
      symlinkSync('c2', join(TEST_DIR, 'c1'))
      symlinkSync(join(OUTSIDE, 'chain-end.txt'), join(TEST_DIR, 'c2'))
      writeFileSync(join(TEST_DIR, 'inside.txt'), 'inside\n')
      symlinkSync(join(TEST_DIR, 'inside.txt'), join(TEST_DIR, 'inlink'))
      symlinkSync(join(TEST_DIR, 'loop'), join(TEST_DIR, 'loop'))
    })

    afterAll(() => {
      for (const dir of [HOME, OUTSIDE, REAL_WS]) {
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    })

    beforeEach(() => {
      state.realPath = true
      state.home = HOME
    })

    it('PERM-R1 read 工作区里一条指向私钥的链接：不跟 —— 原话说出它指向的私钥，不弹卡、门不问，私钥与链接都不动；照提示改用真实路径重发，才按私钥问一次（没有 requestedPath），允许后读到', async () => {
      const link = join(TEST_DIR, 'key')
      const target = join(HOME, '.ssh', 'id_rsa')
      const real = realpathSync.native(target)
      const before = footprint(link, target)

      expect(await messageOf(makeReadTool(ctx).execute('pr1a', { path: link }))).toBe(
        `${link} is a symbolic link to ${real}. Symbolic links are not followed — read ${real} directly if that is the file you mean.`
      )
      expectGateUntouched()
      expect(footprint(link, target)).toEqual(before)
      // 读取内核一步都没走到：哪一头都没有读取时间落下
      expect(getReadTime(SESSION_ID, link)).toBeUndefined()
      expect(getReadTime(SESSION_ID, real)).toBeUndefined()

      const res = await makeReadTool(ctx).execute('pr1b', { path: real })
      expect(state.requests).toHaveLength(1)
      const req = askOf(state.requests[0])
      expect(req.toolName).toBe('read')
      expect(req.command).toBe(`Read(${real})`)
      expect(req.requestedPath).toBeUndefined()
      expect(textOf(res)).toContain('PRIVATE KEY')
    })

    it('PERM-R2 write 一条指向区外真文件的链接：不跟 —— 原话以 Not written 起头，不弹卡、门不问，那头的字节与 mtime、链接本身都不动；改用真实路径重发：问一次 Write(R)（没有 requestedPath，diff 是那头的旧文），允许后字节落在 R，链接仍是链接', async () => {
      const link = join(TEST_DIR, 'wlink')
      const target = join(OUTSIDE, 'target.txt')
      const real = realpathSync.native(target)
      const before = footprint(link, target)

      expect(
        await messageOf(makeWriteTool(ctx).execute('pr2a', { path: link, content: 'new\n' }))
      ).toBe(
        `Not written: ${link} is a symbolic link to ${real}. Symbolic links are not followed — write to ${real} directly if that is the file you mean.`
      )
      expectGateUntouched()
      expect(footprint(link, target)).toEqual(before)

      await makeWriteTool(ctx).execute('pr2b', { path: real, content: 'new\n' })
      expect(state.requests).toHaveLength(1)
      const req = askOf(state.requests[0])
      expect(req.command).toBe(`Write(${real})`)
      expect(req.requestedPath).toBeUndefined()
      expect(req.preview).toMatchObject({ kind: 'diff', path: real, isNewFile: false })
      expect(req.preview?.diff).toContain('-1 old')
      expect(req.preview?.diff).toContain('+1 new')

      expect(readFileSync(target, 'utf-8')).toBe('new\n')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(target)
    })

    it('PERM-R3 普通的区内写（写法就是真实路径）：卡片与从前一样，没有 requestedPath', async () => {
      // TEST_DIR 在 tmpdir 下，macOS 上 /var 本身就是链接 —— 写法得用解析过的那一个才算「中间没有链接」
      const p = join(realpathSync.native(TEST_DIR), 'plain.txt')

      await makeWriteTool(ctx).execute('pr3', { path: p, content: 'x\n' })
      expect(state.requests).toHaveLength(1)
      const req = askOf(state.requests[0])
      expect(req.command).toBe(`Write(${p})`)
      expect(req.requestedPath).toBeUndefined()
      expect(req.preview).toMatchObject({ kind: 'diff', path: p, isNewFile: true })
      expect(readFileSync(p, 'utf-8')).toBe('x\n')
    })

    it('PERM-R4 `..` 穿过链接的绝对路径（原样交给门，不折叠）：read 按私钥询问、允许后读到的正是私钥而不是字面折叠那头的诱饵；写一把新 key 直接拒、两处都不落盘', async () => {
      const readPath = `${TEST_DIR}/sshlink/../.ssh/id_rsa`
      const realKey = realpathSync.native(join(HOME, '.ssh', 'id_rsa'))

      state.respond = () => ({ kind: 'ask', allowed: false })
      await expect(makeReadTool(ctx).execute('pr4a', { path: readPath })).rejects.toThrow(
        `User denied access to ${readPath}`
      )
      expect(state.requests).toHaveLength(1)
      const req = askOf(state.requests[0])
      expect(req.command).toBe(`Read(${realKey})`)
      expect(req.requestedPath).toBe(readPath)

      // 门判的就是内核会打开的那个文件：允许之后读回来的是私钥
      state.respond = () => ({ kind: 'ask', allowed: true })
      const res = await makeReadTool(ctx).execute('pr4b', { path: readPath })
      const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
      expect(text).toContain('PRIVATE KEY')
      expect(text).not.toContain('DECOY')

      state.requests = []
      const writePath = `${TEST_DIR}/sshlink/../.ssh/new_key`
      const realNewKey = join(realpathSync.native(HOME), '.ssh', 'new_key')
      await expect(
        makeWriteTool(ctx).execute('pr4c', { path: writePath, content: 'k' })
      ).rejects.toThrow(
        `Denied by security policy rule 'protect-credentials#0' (${writePath} resolves to ${realNewKey})`
      )
      expect(state.requests).toEqual([])
      expect(existsSync(join(HOME, '.ssh', 'new_key'))).toBe(false)
      expect(existsSync(join(TEST_DIR, '.ssh', 'new_key'))).toBe(false)
    })

    it('PERM-R5 先按真实路径读过那头，再经链接 edit：不跟 —— 原话以 Not edited 起头（D 照写相对的 elink），不弹卡、门不问，那头与读取时间都原样；改用真实路径重发：问一次 Write(R)，改动落在 R', async () => {
      const link = join(TEST_DIR, 'elink')
      const target = join(OUTSIDE, 'edit-target.txt')
      const real = realpathSync.native(target)

      // 区外文件：读它问一次、放行，读取时间记在 R 上
      await makeReadTool(ctx).execute('pr5a', { path: real })
      const readAt = getReadTime(SESSION_ID, real)
      expect(readAt).toBeDefined()
      state.requests = []
      clearSessionDecisions(SESSION_ID)
      const before = footprint(link, target)

      expect(
        await messageOf(
          makeEditTool(ctx).execute('pr5b', { path: 'elink', oldText: 'beta', newText: 'BETA' })
        )
      ).toBe(
        `Not edited: elink is a symbolic link to ${real}. Symbolic links are not followed — edit ${real} directly if that is the file you mean.`
      )
      expectGateUntouched()
      expect(footprint(link, target)).toEqual(before)
      expect(getReadTime(SESSION_ID, real)).toBe(readAt)
      expect(getReadTime(SESSION_ID, link)).toBeUndefined()

      await makeEditTool(ctx).execute('pr5c', { path: real, oldText: 'beta', newText: 'BETA' })
      expect(state.requests).toHaveLength(1)
      const req = askOf(state.requests[0])
      expect(req.toolName).toBe('edit')
      expect(req.command).toBe(`Write(${real})`)
      expect(req.requestedPath).toBeUndefined()
      expect(readFileSync(target, 'utf-8')).toBe('alpha\nBETA\n')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
    })

    it('PERM-R6 指向目录的链接：read 它本身被拒（说出那头的目录）、门不问；经它读里面的文件（链接在中间）照常过门 —— 问一次，卡片是真实去处、注着写法', async () => {
      const link = join(TEST_DIR, 'dirlink')
      const realDir = realpathSync.native(OUTSIDE)

      const msg = await messageOf(makeReadTool(ctx).execute('pr6a', { path: link }))
      expect(msg).toContain(`${link} is a symbolic link to ${realDir}.`)
      expect(msg).toContain(`read ${realDir} directly`)
      expectGateUntouched()

      const through = join(link, 'doc.txt')
      const res = await makeReadTool(ctx).execute('pr6b', { path: through })
      expect(state.requests).toHaveLength(1)
      const req = askOf(state.requests[0])
      expect(req.command).toBe(`Read(${join(realDir, 'doc.txt')})`)
      expect(req.requestedPath).toBe(through)
      expect(textOf(res)).toContain('doc')
    })

    it('PERM-R7 write 一条指向目录的链接：拒（Not written，说出那头的目录），不弹卡、门不问；那头仍是原来那个目录，链接原样', async () => {
      const link = join(TEST_DIR, 'dirlink')
      const before = footprint(link, OUTSIDE)

      expect(
        await messageOf(makeWriteTool(ctx).execute('pr7', { path: link, content: 'x\n' }))
      ).toContain(`Not written: ${link} is a symbolic link to ${realpathSync.native(OUTSIDE)}.`)
      expectGateUntouched()
      expect(footprint(link, OUTSIDE)).toEqual(before)
    })

    it('PERM-R8 悬空链接、那头连上级目录都还没有：read / write 都拒的是链接这一条（不是 File not found），什么都不建；改用 R 重发 —— 问一次，连目录一起建在 R', async () => {
      const link = join(TEST_DIR, 'dang')
      const real = join(realpathSync.native(OUTSIDE), 'missing', 'deeper', 'new.txt')

      const readMsg = await messageOf(makeReadTool(ctx).execute('pr8a', { path: link }))
      expect(readMsg).toContain(`${link} is a symbolic link to ${real}.`)
      expect(readMsg).not.toContain('File not found')
      expect(readMsg).not.toContain('Did you mean')
      const writeMsg = await messageOf(
        makeWriteTool(ctx).execute('pr8b', { path: link, content: 'x\n' })
      )
      expect(writeMsg).toContain(`Not written: ${link} is a symbolic link to ${real}.`)
      expectGateUntouched()
      expect(existsSync(join(OUTSIDE, 'missing'))).toBe(false)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(join(OUTSIDE, 'missing', 'deeper', 'new.txt'))

      await makeWriteTool(ctx).execute('pr8c', { path: real, content: 'x\n' })
      expect(state.requests).toHaveLength(1)
      const req = askOf(state.requests[0])
      expect(req.command).toBe(`Write(${real})`)
      expect(req.requestedPath).toBeUndefined()
      expect(readFileSync(real, 'utf-8')).toBe('x\n')
    })

    it('PERM-R9 悬空链接指进 ~/.ssh（authorized_keys 还不存在）：write 被这一条拒、不弹卡、门不问；改用 R 重发 → protect-credentials#0 直接拒（R 就是真实去处，文案里没有 resolves to 补注）；两次都什么都没建', async () => {
      const link = join(TEST_DIR, 'newkey')
      const real = join(realpathSync.native(HOME), '.ssh', 'authorized_keys')

      expect(
        await messageOf(
          makeWriteTool(ctx).execute('pr9a', { path: link, content: 'ssh-ed25519 AAAA\n' })
        )
      ).toContain(`Not written: ${link} is a symbolic link to ${real}.`)
      expectGateUntouched()

      const denied = await messageOf(
        makeWriteTool(ctx).execute('pr9b', { path: real, content: 'ssh-ed25519 AAAA\n' })
      )
      const head = `Denied by security policy rule 'protect-credentials#0'`
      expect(denied.slice(0, head.length)).toBe(head)
      expect(denied).not.toContain('resolves to')
      expect(state.requests).toEqual([])
      expect(getSessionDecisions(SESSION_ID).map((d) => d.effect)).toEqual(['deny'])
      expect(existsSync(join(HOME, '.ssh', 'authorized_keys'))).toBe(false)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
    })

    it('PERM-R10 链接存的是相对原文（../<家目录>/.ssh/id_rsa）：拒绝文案原样引出它，R 仍是绝对的真实去处', async () => {
      const text = `../${basename(HOME)}/.ssh/id_rsa`
      const real = realpathSync.native(join(HOME, '.ssh', 'id_rsa'))
      expect(readlinkSync(join(TEST_DIR, 'relkey'))).toBe(text)

      expect(await messageOf(makeReadTool(ctx).execute('pr10', { path: 'relkey' }))).toContain(
        `relkey is a symbolic link to ${real} (the link says "${text}"). Symbolic links are not followed — read ${real} directly`
      )
      expectGateUntouched()
    })

    it('PERM-R11 链接链（c1 → c2 → 区外文件）：说出的是链的尽头，引出的是第一跳的原文；从 c2 问起就没有引文（原文是绝对的）', async () => {
      const real = realpathSync.native(join(OUTSIDE, 'chain-end.txt'))

      expect(await messageOf(makeReadTool(ctx).execute('pr11a', { path: 'c1' }))).toContain(
        `c1 is a symbolic link to ${real} (the link says "c2").`
      )
      const second = await messageOf(makeReadTool(ctx).execute('pr11b', { path: 'c2' }))
      expect(second).toContain(`c2 is a symbolic link to ${real}.`)
      expect(second).not.toContain('the link says')
      expectGateUntouched()
    })

    it('PERM-R12 区内链接指向区内文件也没有豁免：read / write / edit 都拒（那头本来读都不用问），两头一个字节都不动；改用真实路径读 —— 不问、照常读到', async () => {
      const link = join(TEST_DIR, 'inlink')
      const target = join(TEST_DIR, 'inside.txt')
      const real = realpathSync.native(target)
      const before = footprint(link, target)

      expect(await messageOf(makeReadTool(ctx).execute('pr12a', { path: 'inlink' }))).toContain(
        `inlink is a symbolic link to ${real}.`
      )
      expect(
        await messageOf(makeWriteTool(ctx).execute('pr12b', { path: 'inlink', content: 'x\n' }))
      ).toContain(`Not written: inlink is a symbolic link to ${real}.`)
      expect(
        await messageOf(
          makeEditTool(ctx).execute('pr12c', { path: 'inlink', oldText: 'inside', newText: 'x' })
        )
      ).toContain(`Not edited: inlink is a symbolic link to ${real}.`)
      expectGateUntouched()
      expect(footprint(link, target)).toEqual(before)

      expect(textOf(await makeReadTool(ctx).execute('pr12d', { path: real }))).toContain('inside')
      expect(state.requests).toEqual([])
    })

    it('PERM-R13 经链接目录走到的最后一段本身又是链接：拒（D 照写，R 是它最终的去处，相对原文从它自己的目录起算）；同一目录里的真文件照常过门 —— 问一次，注着写法', async () => {
      const dirLink = join(TEST_DIR, 'ldirlink')
      const viaLink = join(dirLink, 'innerlink')
      const real = realpathSync.native(join(OUTSIDE, 'ldir', 'real.txt'))

      expect(await messageOf(makeReadTool(ctx).execute('pr13a', { path: viaLink }))).toContain(
        `${viaLink} is a symbolic link to ${real} (the link says "real.txt").`
      )
      expectGateUntouched()

      const plain = join(dirLink, 'real.txt')
      const res = await makeReadTool(ctx).execute('pr13b', { path: plain })
      expect(state.requests).toHaveLength(1)
      const req = askOf(state.requests[0])
      expect(req.command).toBe(`Read(${real})`)
      expect(req.requestedPath).toBe(plain)
      expect(textOf(res)).toContain('real')
    })

    it.skipIf(process.platform !== 'darwin')(
      'PERM-R14 macOS 的 /var 在中间：tmpdir 下照写法（/var/folders/…）读写都不触发这一条 —— 写照常问一次（注着写法），读区内文件、列工作区目录都不问',
      async () => {
        const realDir = realpathSync.native(TEST_DIR)
        // 前提：写法与真实位置之间确实隔着 /var 这条系统级链接
        expect(realDir).not.toBe(TEST_DIR)

        const p = join(TEST_DIR, 'r14.txt')
        await makeWriteTool(ctx).execute('pr14a', { path: p, content: 'r14\n' })
        expect(state.requests).toHaveLength(1)
        const req = askOf(state.requests[0])
        expect(req.command).toBe(`Write(${join(realDir, 'r14.txt')})`)
        expect(req.requestedPath).toBe(p)
        expect(readFileSync(p, 'utf-8')).toBe('r14\n')

        state.requests = []
        expect(textOf(await makeReadTool(ctx).execute('pr14b', { path: p }))).toContain('r14')
        expect(textOf(await makeReadTool(ctx).execute('pr14c', { path: TEST_DIR }))).toContain(
          'r14.txt'
        )
        expect(state.requests).toEqual([])
      }
    )

    it('PERM-R15 会话授权跳不过这一条：免询问、allowList 里写着链接与真实去处 —— read / write 照样被拒，门不问，私钥与链接都不动', async () => {
      const link = join(TEST_DIR, 'key')
      const target = join(HOME, '.ssh', 'id_rsa')
      const real = realpathSync.native(target)
      const before = footprint(link, target)

      for (const grants of [
        { autoAllow: true, allowList: [] },
        {
          autoAllow: false,
          allowList: [`Read(${link})`, `Write(${link})`, `Read(${real})`, `Write(${real})`]
        }
      ]) {
        state.grants = grants
        const label = grants.autoAllow ? 'autoAllow' : 'allowList'
        expect(
          await messageOf(makeReadTool(ctx).execute('pr15a', { path: link })),
          label
        ).toContain(`${link} is a symbolic link to ${real}.`)
        expect(
          await messageOf(makeWriteTool(ctx).execute('pr15b', { path: link, content: 'x\n' })),
          label
        ).toContain(`Not written: ${link} is a symbolic link to ${real}.`)
      }
      expectGateUntouched()
      expect(state.persisted).toEqual([])
      expect(footprint(link, target)).toEqual(before)
    })

    it('PERM-R16 每次调用现看：同一个 read 工具实例 —— 路径先是真文件（读到）→ 换成链接（拒）→ 再换回真文件（又读到）', async () => {
      const p = join(TEST_DIR, 'swap.txt')
      const tool = makeReadTool(ctx)

      writeFileSync(p, 'plain\n')
      expect(textOf(await tool.execute('pr16a', { path: p }))).toContain('plain')

      rmSync(p)
      symlinkSync(join(OUTSIDE, 'doc.txt'), p)
      expect(await messageOf(tool.execute('pr16b', { path: p }))).toContain(
        `${p} is a symbolic link to ${realpathSync.native(join(OUTSIDE, 'doc.txt'))}.`
      )

      rmSync(p)
      writeFileSync(p, 'plain again\n')
      expect(textOf(await tool.execute('pr16c', { path: p }))).toContain('plain again')
      expect(state.requests).toEqual([])
    })

    it('PERM-R17 链接环（自己指向自己）：不挂、不抛 ELOOP，照样拒 —— 说出的去处是环上的那个名字；write 同样拒，链接原样', async () => {
      const link = join(TEST_DIR, 'loop')
      // 停在环上哪一跳是 resolveRealPath 的细节（见 realPath.test RP-7）：写法或真实前缀下的同一个名字
      const heads = [link, join(realpathSync.native(TEST_DIR), 'loop')].map(
        (named) => `${link} is a symbolic link to ${named}. `
      )

      const readMsg = await messageOf(makeReadTool(ctx).execute('pr17a', { path: link }))
      // 以两种说法之一起头；都不是就把原话整句摆出来
      expect(heads.some((h) => readMsg.startsWith(h)) ? 'ok' : readMsg).toBe('ok')
      const writeMsg = await messageOf(
        makeWriteTool(ctx).execute('pr17b', { path: link, content: 'x\n' })
      )
      const writeHead = `Not written: ${link} is a symbolic link to `
      expect(writeMsg.slice(0, writeHead.length)).toBe(writeHead)
      expect(readlinkSync(link)).toBe(link)
      expectGateUntouched()
    })

    it('PERM-R18 指向目录的链接带结尾 `/` 或 `/.`：相对、绝对两种写法一样被拒（D 照写，R 是 OUTSIDE 的真实位置），不弹卡、门不问', async () => {
      const realDir = realpathSync.native(OUTSIDE)
      for (const D of ['dirlink/', 'dirlink/.', `${TEST_DIR}/dirlink/`, `${TEST_DIR}/dirlink/.`]) {
        const msg = await messageOf(makeReadTool(ctx).execute('pr18', { path: D }))
        const head = `${D} is a symbolic link to ${realDir}. Symbolic links are not followed — read ${realDir} directly`
        expect(msg.slice(0, head.length), D).toBe(head)
      }
      expectGateUntouched()
    })

    it('PERM-R19 工作区本身经链接打开：read(".") 被拒（它就是那条链接）；改用真实路径 —— 不问、照常列出；区内普通文件（链接只在中间）照常读到、不问', async () => {
      state.workspace = WS_LINK
      const realWs = realpathSync.native(REAL_WS)

      const msg = await messageOf(makeReadTool(ctx).execute('pr19a', { path: '.' }))
      const head = `. is a symbolic link to ${realWs}. Symbolic links are not followed — read ${realWs} directly`
      expect(msg.slice(0, head.length)).toBe(head)
      expectGateUntouched()

      expect(textOf(await makeReadTool(ctx).execute('pr19b', { path: realWs }))).toContain(
        'plain-target.txt'
      )
      expect(
        textOf(await makeReadTool(ctx).execute('pr19c', { path: 'plain-target.txt' }))
      ).toContain('plain')
      expect(state.requests).toEqual([])
    })
  }
)
