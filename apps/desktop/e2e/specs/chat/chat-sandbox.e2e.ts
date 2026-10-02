/**
 * 命令沙箱（macOS Seatbelt）在真实实例里的几件事。2026-10-01 第二轮起沙箱**只收文件访问**：
 * 受限命令只能读写本会话的目录（工作目录、本会话 TMPDIR、artifacts、工具结果，加「允许并记住」
 * 的授权），家目录里其余位置读不到，家目录以外照读；文件工具的询问（ask-on-external-path）与它
 * 用同一份会话目录清单。
 *
 *  - E2E-1 受限命令不问就跑：能写工作区、TMPDIR 指向本会话临时目录；会话目录以外的写入被沙箱拦下，
 *    结果里带一段 `[sandbox]` 说明（点名路径、教模型用 dangerouslyDisableSandbox）—— `~/.shuvix`
 *    与 `/private/tmp`（从前是可写根）都一样；
 *  - E2E-2 申请完全访问的命令要问、卡片上有「完全访问」标签；拒绝 → 没跑；允许 → 真的不受限；
 *  - E2E-3 文件工具与沙箱同一份会话目录：工作区里的写不问，`.git/hooks` 也不再受保护（受限命令能
 *    git init 并写它的 hooks）；会话目录以外的写要问（ask-on-external-path#1），路径询问没有「完全访问」；
 *  - E2E-4 按会话固定：会话中途关掉开关，已在跑的会话照旧受限；新会话按新值（逐条询问、无标签）；
 *  - E2E-5（FU-8）受限命令停本会话的后台任务：`shuvix task stop <pid>` 整条链路在沙箱里走得通
 *    （读 cli-token、连 cli.sock、Electron 以 node 模式起）；停了不回头通知；别的 pid 找不到、退出 1；
 *  - E2E-6 工具卡上的沙箱标记与「实际执行的命令」：受限命令的 details / 落库块都标 confined；宿主记下的
 *    那份命令（sandbox-exec 包装、TMPDIR 等变量、会话 id、原命令）经 IPC 取得到、坏的会话 id / 调用 id
 *    取不到；卡片展开后才出标记与开关，点开显示的就是 IPC 那份；切走再切回照旧；
 *  - E2E-7 沙箱关着 + 一条没跑起来的命令：拒绝的那条没有记录、落库块没有标记；允许的那条标 disabled，
 *    记录里是裸的 `/bin/bash --norc -c …`（没有 sandbox-exec、没有 TMPDIR）；
 *  - E2E-8 读的那一面：家目录里会话目录以外的一律读不到（~/Downloads、~/.ssh、~/.shuvix/.session-state
 *    都一样，凭据不再特殊）、结果里带 `cannot read`；家目录以外照读；read 工具同一个口径 ——
 *    家目录以外不问，读 ~/.ssh 要问（ask-on-external-path#0）；
 *  - E2E-9 「允许并记住」两面生效：read 工具上记住的读授权、write 工具上记住的写授权，同一会话的下一条
 *    受限命令就读得到 / 写得进；在会话配置里撤掉读授权，下一条命令又读不到 —— 证明授权按命令现读、
 *    与策略同一个来源；
 *  - E2E-10 写的范围两面一致：项目根的 .vscode / .envrc / .claude / .mcp.json 不受保护 ——
 *    write 工具不问，受限命令也写得了。
 *
 * 每个用例先看沙箱在这个实例里能不能用（整组测试本身跑在别的沙箱里时 sandbox-exec 嵌套失败），
 * 不能用就 skip。注意 fake HOME 在 /private/tmp 下、它就是沙箱眼里的家目录：项目建在它里面
 * （工作目录是会话目录，照常读写），家目录以外的位置要另找（mkdtemp 在 /private/tmp 下的兄弟目录）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  sandboxAvailable,
  securityDecisions,
  seedFakeProvider,
  setSandboxEnabled,
  waitRendererReady,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'
const USAGE = { prompt: 90, completion: 6 }

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let projDir = ''
/** fake HOME **以外**的一个目录（/private/tmp 下的兄弟目录）：沙箱照读、read 工具不问 */
let outsideHome = ''
const sids: Record<string, string> = {}

type InputRequestEvent = RecordedEvent & { request: { id: string; unsandboxed?: boolean } }
type ToolEndEvent = RecordedEvent & {
  toolCallId: string
  result?: unknown
  isError?: boolean
  details?: { sandbox?: string }
}
/** message.list 的一条（只取这里读到的字段） */
interface ListedMessage {
  blocks?: Array<{ type: string; toolCallId?: string; details?: { sandbox?: string } }>
}

