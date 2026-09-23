/**
 * md 窗口里的 Agent —— 没有主窗口时，一轮对话从输入卡片发出、在卡片的抽屉里收场。
 *
 * 契约：
 *   - 发送走普通 agent.prompt 管线，根 Agent 是 coedit 档案（协作编辑），工作目录是文件所在目录；
 *     工具表**恰好**是 coedit 的那一份：doc_read / doc_edit / doc_insert 改这份活文档，read / ls / grep /
 *     glob 看邻居，ask 问用户，skill 装绘图技能 —— 没有 write / edit / bash，也不派活、不开子会话；
 *     会话标题一开始就是文件名（不是缺省标题），所以自动起标题那条 hook 不跑 —— 不多花一次请求；
 *   - 改文档经 doc_edit 在编辑器缓冲上当场执行：不问（改动就在用户眼前落下），编辑器先变，自动保存再写盘；
 *   - 读文件照常过安全策略：在工作目录里读不问、读工作目录之外的问；询问卡片出现在**这个窗口**里
 *     （事件经它自己的前端绑定送达，主窗口根本没开）；
 *   - 关窗 = 删会话：跑到一半的一轮被中止（模型那边看得到连接断开）；doc_edit 正在等用户停手、或者
 *     挂着一张 ask 卡片时关窗，删除都在有限时间内完成 —— 等窗口答复的请求随关窗立刻失败，不等超时。
 *
 * 模型是脚本化的假提供商（先种好再带着 md 启动，见 markdownFixtures）；「问了没有、谁赢了、用户怎么答的」
 * 读主进程日志里的安全决策（securityDecisions），不读随界面语言变的卡片文案。
 *
 *   AG-1 输入卡片发一句 → 回复出现在抽屉里；请求里的系统提示词带着工作目录与 a.md，工具表恰好是 coedit 的；
 *        一轮之后标题还是 a.md，没有任何起标题的请求
 *   AG-2 脚本化 doc_edit a.md → 不问；编辑器里先出现，自动保存再写到盘上（AG-3 读到的就是它）
 *   AG-3 read a.md 不问；read ../outside.txt 问（拒绝之后这一轮照常收场）
 *   AG-4 跑到一半关窗（假提供商挂住）→ 模型那边看到中止、会话在有限时间内删掉；
 *        doc_edit 正等用户停手时关窗 → 删除在有限时间内完成、没有「请求超时」、修改没落到文件上；
 *        挂着 ask 卡片时关窗 → 同样在有限时间内删掉，文件没被写
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import type { E2EMarkdownApp } from '../../harness/launch'
import {
  captureEvents,
  launchMarkdownWithProvider,
  logLines,
  userDir,
  type UserDir
} from '../../harness/markdownFixtures'
import { markdownWindowPane, type MarkdownWindowPane } from '../../harness/pages'
import { securityDecisions, waitFileWritten } from '../../harness/seed'
import type { FakeProvider, FakeRequest } from '../../harness/fakeProvider'

let app: E2EMarkdownApp
let provider: FakeProvider
let files: UserDir
let docs: string
type Doc = 'a' | 'b' | 'c' | 'd'
const paths = { a: '', b: '', c: '', d: '', outside: '' }
const sids = { a: '', b: '', c: '', d: '' }
const clients: Partial<Record<Doc, CdpClient>> = {}
const panes: Partial<Record<Doc, MarkdownWindowPane>> = {}

const USAGE = { prompt: 120, completion: 12 }

beforeAll(async () => {
  files = userDir()
  paths.a = files.file('docs/a.md', '# Doc A\n\nalpha body\n\ntail line\n')
  paths.b = files.file('docs/b.md', '# Doc B\n\nbravo body\n')
  paths.c = files.file('docs/c.md', '# Doc C\n\ncharlie body\n')
  paths.d = files.file('docs/d.md', '# Doc D\n\ndelta body\n')
  paths.outside = files.file('outside.txt', 'outside the working directory\n')
  docs = join(files.root, 'docs')
  ;({ app, provider } = await launchMarkdownWithProvider({
    args: [paths.a, paths.b, paths.c, paths.d],
    markdownWindows: 4
  }))
  const windows = await app.markdownWindows()
  for (const key of ['a', 'b', 'c', 'd'] as const) {
    sids[key] = windows.find((w) => w.path === paths[key])!.sessionId
    clients[key] = await until(
      () => app.connectMarkdownWindow(`/docs/${key}.md`),
      `${key}.md window connected`
    )
    panes[key] = markdownWindowPane(clients[key]!)
    await panes[key]!.ready()
  }
}, 240_000)

afterAll(async () => {
  for (const c of Object.values(clients)) c?.close()
  await app?.stop()
  await provider?.close()
  files?.remove()
})

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => ((c as { type?: string }).type === 'text' ? (c as { text: string }).text : ''))
    .join('')
}
const systemOf = (req: FakeRequest): string =>
  contentText(
    (req.body.messages ?? []).find((m) => m.role === 'system' || m.role === 'developer')?.content
  )
const toolNamesOf = (req: FakeRequest): string[] =>
  (req.body.tools ?? []).map((t) => (t as { function: { name: string } }).function.name)

const sessionTitle = (sid: string): Promise<string | null> =>
  clients.a!.eval<string | null>(
    `window.api.session.getById(${JSON.stringify(sid)}).then((s) => s ? s.title : null)`
  )

const decisionsOf = (toolCallId: string): ReturnType<typeof securityDecisions> =>
  securityDecisions(app).filter((d) => d.toolCallId === toolCallId)

describe('md 窗口里的一轮对话', () => {
  it('AG-1 输入卡片发出 → 抽屉里收到回复；coedit 档案 + 工作目录；不起标题', async () => {
    provider.reset()
    provider.script({ text: 'ag1-reply from the model', usage: USAGE })
    await panes.a!.send('ag1: what is in this note?')
    await panes.a!.waitDrawerText('ag1-reply from the model', 30_000)

    const [req] = provider.chatRequests()
    expect(req.lastUserText).toContain('ag1: what is in this note?')
    const system = systemOf(req)
    expect(system).toContain(docs)
    expect(system).toContain('a.md')
    expect(system).toContain('Open document: a.md')
    // 工具表恰好是 coedit 的那一份（skill:builtin:drawing 落成 skill 工具）
    const tools = toolNamesOf(req)
    expect([...tools].sort()).toEqual(
      ['ask', 'doc_edit', 'doc_insert', 'doc_read', 'glob', 'grep', 'ls', 'read', 'skill'].sort()
    )
    for (const absent of ['write', 'edit', 'bash', 'agent', 'session']) {
      expect(tools, absent).not.toContain(absent)
    }

    // 给自动起标题留足时间：它若要跑，是在这一轮结束之后
    await sleep(2500)
    expect(provider.requests()).toHaveLength(1)
    expect(provider.requests().some((r) => r.raw.includes('<hook_event'))).toBe(false)
    expect(await sessionTitle(sids.a)).toBe('a.md')
  })

  it('AG-2 doc_edit a.md → 不问；编辑器里先出现，自动保存再写到盘上', async () => {
    const before = readFileSync(paths.a, 'utf8')
    provider.reset()
    provider.script(
      {
        toolCalls: [
          {
            id: 'ag2_edit',
            name: 'doc_edit',
            args: JSON.stringify({ find: 'alpha body', replace: 'alpha EDITED-AG2' })
          }
        ],
        usage: USAGE
      },
      { text: 'ag2-done', usage: USAGE }
    )
    await panes.a!.send('ag2: please edit the note')

    await panes.a!.waitEditorText('alpha EDITED-AG2')
    const after = await waitFileWritten(paths.a, before, 'a.md autosaved after the agent edit')
    expect(after).toBe(before.replace('alpha body', 'alpha EDITED-AG2'))
    await panes.a!.waitDrawerText('ag2-done', 30_000)

    // 没有询问：改动就在用户眼前落下
    expect(await panes.a!.pendingAsk()).toBeNull()
    expect(decisionsOf('ag2_edit').some((d) => d.effect === 'ask')).toBe(false)
    // 模型拿到的是「改好了」，不是错误
    const result = JSON.stringify(provider.chatRequests()[1]?.body.messages ?? [])
    expect(result).toContain('Replaced at line 3')
  })

  it('AG-3 read a.md 不问；read ../outside.txt 问（拒绝后这一轮照常收场）', async () => {
    provider.reset()
    provider.script(
      {
        toolCalls: [{ id: 'ag3_read_in', name: 'read', args: JSON.stringify({ path: 'a.md' }) }],
        usage: USAGE
      },
      {
        toolCalls: [
          { id: 'ag3_read_out', name: 'read', args: JSON.stringify({ path: '../outside.txt' }) }
        ],
        usage: USAGE
      },
      { text: 'ag3-done', usage: USAGE }
    )
    await panes.a!.send('ag3: read around')

    const ask = await panes.a!.waitAsk(30_000)
    expect(ask.preview).toContain(paths.outside)
    // 读工作目录里的那一次早已放行，没有问过
    const inside = decisionsOf('ag3_read_in')
    expect(inside.length).toBeGreaterThan(0)
    expect(inside.every((d) => d.effect === 'allow')).toBe(true)
    // 第二次请求里带着 a.md 的内容（那一次读真的发生了）
    expect(provider.chatRequests()[1]?.raw).toContain('EDITED-AG2')

    await panes.a!.deny()
    await panes.a!.waitDrawerText('ag3-done', 30_000)
    const outside = decisionsOf('ag3_read_out')
    expect(outside.some((d) => d.effect === 'ask' && d.winning.startsWith('ask-on-read'))).toBe(
      true
    )
    expect(outside.some((d) => d.userResponse === 'denied')).toBe(true)
    // 拒绝了就没读：第三次请求里没有外面那份文件的内容
    expect(provider.chatRequests()[2]?.raw).not.toContain('outside the working directory')
  })
})

describe('关窗 = 删会话', () => {
  it('AG-4 跑到一半关窗 → 模型那边看到中止，会话在有限时间内删掉', async () => {
    provider.reset()
    provider.script({ text: 'ag4 partial…', holdMs: 60_000, usage: USAGE })
    await panes.b!.send('ag4: long running')
    await until(() => provider.chatRequests().length === 1, 'b.md request reached the model')
    await sleep(300)

    const t0 = Date.now()
    await clients.b!.eval('window.close()').catch(() => undefined)
    await until(() => provider.chatRequests()[0].aborted, 'the model saw the abort', 15_000)
    await until(
      () => logLines(app.mainLog(), `内存会话已删除 session=${sids.b}`).length === 1,
      'b.md session deleted',
      15_000
    )
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(await sessionTitle(sids.b)).toBeNull()
    expect(readFileSync(paths.b, 'utf8')).toBe('# Doc B\n\nbravo body\n')
    // 别的窗口不受影响
    expect((await app.markdownWindows()).map((w) => w.path).sort()).toEqual(
      [paths.a, paths.c, paths.d].sort()
    )
  })

  it('AG-4 doc_edit 正等用户停手时关窗 → 删除在有限时间内完成，没有请求超时，修改没落到文件上', async () => {
    provider.reset()
    const ev = await captureEvents(clients.c!, sids.c)
    // 用户一直在目标那一行打字：修改到了要等他停手（最多 10s）
    const typing = panes.c!.keepTyping('charlie body', 8000).catch(() => undefined)
    await sleep(400)
    provider.script(
      {
        toolCalls: [
          {
            id: 'ag4_wait',
            name: 'doc_edit',
            args: JSON.stringify({ find: 'charlie', replace: 'NEVER-AG4' })
          }
        ],
        usage: USAGE
      },
      { text: 'never reached', usage: USAGE }
    )
    await clients.c!.eval(
      `(window.api.agent.prompt({ sessionId: ${JSON.stringify(sids.c)}, text: 'ag4: edit while I type' }).catch(() => undefined), true)`
    )
    await ev.waitFor(
      (e) => e.type === 'tool_start' && e.toolCallId === 'ag4_wait',
      'doc_edit started (waiting for the user)'
    )
    await until(
      async () => (await panes.c!.ghosts()).some((g) => g.mode === 'waiting'),
      'waiting ghost on screen'
    )

    const t0 = Date.now()
    await clients.c!.eval('window.close()').catch(() => undefined)
    await until(
      () => logLines(app.mainLog(), `内存会话已删除 session=${sids.c}`).length === 1,
      'c.md session deleted while a doc_edit waited',
      15_000
    )
    expect(Date.now() - t0).toBeLessThan(15_000)
    await typing
    expect(await sessionTitle(sids.c)).toBeNull()
    // 等窗口答复的请求随关窗立刻失败 —— 桥的超时一次都没走到
    expect(logLines(app.mainLog(), '请求超时')).toEqual([])
    await sleep(500)
    expect(readFileSync(paths.c, 'utf8')).not.toContain('NEVER-AG4')
    expect((await app.markdownWindows()).map((w) => w.path).sort()).toEqual(
      [paths.a, paths.d].sort()
    )
  })

  it('AG-4 挂着 ask 卡片时关窗 → 删除照样在有限时间内完成，文件没被写', async () => {
    const before = readFileSync(paths.d, 'utf8')
    provider.reset()
    const ev = await captureEvents(clients.d!, sids.d)
    provider.script(
      {
        toolCalls: [
          {
            id: 'ag4_ask',
            name: 'ask',
            args: JSON.stringify({
              question: 'Which tone?',
              options: [
                { label: 'Formal', description: 'Keep it formal' },
                { label: 'Casual', description: 'Loosen it up' }
              ]
            })
          }
        ],
        usage: USAGE
      },
      { text: 'never reached', usage: USAGE }
    )
    await panes.d!.send('ag4: ask me something')
    await ev.waitFor((e) => e.type === 'input_request', 'ask card pending', 30_000)

    const t0 = Date.now()
    await clients.d!.eval('window.close()').catch(() => undefined)
    await until(
      () => logLines(app.mainLog(), `内存会话已删除 session=${sids.d}`).length === 1,
      'd.md session deleted with an ask card pending',
      15_000
    )
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(await sessionTitle(sids.d)).toBeNull()
    await sleep(500)
    expect(readFileSync(paths.d, 'utf8')).toBe(before)
    // 询问没被当成回答了：第二次请求（工具结果回给模型）根本没发出去
    expect(provider.chatRequests().length).toBeLessThanOrEqual(1)
    expect((await app.markdownWindows()).map((w) => w.path)).toEqual([paths.a])
  })
})
