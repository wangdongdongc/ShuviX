/**
 * 命令沙箱（macOS Seatbelt）在真实实例里的四件事：
 *
 *  - E2E-1 受限命令不问就跑：能写工作区、TMPDIR 指向本会话临时目录；被沙箱拦下的写入
 *    在结果里带一段 `[sandbox]` 说明（点名路径、教模型用 dangerouslyDisableSandbox）；
 *  - E2E-2 申请完全访问的命令要问、卡片上有「完全访问」标签；拒绝 → 没跑；允许 → 真的不受限；
 *  - E2E-3 文件工具跟着沙箱走：工作区里的写不问，工作区顶层的 .vscode 照问；
 *  - E2E-4 按会话固定：会话中途关掉开关，已在跑的会话照旧受限；新会话按新值（逐条询问、无标签）；
 *  - E2E-5（FU-8）受限命令停本会话的后台任务：`shuvix task stop <pid>` 整条链路在沙箱里走得通
 *    （读 cli-token、连 cli.sock、Electron 以 node 模式起）；停了不回头通知；别的 pid 找不到、退出 1；
 *  - E2E-6 工具卡上的沙箱标记与「实际执行的命令」：受限命令的 details / 落库块都标 confined；宿主记下的
 *    那份命令（sandbox-exec 包装、TMPDIR 等变量、会话 id、原命令）经 IPC 取得到、坏的会话 id / 调用 id
 *    取不到；卡片展开后才出标记与开关，点开显示的就是 IPC 那份；切走再切回照旧；
 *  - E2E-7 沙箱关着 + 一条没跑起来的命令：拒绝的那条没有记录、落库块没有标记；允许的那条标 disabled，
 *    记录里是裸的 `/bin/bash --norc -c …`（没有 sandbox-exec、没有 TMPDIR）。
 *
 * 每个用例先看沙箱在这个实例里能不能用（整组测试本身跑在别的沙箱里时 sandbox-exec 嵌套失败），
 * 不能用就 skip。注意 fake HOME 在 /private/tmp 下 —— 它本身是可写根：必须被拒的目标只能挑
 * `~/.shuvix/…` / userData，不能随便挑家目录里的文件。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  sandboxAvailable,
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

async function answer(sid: string, requestId: string, allowed: boolean): Promise<void> {
  await app.main.eval(
    `window.api.agent.respondToInput(${JSON.stringify({
      sessionId: sid,
      requestId,
      response: { kind: 'ask', allowed }
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
  const project = await createProject(app.main, { name: 'SandboxProj', path: projDir })

  sids.confined = await createSession('S-confined', project.id)
  sids.full = await createSession('S-full', project.id)
  sids.files = await createSession('S-files', project.id)
  sids.pinA = await createSession('S-pin-A', project.id)
  sids.pinB = await createSession('S-pin-B', project.id)
  sids.stop = await createSession('S-stop', project.id)
  sids.inv = await createSession('S-inv', project.id)
  sids.off = await createSession('S-off', project.id)

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
})

describe('E2E-1 受限命令不问就跑', () => {
  it('E2E-1 写工作区 + TMPDIR 指向本会话临时目录；写 ~/.shuvix 被沙箱拦下并带说明', async (ctx) => {
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

describe('E2E-3 文件工具跟着沙箱走', () => {
  it('E2E-3 工作区里的写不问；工作区顶层的 .vscode 照问，允许后写入', async (ctx) => {
    if (!(await sandboxAvailable(app.main))) ctx.skip()
    await events.clear()

    const plain = join(projDir, 'a.txt')
    await sendTurn('S-files', writeCall('call_plain', plain, 'PLAIN'), 'write a')
    await events.waitFor('agent_end', { sessionId: sids.files })
    await chat.waitIdle()
    expect(await askCount(sids.files)).toBe(0)
    expect((await toolEnd(sids.files, 'call_plain')).isError).toBeFalsy()
    expect(readFileSync(plain, 'utf8')).toBe('PLAIN')

    mkdirSync(join(projDir, '.vscode'), { recursive: true })
    const guarded = join(projDir, '.vscode', 'settings.json')
    await sendTurn('S-files', writeCall('call_vscode', guarded, '{"x":1}'), 'write settings')
    const ask = await events.waitFor<InputRequestEvent>('input_request', {
      sessionId: sids.files
    })
    // 路径询问不是命令，没有「完全访问」这回事
    expect(ask.request.unsandboxed).toBeFalsy()
    await answer(sids.files, ask.request.id, true)
    await events.waitFor('agent_end', { sessionId: sids.files })
    await chat.waitIdle()
    expect((await toolEnd(sids.files, 'call_vscode')).isError).toBeFalsy()
    expect(readFileSync(guarded, 'utf8')).toBe('{"x":1}')
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