const createSession = async (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

/** 工具卡上「实际执行的命令」走的那条 IPC */
const readInvocation = (sessionId: string, toolCallId: string): Promise<string | null> =>
  app.main.eval<string | null>(
    `window.api.bgTask.readInvocation(${JSON.stringify({ sessionId, toolCallId })})`
  )

/** 落库的那个工具块（重开会话时界面读的就是它） */
async function persistedBlock(
  sid: string,
  toolCallId: string
): Promise<NonNullable<ListedMessage['blocks']>[number]> {
  const messages = await app.main.eval<ListedMessage[]>(
    `window.api.message.list(${JSON.stringify(sid)})`
  )
  const block = messages.flatMap((m) => m.blocks ?? []).find((b) => b.toolCallId === toolCallId)
  expect(block, `persisted block ${toolCallId}`).toBeDefined()
  return block!
}

const sessionEvents = async (sid: string): Promise<RecordedEvent[]> =>
  (await events.all()).filter((e) => e.sessionId === sid)

const bashCall = (
  id: string,
  command: string,
  extra: Record<string, unknown> = {}
): { id: string; name: string; args: string } => ({
  id,
  name: 'bash',
  args: JSON.stringify({ command, description: 'e2e sandbox probe', ...extra })
})

const writeCall = (
  id: string,
  path: string,
  content: string
): { id: string; name: string; args: string } => ({
  id,
  name: 'write',
  args: JSON.stringify({ path, content })
})

const readCall = (id: string, path: string): { id: string; name: string; args: string } => ({
  id,
  name: 'read',
  args: JSON.stringify({ path })
})

/** E2E-1 试写的 /private/tmp 位置（家目录以外、会话目录以外）：不该被建出来，afterAll 兜底删 */
const tmpProbe = `/private/tmp/shuvix-e2e-sbx-probe-${process.pid}`

/** 这次调用的安全决策（按 toolCallId 认） */
const decisionsOf = (toolCallId: string): ReturnType<typeof securityDecisions> =>
  securityDecisions(app).filter((d) => d.toolCallId === toolCallId)

/** 会话里「允许并记住」的条目（`Read(…)` / `Write(…)`） */
const allowList = (sid: string): Promise<string[]> =>
  app.main.eval<string[]>(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => (s && s.settings && s.settings.allowList) || [])`
  )

/** 在会话里发一条消息，脚本化「一串工具调用（一步一个）→ 一句收尾」 */
async function sendSteps(
  title: string,
  calls: Array<{ id: string; name: string; args: string }>,
  prompt: string
): Promise<void> {
  provider.reset()
  provider.script(...calls.map((call) => ({ toolCalls: [call], usage: USAGE })), {
    text: 'done',
    usage: USAGE
  })
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
  await chat.typeAndSend(prompt)
}

/** 在会话里发一条消息，脚本化「一次工具调用 → 一句收尾」 */
async function sendTurn(
  title: string,
  call: { id: string; name: string; args: string },
  prompt: string
): Promise<void> {
  provider.reset()
  provider.script({ toolCalls: [call], usage: USAGE }, { text: 'done', usage: USAGE })
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
  await chat.typeAndSend(prompt)
}

async function toolEnd(sid: string, toolCallId: string): Promise<ToolEndEvent> {
  const hit = (await sessionEvents(sid)).find(
    (e) => e.type === 'tool_end' && (e as ToolEndEvent).toolCallId === toolCallId
  ) as ToolEndEvent | undefined
  expect(hit, `tool_end ${toolCallId}`).toBeDefined()
  return hit!
}

const askCount = async (sid: string): Promise<number> =>
  (await sessionEvents(sid)).filter((e) => e.type === 'input_request').length

async function answer(
  sid: string,
  requestId: string,
  allowed: boolean,
  remember = false
): Promise<void> {
  await app.main.eval(
    `window.api.agent.respondToInput(${JSON.stringify({
      sessionId: sid,
      requestId,
      response: { kind: 'ask', allowed, ...(remember ? { extra: { rememberPath: true } } : {}) }
    })})`
  )
  await events.waitFor('input_request_resolved', { sessionId: sid })
}

beforeAll(async () => {
  app = await launchApp()
  // 在任何会话发出第一条消息之前：沙箱按会话固定，开关只影响之后创建的运行时
  await setSandboxEnabled(app.main, true)
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-sbx')
  mkdirSync(projDir, { recursive: true })
  outsideHome = mkdtempSync('/private/tmp/shuvix-e2e-outside-')
  writeFileSync(join(outsideHome, 'world.txt'), 'WORLD-E2E\n')
  const project = await createProject(app.main, { name: 'SandboxProj', path: projDir })

  sids.confined = await createSession('S-confined', project.id)
  sids.full = await createSession('S-full', project.id)
  sids.files = await createSession('S-files', project.id)
  sids.pinA = await createSession('S-pin-A', project.id)
  sids.pinB = await createSession('S-pin-B', project.id)
  sids.stop = await createSession('S-stop', project.id)
  sids.inv = await createSession('S-inv', project.id)
  sids.off = await createSession('S-off', project.id)
  sids.reads = await createSession('S-reads', project.id)
  sids.grants = await createSession('S-grants', project.id)
  sids.parity = await createSession('S-parity', project.id)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes('S-confined'), 'sidebar list refreshed')

  events = eventRecorder(app.main)
  await events.install()
})

afterEach(async () => {
  // E2E-4 会关掉开关；无论成败都还原
  await setSandboxEnabled(app.main, true)
})

afterAll(async () => {
  await provider?.close()
  await app?.stop()
  if (outsideHome) rmSync(outsideHome, { recursive: true, force: true })
  rmSync(tmpProbe, { force: true })
})

describe('E2E-1 受限命令不问就跑', () => {
  it('E2E-1 写工作区 + TMPDIR 指向本会话临时目录；写 ~/.shuvix、写 /private/tmp 都被沙箱拦下并带说明', async (ctx) => {
    if (!(await sandboxAvailable(app.main))) ctx.skip()
    await events.clear()

    await sendTurn(
      'S-confined',
      bashCall('call_in', 'echo SBX > inside.txt && echo "TMP=$TMPDIR"'),
      'write inside'
    )
    await events.waitFor('agent_end', { sessionId: sids.confined })
    await chat.waitIdle()
    expect(await askCount(sids.confined)).toBe(0)
    const inside = await toolEnd(sids.confined, 'call_in')
    expect(inside.isError).toBeFalsy()
    expect(readFileSync(join(projDir, 'inside.txt'), 'utf8').trim()).toBe('SBX')
    expect(String(inside.result)).toMatch(/TMP=\/private\/tmp\/shuvix-\d+\/[0-9a-f]{8}\//)

    // 家目录里、会话目录以外：读写都拦。说明里点名这条路径 —— `touch` 带着写入的迹象，所以说
    // `cannot write`（classify.ts：没有写入迹象时才说 cannot read），整段说明仍是「只能读写工作目录与 $TMPDIR」
    const probe = join(app.home, '.shuvix', 'sbx-probe')
    await sendTurn(
      'S-confined',
      bashCall('call_out', 'touch "$HOME/.shuvix/sbx-probe"'),
      'write outside'
    )
    await events.waitFor('agent_end', { sessionId: sids.confined })
    await chat.waitIdle()
    expect(await askCount(sids.confined)).toBe(0)
    const out = String((await toolEnd(sids.confined, 'call_out')).result)
    expect(out).toContain('[Exit code: 1]')
    expect(out).toContain('[sandbox]')
    expect(out).toContain(`cannot write: ${probe}`)
    expect(out).toContain('dangerouslyDisableSandbox')
    expect(existsSync(probe)).toBe(false)

    // 家目录以外、会话目录以外：/private/tmp 从前是可写根，现在只有本会话的 TMPDIR 写得进
    await sendTurn('S-confined', bashCall('call_tmp', `touch ${tmpProbe}`), 'write to /tmp')
    await events.waitFor('agent_end', { sessionId: sids.confined })
    await chat.waitIdle()
    expect(await askCount(sids.confined)).toBe(0)
    const tmp = String((await toolEnd(sids.confined, 'call_tmp')).result)
    expect(tmp).toContain('[Exit code: 1]')
    expect(tmp).toContain(`cannot write: ${tmpProbe}`)
    expect(tmp).toContain('can read and write only the working directory and $TMPDIR')
    expect(tmp).toContain('dangerouslyDisableSandbox')
    expect(existsSync(tmpProbe)).toBe(false)
  })
})

describe('E2E-2 申请完全访问：要问，卡片带「完全访问」标签', () => {
  it('E2E-2 拒绝 → 没跑；再来一次允许 → 真的不受限（写进了沙箱拦住的 ~/.shuvix）', async (ctx) => {
    if (!(await sandboxAvailable(app.main))) ctx.skip()
    await events.clear()
    const target = join(app.home, '.shuvix', 'full-access-probe')

    await sendTurn(
      'S-full',
      bashCall('call_deny', 'touch "$HOME/.shuvix/full-access-probe"', {
        dangerouslyDisableSandbox: true
      }),
      'full access please'
    )
    const denied = await events.waitFor<InputRequestEvent>('input_request', {
      sessionId: sids.full
    })
    expect(denied.request.unsandboxed).toBe(true)
    await until(() => chat.pendingAskFullAccess(), 'full access badge on the ask card')
    await answer(sids.full, denied.request.id, false)
    await events.waitFor('agent_end', { sessionId: sids.full })
    await chat.waitIdle()
    expect((await toolEnd(sids.full, 'call_deny')).isError).toBe(true)
    expect(existsSync(target)).toBe(false)

    await sendTurn(
      'S-full',
      bashCall('call_allow', 'touch "$HOME/.shuvix/full-access-probe"', {
        dangerouslyDisableSandbox: true
      }),
      'full access again'
    )
    const allowed = await events.waitFor<InputRequestEvent>('input_request', {
      sessionId: sids.full
    })
    expect(allowed.request.unsandboxed).toBe(true)
    await until(() => chat.pendingAskFullAccess(), 'full access badge on the second card')
    await answer(sids.full, allowed.request.id, true)
    await events.waitFor('agent_end', { sessionId: sids.full })
    await chat.waitIdle()
    const end = await toolEnd(sids.full, 'call_allow')
    expect(end.isError).toBeFalsy()
    expect(String(end.result)).not.toContain('[sandbox]')
    expect(existsSync(target)).toBe(true)

    // 工具卡：允许的那条标「完全访问」（escalated），记下的命令没有沙箱包装；拒绝的那条没跑，没有记录
    expect(end.details?.sandbox).toBe('escalated')
    const allowedInvocation = await readInvocation(sids.full, 'call_allow')
    expect(allowedInvocation).toContain('/bin/bash --norc -c ')
    expect(allowedInvocation).not.toContain('sandbox-exec')
    expect(await readInvocation(sids.full, 'call_deny')).toBeNull()
  })
})

describe('E2E-3 文件工具与沙箱同一份会话目录', () => {
  it('E2E-3 工作区里的写（含 .git/hooks）不问、受限命令 git init 并写 hooks；会话目录以外的写要问，允许后写入', async (ctx) => {
    if (!(await sandboxAvailable(app.main))) ctx.skip()
    await events.clear()

    // ① 工作区里：普通文件、git 的 hooks 都不问（.git 元数据不再受保护）；受限命令同样写得进
    const plain = join(projDir, 'a.txt')
    mkdirSync(join(projDir, '.git', 'hooks'), { recursive: true })
    const hook = join(projDir, '.git', 'hooks', 'pre-commit')
    await sendSteps(
      'S-files',
      [
        writeCall('call_plain', plain, 'PLAIN'),
        writeCall('call_hook', hook, '# hook\n'),
        bashCall(
          'call_git',
          "git init -q repo-sbx && printf '#!/bin/sh\\n' > repo-sbx/.git/hooks/post-commit && echo GIT-OK"
        )
      ],
      'write in the workspace'
    )
    await events.waitFor('agent_end', { sessionId: sids.files })
    await chat.waitIdle()
    expect(await askCount(sids.files)).toBe(0)
    expect((await toolEnd(sids.files, 'call_plain')).isError).toBeFalsy()
    expect(readFileSync(plain, 'utf8')).toBe('PLAIN')
    expect((await toolEnd(sids.files, 'call_hook')).isError).toBeFalsy()
    expect(readFileSync(hook, 'utf8')).toBe('# hook\n')
    const git = await toolEnd(sids.files, 'call_git')
    expect(String(git.result)).toContain('GIT-OK')
    expect(String(git.result)).not.toContain('[sandbox]')
    expect(git.details?.sandbox).toBe('confined')
    expect(readFileSync(join(projDir, 'repo-sbx', '.git', 'hooks', 'post-commit'), 'utf8')).toBe(
      '#!/bin/sh\n'
    )

    // ② 会话目录以外：ask-on-external-path 的写规则问；路径询问不是命令，没有「完全访问」这回事
    const outside = join(app.home, 'outside-sbx', 'x.txt')
    await events.clear()
    await sendTurn('S-files', writeCall('call_outside', outside, 'OUT'), 'write outside')
    const ask = await events.waitFor<InputRequestEvent>('input_request', {
      sessionId: sids.files
    })
    expect(ask.request.unsandboxed).toBeFalsy()
    await answer(sids.files, ask.request.id, true)
    await events.waitFor('agent_end', { sessionId: sids.files })
    await chat.waitIdle()
    expect((await toolEnd(sids.files, 'call_outside')).isError).toBeFalsy()
    expect(readFileSync(outside, 'utf8')).toBe('OUT')
    expect(decisionsOf('call_outside')).toEqual([
      expect.objectContaining({
        action: 'write',
        effect: 'ask',
        winning: 'ask-on-external-path#1',
        userResponse: 'allowed'
      })
    ])
  })
})

describe('E2E-4 按会话固定', () => {
  it('E2E-4 中途关掉开关：会话 A 照旧受限不问；新会话 B 的命令逐条询问、卡片没有「完全访问」标签', async (ctx) => {
    if (!(await sandboxAvailable(app.main))) ctx.skip()
    await events.clear()

    await sendTurn('S-pin-A', bashCall('call_a1', 'echo "TMP=$TMPDIR"'), 'first in A')
    await events.waitFor('agent_end', { sessionId: sids.pinA })
    await chat.waitIdle()
    expect(await askCount(sids.pinA)).toBe(0)
    expect(String((await toolEnd(sids.pinA, 'call_a1')).result)).toMatch(
      /TMP=\/private\/tmp\/shuvix-\d+\//
    )

    await setSandboxEnabled(app.main, false)

    await sendTurn('S-pin-A', bashCall('call_a2', 'echo "TMP=$TMPDIR"'), 'second in A')
    await events.waitFor('agent_end', { sessionId: sids.pinA })
    await chat.waitIdle()
    expect(await askCount(sids.pinA)).toBe(0)
    expect(String((await toolEnd(sids.pinA, 'call_a2')).result)).toMatch(
      /TMP=\/private\/tmp\/shuvix-\d+\//
    )

    await sendTurn('S-pin-B', bashCall('call_b1', 'echo "TMP=$TMPDIR"'), 'first in B')
    const ask = await events.waitFor<InputRequestEvent>('input_request', {
      sessionId: sids.pinB
    })
    expect(ask.request.unsandboxed).toBeFalsy()
    await until(async () => (await chat.pendingAskShot()) !== null, 'ask card for B')
    expect(await chat.pendingAskFullAccess()).toBe(false)
    await answer(sids.pinB, ask.request.id, true)
    await events.waitFor('agent_end', { sessionId: sids.pinB })
    await chat.waitIdle()
    const b = String((await toolEnd(sids.pinB, 'call_b1')).result)
    // 不受限：TMPDIR 是宿主自己的，不是沙箱给的本会话临时目录
    expect(b).not.toMatch(/TMP=\/private\/tmp\/shuvix-\d+\/[0-9a-f]{8}\//)
  })
})

describe('E2E-5 受限命令经宿主停本会话的后台任务（shuvix task stop）', () => {
  /** 本会话发给模型的 user 消息里有没有后台任务的退出通知（`<background-task …>`） */
  const noticeSent = (): boolean =>
    provider
      .chatRequests()
      .some((req) =>
        (req.body.messages ?? []).some(
          (m) => m.role === 'user' && JSON.stringify(m.content ?? '').includes('<background-task')
        )
      )

  it('E2E-5 后台起一条 → 前台 shuvix task stop 停掉它（不问、不通知）→ 停一个不存在的 pid 退出 1', async (ctx) => {
    if (!(await sandboxAvailable(app.main))) ctx.skip()
    await events.clear()
    const pidFile = join(projDir, 'bg.pid')

    provider.reset()
    provider.script(
      {
        toolCalls: [
          bashCall('call_bg', 'echo $$ > bg.pid; exec sleep 120', { run_in_background: true })
        ],
        usage: USAGE
      },
      { toolCalls: [bashCall('call_stop', 'shuvix task stop "$(cat bg.pid)"')], usage: USAGE },
      { toolCalls: [bashCall('call_stop_other', 'shuvix task stop 1')], usage: USAGE },
      { text: 'done', usage: USAGE }
    )
    expect(await sidebar.openSession('S-stop')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('start and stop a background task')
    await events.waitFor('agent_end', { sessionId: sids.stop, timeoutMs: 60_000 })
    await chat.waitIdle()

    // 三条命令都在沙箱里，一条都不问
    expect(await askCount(sids.stop)).toBe(0)

    const bg = await toolEnd(sids.stop, 'call_bg')
    expect(bg.isError).toBeFalsy()
    expect(String(bg.result)).toContain('Background task started, pid')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(Number.isInteger(pid) && pid > 0).toBe(true)

    const stop = String((await toolEnd(sids.stop, 'call_stop')).result)
    expect(stop).toContain(`stopping background task ${pid}`)
    expect(stop).not.toContain('[Exit code:')
    expect(stop).not.toContain('[sandbox]')

    const other = String((await toolEnd(sids.stop, 'call_stop_other')).result)
    expect(other).toContain('no background task with pid 1 in this session')
    expect(other).toContain('[Exit code: 1]')

    // 面板上那一行在 10s 内结束，状态是 killed
    await until(
      async () => {
        const tasks = await app.main.eval<Array<{ taskId: string; status: string }>>(
          `window.api.bgTask.list(${JSON.stringify({ sessionId: sids.stop })})`
        )
        return tasks.find((t) => t.taskId === 'call_bg')?.status === 'killed'
      },
      'background task row ends as killed',
      10_000
    )

    // 智能体自己停的：不发退出通知，也不因此自动续一轮
    const requestsAfterTurn = provider.chatRequestCount()
    await new Promise((r) => setTimeout(r, 2500))
    expect(provider.chatRequestCount()).toBe(requestsAfterTurn)
    expect(noticeSent()).toBe(false)
    expect((await sessionEvents(sids.stop)).filter((e) => e.type === 'agent_start')).toHaveLength(1)
  })
})

describe('E2E-6 工具卡上的沙箱标记与「实际执行的命令」', () => {
  it('E2E-6 受限命令：details / 落库都标 confined；IPC 取得到那份命令；卡片展开后标记 + 开关，点开就是那份', async (ctx) => {
    if (!(await sandboxAvailable(app.main))) ctx.skip()
    await events.clear()
    const sid = sids.inv
    const command = `echo "it's $((1+1))" > inv.txt`

    await sendTurn('S-inv', bashCall('call_inv', command), 'record the invocation')
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    expect(await askCount(sid)).toBe(0)
    expect(readFileSync(join(projDir, 'inv.txt'), 'utf8')).toBe("it's 2\n")

    const end = await toolEnd(sid, 'call_inv')
    expect(end.details?.sandbox).toBe('confined')
    expect((await persistedBlock(sid, 'call_inv')).details?.sandbox).toBe('confined')

    const text = await readInvocation(sid, 'call_inv')
    expect(text).not.toBeNull()
    const lines = text!.split('\n')
    expect(lines.pop()).toBe('')
    expect(lines[0]).toMatch(/^cd .* && \\$/)
    expect(lines[0]).toContain(projDir)
    const envLine = new RegExp(
      `^TMPDIR=/private/tmp/shuvix-\\d+/[0-9a-f]{8}/ .*SHUVIX_SESSION_ID=${sid} \\\\$`
    )
    expect(lines.some((l) => envLine.test(l))).toBe(true)
    expect(lines).toContain('/usr/bin/sandbox-exec \\')
    expect(lines.some((l) => l.startsWith("  -p '"))).toBe(true)
    expect(lines.some((l) => l.startsWith('  -D '))).toBe(true)
    // 最后一行是被包的那条 shell 命令，原命令里的单引号写成 '\''
    expect(lines[lines.length - 1]).toBe(
      `  -- /bin/bash --norc -c 'echo "it'\\''s $((1+1))" > inv.txt'`
    )

    // 坏的会话 id / 调用 id 取不到
    expect(await readInvocation('..', 'call_inv')).toBeNull()
    expect(await readInvocation(sid, '../call_inv')).toBeNull()

    // 卡片：折叠时什么都没有，展开才出标记与开关；点开显示的就是 IPC 那份
    expect(await chat.toolRowSandbox(0)).toBeNull()
    expect(await chat.toolRowHasInvocationToggle(0)).toBe(false)
    await chat.setToolRowExpanded(0, true)
    expect(await chat.toolRowSandbox(0)).toBe('confined')
    expect(await chat.toolRowHasInvocationToggle(0)).toBe(true)
    expect(await chat.openToolRowInvocation(0)).toBe(text)

    // 切走再切回：从落库的 details 重画，标记照旧
    expect(await sidebar.openSession('S-confined')).toBe(true)
    await chat.ready()
    expect(await sidebar.openSession('S-inv')).toBe(true)
    await chat.ready()
    await until(async () => (await chat.toolRows()).length === 1, 'S-inv tool row back')
    await chat.setToolRowExpanded(0, true)
    expect(await chat.toolRowSandbox(0)).toBe('confined')
  })
})

describe('E2E-7 沙箱关着 + 一条没跑起来的命令', () => {
  it('E2E-7 拒绝的那条：没有记录、落库块没有标记；允许的那条：标 disabled，记录是裸的 /bin/bash', async () => {
    // 在这条会话的第一条消息之前关掉：沙箱按会话固定
    await setSandboxEnabled(app.main, false)
    await events.clear()
    const sid = sids.off
    const status = await app.main.eval<{ supported: boolean }>(
      `window.api.settings.sandboxStatus()`
    )
    const expected = status.supported ? 'disabled' : 'unsupported'

    // 第一轮：询问 → 拒绝
    await sendTurn('S-off', bashCall('call_off_deny', 'echo off'), 'deny this one')
    const denied = await events.waitFor<InputRequestEvent>('input_request', { sessionId: sid })
    await answer(sid, denied.request.id, false)
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    expect((await toolEnd(sid, 'call_off_deny')).isError).toBe(true)
    expect(await readInvocation(sid, 'call_off_deny')).toBeNull()
    expect((await persistedBlock(sid, 'call_off_deny')).details?.sandbox).toBeUndefined()

    // 第二轮：询问 → 允许
    await events.clear()
    await sendTurn('S-off', bashCall('call_off', 'echo off'), 'allow this one')
    const allowed = await events.waitFor<InputRequestEvent>('input_request', { sessionId: sid })
    await answer(sid, allowed.request.id, true)
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    const end = await toolEnd(sid, 'call_off')
    expect(end.isError).toBeFalsy()
    expect(end.details?.sandbox).toBe(expected)
    expect((await persistedBlock(sid, 'call_off')).details?.sandbox).toBe(expected)

    const text = await readInvocation(sid, 'call_off')
    expect(text).not.toBeNull()
    const lines = text!.split('\n')
    expect(lines).toContain("/bin/bash --norc -c 'echo off'")
    expect(text).not.toContain('sandbox-exec')
    expect(text).not.toContain('TMPDIR=')
    expect(text).toContain(`SHUVIX_SESSION_ID=${sid}`)

    // 卡片：拒绝的那行（0）展开也没有标记和开关；允许的那行（1）标 disabled，点开就是 IPC 那份
    await until(async () => (await chat.toolRows()).length === 2, 'two tool rows in S-off')
    await chat.setToolRowExpanded(0, true)
    expect(await chat.toolRowSandbox(0)).toBeNull()
    expect(await chat.toolRowHasInvocationToggle(0)).toBe(false)
    await chat.setToolRowExpanded(1, true)
    expect(await chat.toolRowSandbox(1)).toBe(expected)
    expect(await chat.openToolRowInvocation(1)).toBe(text)
  })
})

describe('E2E-8 读的那一面：家目录里只有会话目录读得到', () => {
  it('E2E-8 受限命令读 ~/Downloads、~/.ssh、~/.shuvix/.session-state 一律被拒并说明，读家目录以外照常；read 工具读家目录以外不问、读 ~/.ssh 要问', async (ctx) => {
    if (!(await sandboxAvailable(app.main))) ctx.skip()
    await events.clear()
    const sid = sids.reads
    const note = join(app.home, 'Downloads', 'note.txt')
    const key = join(app.home, '.ssh', 'id_e2e')
    const state = join(app.home, '.shuvix', '.session-state')
    const world = join(outsideHome, 'world.txt')
    mkdirSync(dirname(note), { recursive: true })
    writeFileSync(note, 'NOTE-E2E\n')
    mkdirSync(dirname(key), { recursive: true })
    writeFileSync(key, 'KEY-E2E\n')
    // 加密 API key 用的密钥：seedFakeProvider 存了一个 key，它必然已经在了
    expect(existsSync(state)).toBe(true)

    await sendSteps(
      'S-reads',
      [
        bashCall('call_note', 'cat "$HOME/Downloads/note.txt"'),
        bashCall('call_key', 'cat "$HOME/.ssh/id_e2e"'),
        bashCall('call_state', 'wc -c "$HOME/.shuvix/.session-state"'),
        bashCall('call_world', `cat ${world}`),
        readCall('call_read_world', world)
      ],
      'read around'
    )
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    expect(await askCount(sid)).toBe(0)

    // 家目录里、会话目录以外：普通文件与凭据一个待遇（凭据不再有自己的清单）
    for (const [id, path, mark] of [
      ['call_note', note, 'NOTE-E2E'],
      ['call_key', key, 'KEY-E2E'],
      ['call_state', state, null]
    ] as const) {
      const out = String((await toolEnd(sid, id)).result)
      expect(out, id).toContain('[Exit code: 1]')
      expect(out, id).toContain(`cannot read: ${path}`)
      if (mark) expect(out, id).not.toContain(mark)
    }

    // 家目录以外：受限命令照读，read 工具也不问
    const worldOut = String((await toolEnd(sid, 'call_world')).result)
    expect(worldOut).toContain('WORLD-E2E')
    expect(worldOut).not.toContain('[sandbox]')
    const readWorld = await toolEnd(sid, 'call_read_world')
    expect(readWorld.isError).toBeFalsy()
    expect(String(readWorld.result)).toContain('WORLD-E2E')

    // read 工具读 ~/.ssh：家目录里、会话目录以外 → ask-on-external-path 的读规则问（拒绝 → 没读到）
    await events.clear()
    await sendTurn('S-reads', readCall('call_read_key', key), 'read the key')
    const ask = await events.waitFor<InputRequestEvent>('input_request', { sessionId: sid })
    expect(ask.request.unsandboxed).toBeFalsy()
    await answer(sid, ask.request.id, false)
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    const readKey = await toolEnd(sid, 'call_read_key')
    expect(readKey.isError).toBe(true)
    expect(String(readKey.result)).not.toContain('KEY-E2E')
    expect(decisionsOf('call_read_key')).toEqual([
      expect.objectContaining({
        action: 'read',
        effect: 'ask',
        winning: 'ask-on-external-path#0',
        userResponse: 'denied'
      })
    ])
  })
})

describe('E2E-9 「允许并记住」两面生效', () => {
  it('E2E-9 read 工具上记住 ~/.aws/credentials → 下一条受限命令读得到、read 不再问；write 工具上记住一处写 → 受限命令写得进；撤掉读授权 → 又读不到', async (ctx) => {
    if (!(await sandboxAvailable(app.main))) ctx.skip()
    await events.clear()
    const sid = sids.grants
    const aws = join(app.home, '.aws', 'credentials')
    const out = join(app.home, 'granted-out', 'w.txt')
    mkdirSync(dirname(aws), { recursive: true })
    writeFileSync(aws, 'AWS-E2E\n')
    mkdirSync(dirname(out), { recursive: true })

    // ① 没有授权：受限命令读不到
    await sendTurn('S-grants', bashCall('call_aws_1', 'cat "$HOME/.aws/credentials"'), 'aws 1')
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    const before = String((await toolEnd(sid, 'call_aws_1')).result)
    expect(before).toContain('[Exit code: 1]')
    expect(before).toContain(`cannot read: ${aws}`)

    // ② read 工具读它 → 问 → 允许并记住：会话里多一条 Read(…)
    await events.clear()
    await sendTurn('S-grants', readCall('call_read_aws', aws), 'read aws')
    const readAsk = await events.waitFor<InputRequestEvent>('input_request', { sessionId: sid })
    await answer(sid, readAsk.request.id, true, true)
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    expect(String((await toolEnd(sid, 'call_read_aws')).result)).toContain('AWS-E2E')
    expect(await allowList(sid)).toContain(`Read(${aws})`)

    // ③ write 工具写会话目录以外 → 问 → 允许并记住：多一条 Write(…)
    await events.clear()
    await sendTurn('S-grants', writeCall('call_write_out', out, 'W1\n'), 'write out')
    const writeAsk = await events.waitFor<InputRequestEvent>('input_request', { sessionId: sid })
    await answer(sid, writeAsk.request.id, true, true)
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    expect(readFileSync(out, 'utf8')).toBe('W1\n')
    expect(await allowList(sid)).toContain(`Write(${out})`)

    // ④ 同一会话：受限命令读得到、写得进；read 工具不再问
    await events.clear()
    await sendSteps(
      'S-grants',
      [
        bashCall('call_aws_2', 'cat "$HOME/.aws/credentials"'),
        bashCall('call_append', `echo W2 >> ${out}`),
        readCall('call_read_aws_2', aws)
      ],
      'aws 2'
    )
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    expect(await askCount(sid)).toBe(0)
    const after = String((await toolEnd(sid, 'call_aws_2')).result)
    expect(after).toContain('AWS-E2E')
    expect(after).not.toContain('[sandbox]')
    const append = await toolEnd(sid, 'call_append')
    expect(String(append.result)).not.toContain('[Exit code:')
    expect(append.details?.sandbox).toBe('confined')
    expect(readFileSync(out, 'utf8')).toBe('W1\nW2\n')
    expect(String((await toolEnd(sid, 'call_read_aws_2')).result)).toContain('AWS-E2E')

    // ⑤ 在会话配置里撤掉读授权：同一会话，下一条命令又读不到（授权按命令现读）
    await app.main.eval(
      `window.api.session.removeAllowListEntry(${JSON.stringify({ id: sid, entry: `Read(${aws})` })})`
    )
    expect(await allowList(sid)).not.toContain(`Read(${aws})`)
    await events.clear()
    await sendTurn('S-grants', bashCall('call_aws_3', 'cat "$HOME/.aws/credentials"'), 'aws 3')
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    const reverted = String((await toolEnd(sid, 'call_aws_3')).result)
    expect(reverted).toContain('[Exit code: 1]')
    expect(reverted).toContain(`cannot read: ${aws}`)
    expect(await askCount(sid)).toBe(0)
  })
})

describe('E2E-10 写的范围两面一致：项目根里别家工具的配置不受保护', () => {
  it('E2E-10 write 工具写 .vscode/settings.json 不问；受限命令写 .envrc / .claude/settings.json / .mcp.json 退出 0、不问', async (ctx) => {
    if (!(await sandboxAvailable(app.main))) ctx.skip()
    await events.clear()
    const sid = sids.parity
    const vscode = join(projDir, '.vscode', 'settings.json')

    await sendSteps(
      'S-parity',
      [
        writeCall('call_vscode', vscode, '{"e2e": true}\n'),
        bashCall(
          'call_rootcfg',
          'printf x > .envrc && mkdir -p .claude && printf y > .claude/settings.json && printf z > .mcp.json'
        )
      ],
      'touch other tools config'
    )
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()
    expect(await askCount(sid)).toBe(0)

    expect((await toolEnd(sid, 'call_vscode')).isError).toBeFalsy()
    expect(readFileSync(vscode, 'utf8')).toBe('{"e2e": true}\n')

    const bash = await toolEnd(sid, 'call_rootcfg')
    expect(bash.isError).toBeFalsy()
    expect(String(bash.result)).not.toContain('[Exit code:')
    expect(String(bash.result)).not.toContain('[sandbox]')
    expect(bash.details?.sandbox).toBe('confined')
    expect(readFileSync(join(projDir, '.envrc'), 'utf8')).toBe('x')
    expect(readFileSync(join(projDir, '.claude', 'settings.json'), 'utf8')).toBe('y')
    expect(readFileSync(join(projDir, '.mcp.json'), 'utf8')).toBe('z')
  })
})
