/**
 * md 窗口里的协作编辑 —— agent 与用户同时改一份活文档。
 *
 * 契约（chat-protocol liveDocument.ts / desktop tools/doc.ts / renderer components/notebook/coEdit/）：
 *   - 窗口开着时，**编辑器缓冲是事实源**：doc_read 读的是它（含没存盘的输入），并附上「用户在哪」
 *     （光标行与所在标题 —— 代码围栏里的 `#` 不算标题 —— 选区、屏幕上的行、多久没打字）与「自上次读以来
 *     用户改了什么」（首次读没有；agent 自己的修改永不算用户的，哪怕它改的是用户后来加的字）；
 *   - doc_edit / doc_insert 在缓冲上当场执行：按原文定位（必须恰好一处）、一次落下、不进用户的撤销栈、
 *     不重挂载编辑器、光标跟着映射，由自动保存写盘，不经安全询问；失败的调用是红的，缓冲与文件不动；
 *     结果报「新内容从第几行开始」（插入跳过开头的换行），附近几行从锚点的上一行起；
 *   - 参数还在生成时就有**虚影**：定位原文到齐且唯一才画（目标被标出，新内容一边写一边长），虚影不是文档
 *     （不改文本、不存盘、不进 ⌘Z）；调用执行时收掉，中止时也收掉；
 *   - 用户正在那一段（光标在目标行 ±1 行、1.5s 内打过字，或输入法组字中）就**等他停手**（虚影变「等你」），
 *     最多等 10s；等的期间原文被他改掉 → 失败（does not match）；
 *   - 改动痕迹：看见之后才淡出（约 2.6s 后移除），屏幕外的一直亮着，由指路条指路（只数 agent 的改动，
 *     不自动滚动，点它才滚过去）；纯删除留一道竖线；虚影在屏幕外时指路条说「正在下方改」；读的时候一闪「正在读」；
 *   - 同一条消息里的几次调用逐个执行；
 *   - 别的程序写了盘：三方合并进缓冲（不重挂载、不进 ⌘Z、留 external 痕迹但不算进指路条、不回写成循环）；
 *     用户没存盘的输入不丢、不重复；退回到我们更早存过的版本也照样并进来。
 *
 * 一个实例、五个窗口：short.md（大多数用例）、long.md（300 行，屏幕外的改动）、ghost.md（虚影用例 ——
 * 用户从不在里面打字，撤销栈是空的）、ext.md（外部写盘）、ro/mc1.md（自己的目录，可设成只读让自动保存失败）。
 * 界面语言钉成 en（指路条按字面断言）。「问了没有」读主进程日志的安全决策；工具结果读下一次请求里
 * 模型真正看到的那条 tool 消息；工具的起止与 run 的结束读 md 窗口里记下的 ChatEvent（captureEvents）。
 *
 *   MC1  doc_read 读的是活缓冲：自动保存失败时照样读到刚打的字（盘上没有）；新开的窗口说「没打过字」
 *   MC1b 自动保存失败之后，目录恢复可写、在别处再打一个字 → 两处输入都在（失败的保存不能让自己的字被当成外部改动退回去）
 *   MC2  用户上下文：光标在 `## Two` 下（围栏里的 `#` 不算）、选区、屏幕上的行；首次读没有 diff；>600 字的选区截断加「…」
 *   MC3  第二次读的 diff 只有用户的输入，没有 agent 的修改；agent 改掉用户上次读后才加的字，也不算用户改的
 *   MC4  doc_edit：编辑器里出现、自动保存写盘、没有询问、结果带行号上下文、不重挂载、不滚动、痕迹盖住新字
 *   MC5  撤销分开：U0、agent 改、U1；⌘Z×2 依次撤掉 U1、U0，agent 的字还在；⌘⇧Z 把 U0 恢复
 *   MC6  光标在目标之后：多行修改落下后接着打字，字落在原来的光标处
 *   MC7  失败（0 处 / 2 处 / 两个锚点）→ 红的（message.list isError），下一次请求带着错误，缓冲与文件不动
 *   MC8  doc_insert after / before / 文末 → 落点对，报的行 = 新内容的第一行，上下文从锚点的上一行起
 *   MC9  流式 doc_edit 的虚影：find 没到齐不画；到齐后目标 = find、模式 rewriting、新内容逐片变长；
 *        期间缓冲 / 文件不动（过了自动保存的延迟也不动），⌘Z 碰不到它；放行后虚影与目标消失，新字 + 痕迹在
 *   MC10 find 不唯一 / 不存在 → 不画虚影（执行时失败）
 *   MC11 doc_insert 的虚影：模式 writing，挂在 after 那行之下 / before 那行之上 / 文末
 *   MC12 虚影挂着时中止 → 虚影消失，缓冲不动
 *   MC13 等用户停手：在目标行末一直打字时修改到达 → 虚影「等你」、缓冲不变；停手后约 1.5s 落下，结果说等了多久，用户的字都在
 *   MC14 等的期间用户改掉了原文 → 失败 does not match，红的
 *   MC15 一直打字超过 10s → 约 10s 时照样落下
 *   MC16 光标隔两行 → 不等；紧挨着的一行 → 等；输入法组字中也等
 *   MC17 一条消息里 doc_edit A→B 再 doc_insert after B → 都成功（逐个执行）
 *   MC18 痕迹与指路条：屏幕上的改动淡出后移除；屏幕外的 3s 后仍亮着、指路条「changed 1 place below」、
 *        不自动滚动；点它 → 滚过去、开始淡出、指路条消失；两处 → 「2 places」；replace 为空 → 删除竖线
 *   MC19 虚影在屏幕外 → 「working below」，落下后 → 「changed 1 place below」；doc_read 时一闪「reading」
 *   MC20 toolcall_generating 的 toolCallId 与 tool_start 的是同一个
 *   EX1  没有本地改动时外部写盘 → 并进来（不重挂载）、external 痕迹、不进指路条、⌘Z 撤不掉、之后不再反复写盘
 *   EX2  一直在打字时别的程序改了另一段 → 最后缓冲与文件两边都有
 *   EX3  单纯打字永远不出 external 痕迹、不重复
 *   EX4  打一个字、20ms 内别的程序改了另一段 → 文件最后两边都有
 *   EX5  外部写下的内容与缓冲一样 → 不重复
 *   EX6  外部把文件退回到我们更早存过的版本 → 照样并进来
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until, type CdpClient } from '../../harness/cdp'
import type { E2EMarkdownApp } from '../../harness/launch'
import {
  captureEvents,
  launchMarkdownWithProvider,
  readOnlyDir,
  userDir,
  type CapturedEvent,
  type EventLog,
  type UserDir
} from '../../harness/markdownFixtures'
import { markdownWindowPane, type MarkdownWindowPane } from '../../harness/pages'
import { expectFileUnchanged, securityDecisions, waitFileWritten } from '../../harness/seed'
import type { FakeProvider, FakeRequest, FakeTurn } from '../../harness/fakeProvider'

// ─── 文档 ─────────────────────────────────────────────────

const SHORT = [
  '# Short',
  '',
  'intro paragraph',
  '',
  '## One',
  '',
  'one body',
  '',
  'twin marker A',
  '',
  '## Two',
  '',
  'two body text here',
  '',
  '```sh',
  '# not a heading',
  'echo hi',
  '```',
  '',
  'after fence line',
  '',
  'twin marker B',
  '',
  '## Three',
  '',
  'three body',
  '',
  '- item alpha',
  '- item bravo',
  '- item charlie',
  '- item delta',
  ''
].join('\n')

const row = (n: number): string => `row-${String(n).padStart(3, '0')} of the long document`
const LONG = ['# Long', '', ...Array.from({ length: 300 }, (_, i) => row(i + 1)), ''].join('\n')

const EXT = [
  '# Ext',
  '',
  'para A text',
  '',
  'para B text',
  '',
  'para C text',
  '',
  ...Array.from({ length: 100 }, (_, i) => `filler ${String(i + 1).padStart(3, '0')}`),
  '',
  'bottom para',
  ''
].join('\n')

const MC1_DOC = '# MC1\n\nbody line\n'

// ─── 实例与窗口 ───────────────────────────────────────────

type Key = 'short' | 'long' | 'ghost' | 'ext' | 'mc1'

interface Win {
  key: Key
  path: string
  sid: string
  client: CdpClient
  pane: MarkdownWindowPane
  ev: EventLog
}

let app: E2EMarkdownApp
let provider: FakeProvider
let files: UserDir
const wins = {} as Record<Key, Win>
let restoreMc1Dir: (() => void) | null = null

const USAGE = { prompt: 120, completion: 12 }

beforeAll(async () => {
  files = userDir('shuvix-md-coedit-')
  const paths: Record<Key, string> = {
    short: files.file('docs/short.md', SHORT),
    long: files.file('docs/long.md', LONG),
    ghost: files.file('docs/ghost.md', SHORT),
    ext: files.file('docs/ext.md', EXT),
    mc1: files.file('ro/mc1.md', MC1_DOC)
  }
  ;({ app, provider } = await launchMarkdownWithProvider({
    args: Object.values(paths),
    markdownWindows: 5,
    language: 'en'
  }))
  const targets = await app.markdownWindows()
  for (const key of Object.keys(paths) as Key[]) {
    const path = paths[key]
    const sid = targets.find((t) => t.path === path)!.sessionId
    const client = await until(() => app.connectMarkdownWindow(path), `${key} window connected`)
    const pane = markdownWindowPane(client)
    await pane.ready()
    // 编辑器的真实文本到了（不是加载前的空文档）
    await until(async () => (await pane.docText()).length > 0, `${key} document loaded`)
    wins[key] = { key, path, sid, client, pane, ev: await captureEvents(client, sid) }
  }
}, 240_000)

afterAll(async () => {
  restoreMc1Dir?.()
  for (const w of Object.values(wins)) w?.client.close()
  await app?.stop()
  await provider?.close()
  files?.remove()
})

// ─── 工具 ─────────────────────────────────────────────────

/** 一次工具调用的脚本：args 给对象 = 一片发完，给字符串数组 = 逐片下发 */
function call(
  id: string,
  name: string,
  args: Record<string, unknown> | string[]
): { id: string; name: string; args: string | string[] } {
  return { id, name, args: Array.isArray(args) ? args : JSON.stringify(args) }
}

/** 脚本化几轮（最后一轮缺省收一句话），经 IPC 发一句（不等它跑完） */
async function run(w: Win, turns: FakeTurn[], text = 'go'): Promise<void> {
  provider.reset()
  await w.ev.clear()
  provider.script(...turns.map((t) => ({ usage: USAGE, ...t })))
  await w.client.eval(
    `(window.api.agent.prompt({ sessionId: ${JSON.stringify(w.sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined), true)`
  )
}

/** 跑一轮并等它结束 */
async function runToEnd(w: Win, turns: FakeTurn[], timeoutMs = 30_000): Promise<void> {
  await run(w, turns)
  await w.ev.runEnd(1, timeoutMs)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => ((c as { type?: string }).type === 'text' ? (c as { text: string }).text : ''))
    .join('')
}

/** 模型在之后的请求里看到的那条工具结果（没有为 undefined） */
function toolMessage(
  id: string,
  reqs: FakeRequest[] = provider.chatRequests()
): string | undefined {
  for (const req of reqs) {
    const hit = (req.body.messages ?? []).find(
      (m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === id
    )
    if (hit) return contentText(hit.content)
  }
  return undefined
}

/** 等模型那边收到某次调用的结果 */
const waitToolMessage = (id: string, timeoutMs?: number): Promise<string> =>
  until(() => toolMessage(id), `tool result of ${id} reached the model`, timeoutMs)

/** 会话里某次工具调用的块（message.list） */
async function toolBlock(
  w: Win,
  id: string
): Promise<{ isError?: boolean; result?: string } | undefined> {
  const messages = await w.client.eval<
    Array<{
      blocks?: Array<{ type: string; toolCallId?: string; isError?: boolean; result?: string }>
    }>
  >(`window.api.message.list(${JSON.stringify(w.sid)})`)
  for (const m of messages) {
    const b = (m.blocks ?? []).find((x) => x.type === 'tool' && x.toolCallId === id)
    if (b) return b
  }
  return undefined
}

/** 快轮询（until 是 400ms 一拍，虚影 / 痕迹的时间窗更窄） */
async function poll<T>(
  fn: () => T | Promise<T>,
  what: string,
  timeoutMs = 10_000,
  every = 40
): Promise<NonNullable<T>> {
  const t0 = Date.now()
  for (;;) {
    let v: T | undefined
    try {
      v = await fn()
    } catch {
      /* 未就绪 */
    }
    if (v) return v as NonNullable<T>
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs}ms): ${what}`)
    await sleep(every)
  }
}

const disk = (w: Win): string => readFileSync(w.path, 'utf8')

/** 放行假提供商挂着的那一轮（先等它真的挂上 —— 片没发完之前 release 是空操作） */
async function releaseHold(): Promise<void> {
  await poll(() => provider.holding(), 'fake provider holding the turn')
  provider.release()
}

/** 1 起的行号 */
function lineOf(text: string, needle: string): number {
  const at = text.indexOf(needle)
  if (at < 0) throw new Error(`not in text: ${needle}`)
  return text.slice(0, at).split('\n').length
}

/** 等缓冲与文件一致（自动保存落定） */
async function settled(w: Win, what = `${w.key} saved`): Promise<string> {
  let last = ''
  await until(async () => {
    const text = await w.pane.docText()
    const ok = text === disk(w) && text === last
    last = text
    return ok
  }, what)
  return last
}

/** 以用户身份把文档复位成 text，等存盘，再等过「刚打过字」的 1.5s */
async function resetDoc(w: Win, text: string): Promise<void> {
  await w.pane.setDoc(text)
  await until(() => disk(w) === text, `${w.key} reset saved`)
  await sleep(1700)
}

const askDecisions = (toolCallId: string): ReturnType<typeof securityDecisions> =>
  securityDecisions(app).filter((d) => d.toolCallId === toolCallId && d.effect === 'ask')

const eventsOf = async (w: Win, type: string, toolCallId?: string): Promise<CapturedEvent[]> =>
  (await w.ev.all()).filter(
    (e) => e.type === type && (toolCallId === undefined || e.toolCallId === toolCallId)
  )

// ─── doc_read ─────────────────────────────────────────────

describe('doc_read 读的是活缓冲', () => {
  it('MC1 自动保存失败时照样读到刚打的字（盘上没有）；新开的窗口「没打过字」', async () => {
    const w = wins.mc1
    restoreMc1Dir = readOnlyDir(join(files.root, 'ro'))
    await w.pane.placeCaret('end')
    await w.pane.insertText('typed-mc1')
    await poll(async () => (await w.pane.docText()).includes('typed-mc1'), 'typed into mc1')
    // 自动保存（200ms 防抖）试过、失败了：盘上仍是原文
    await expectFileUnchanged(w.path, MC1_DOC, 800)

    await runToEnd(w, [{ toolCalls: [call('mc1_read', 'doc_read', {})] }, { text: 'mc1-done' }])
    const out = await waitToolMessage('mc1_read')
    expect(out).toContain('typed-mc1')
    expect(out).toMatch(/<document lines="\d+">/)
    expect(out).toContain('│typed-mc1')
    expect(out).toContain('last typed ')
    expect(out).not.toContain('has not typed')
    // 首次读：没有「自上次读以来」
    expect(out).not.toContain('<user_edits_since_your_last_read>')
    expect(disk(w)).toBe(MC1_DOC)

    // 新开的、没打过字的窗口
    const fresh = wins.long
    await runToEnd(fresh, [{ toolCalls: [call('mc1_fresh', 'doc_read', {})] }, { text: 'ok' }])
    const freshOut = await waitToolMessage('mc1_fresh')
    expect(freshOut).toContain('has not typed since the document opened.')
    expect(freshOut).toContain(`<document lines="${LONG.split('\n').length}">`)
  })

  it('MC1b 保存失败之后目录恢复可写，在别处再打字 → 两处输入都在（缓冲与文件）', async () => {
    const w = wins.mc1
    restoreMc1Dir?.()
    await w.pane.typeAt('# MC1', ' lead-mc1')
    await until(() => disk(w).includes('lead-mc1'), 'mc1 saved after the dir became writable')
    const text = await settled(w)
    expect(text).toContain('lead-mc1')
    expect(text).toContain('typed-mc1')
    expect(disk(w)).toContain('typed-mc1')
  })

  it('MC2 用户上下文：所在标题（围栏里的 # 不算）、选区、屏幕上的行；首次读没有 diff；长选区截断', async () => {
    const w = wins.short
    await w.pane.select('after fence line')
    await runToEnd(w, [{ toolCalls: [call('mc2_read', 'doc_read', {})] }, { text: 'ok' }])
    const out = await waitToolMessage('mc2_read')
    const cursorLine = lineOf(SHORT, 'after fence line')
    expect(out).toContain(`cursor on line ${cursorLine} (in section "## Two")`)
    expect(out).not.toContain('# not a heading")')
    expect(out).toContain('selected text: "after fence line"')
    const screen = /on screen: lines (\d+)–(\d+)/.exec(out)
    expect(screen).not.toBeNull()
    const [from, to] = [Number(screen![1]), Number(screen![2])]
    expect(from).toBe(1)
    expect(to).toBeGreaterThanOrEqual(cursorLine)
    expect(to).toBeLessThanOrEqual(SHORT.split('\n').length)
    expect(out).toContain('has not typed since the document opened.')
    expect(out).not.toContain('<user_edits_since_your_last_read>')

    // 长选区（long.md 前 40 行，一千多字）→ 前 600 字 + 「…」
    const long = wins.long
    const selected = Array.from({ length: 40 }, (_, i) => row(i + 1)).join('\n')
    expect(selected.length).toBeGreaterThan(600)
    await long.pane.select(selected)
    await runToEnd(long, [{ toolCalls: [call('mc2_long', 'doc_read', {})] }, { text: 'ok' }])
    const longOut = await waitToolMessage('mc2_long')
    expect(longOut).toContain(`selected text: ${JSON.stringify(`${selected.slice(0, 600)}…`)};`)
    // 选区末端（光标）在第 40 行那一格，它上面唯一的标题是 # Long
    expect(longOut).toContain(`cursor on line ${lineOf(LONG, row(40))} (in section "# Long");`)
  })

  it('MC3 第二次读：diff 只有用户的输入，没有 agent 的修改（哪怕 agent 改的是用户后来加的字）', async () => {
    const w = wins.short
    await w.pane.typeAt('one body', ' typed-mc3')
    await runToEnd(w, [
      {
        toolCalls: [
          call('mc3_edit', 'doc_edit', { find: 'three body', replace: 'three AGENT-MC3' })
        ]
      },
      { toolCalls: [call('mc3_read', 'doc_read', {})] },
      { text: 'ok' }
    ])
    expect(await w.pane.docText()).toContain('three AGENT-MC3')
    const out = await waitToolMessage('mc3_read')
    const diff =
      /<user_edits_since_your_last_read>\n([\s\S]*?)\n<\/user_edits_since_your_last_read>/.exec(
        out
      )?.[1]
    expect(diff).toBeDefined()
    expect(diff!.split('\n')).toContain('+one body typed-mc3')
    expect(diff).not.toContain('AGENT-MC3')
    expect(diff).toMatch(/^@@ /)

    // 用户在上次读之后加了字，agent 把它改掉 → 下一次读报的是用户加的字，不是 agent 的版本
    await w.pane.typeAt('two body text here', ' user-new-mc3')
    await sleep(1700)
    await runToEnd(w, [
      {
        toolCalls: [
          call('mc3_fix', 'doc_edit', { find: 'user-new-mc3', replace: 'agent-fixed-mc3' })
        ]
      },
      { toolCalls: [call('mc3_read2', 'doc_read', {})] },
      { text: 'ok' }
    ])
    expect(await w.pane.docText()).toContain('two body text here agent-fixed-mc3')
    const out2 = await waitToolMessage('mc3_read2')
    const diff2 =
      /<user_edits_since_your_last_read>\n([\s\S]*?)\n<\/user_edits_since_your_last_read>/.exec(
        out2
      )?.[1]
    expect(diff2).toBeDefined()
    expect(diff2!.split('\n')).toContain('+two body text here user-new-mc3')
    expect(diff2).not.toContain('agent-fixed-mc3')
    // 全文里是 agent 的版本
    expect(out2).toContain('two body text here agent-fixed-mc3')
  })
})

// ─── doc_edit / doc_insert ────────────────────────────────

describe('doc_edit / doc_insert 在缓冲上执行', () => {
  it('MC4 编辑器里出现、自动保存写盘、不问、结果带行号上下文、不重挂载、不滚动、痕迹盖住新字', async () => {
    const w = wins.short
    const before = await settled(w)
    const tag = await w.pane.tagEditor()
    const top = await w.pane.scrollTop()
    await run(w, [
      {
        toolCalls: [
          call('mc4_edit', 'doc_edit', {
            find: 'intro paragraph',
            replace: 'intro EDITED-MC4 paragraph'
          })
        ]
      },
      { text: 'ok' }
    ])
    await w.ev.toolEnd('mc4_edit')
    // 痕迹：看见之后 2.6s 才移除 —— 趁早看
    const marks = await poll(
      async () => {
        const ms = await w.pane.changeMarks()
        return ms.some((m) => m.text === 'intro EDITED-MC4 paragraph') ? ms : null
      },
      'change mark over the new text',
      2500
    )
    expect(marks.find((m) => m.text === 'intro EDITED-MC4 paragraph')!.external).toBe(false)
    expect(await w.pane.docText()).toContain('intro EDITED-MC4 paragraph')

    const written = await waitFileWritten(w.path, before, 'short.md autosaved the agent edit')
    expect(written).toContain('intro EDITED-MC4 paragraph')
    await w.ev.runEnd()

    const out = await waitToolMessage('mc4_edit')
    const line = lineOf(written, 'intro EDITED-MC4 paragraph')
    expect(out.split('\n')[0]).toBe(`Replaced at line ${line}. The text there now:`)
    expect(out).toContain(`${line}│intro EDITED-MC4 paragraph`)
    expect(out.split('\n')[1]).toMatch(new RegExp(`^${line - 1}│`))
    expect(askDecisions('mc4_edit')).toEqual([])
    expect(await w.pane.editorTag()).toBe(tag)
    expect(await w.pane.scrollTop()).toBe(top)
  })

  it('MC5 撤销分开：⌘Z×2 依次撤掉 U1、U0，agent 的字还在；⌘⇧Z 恢复 U0', async () => {
    const w = wins.short
    await resetDoc(w, SHORT)
    await w.pane.typeAt('one body', ' U0-mc5')
    await sleep(700)
    await runToEnd(w, [
      {
        toolCalls: [
          call('mc5_edit', 'doc_edit', { find: 'three body', replace: 'three AGENT-MC5' })
        ]
      },
      { text: 'ok' }
    ])
    await sleep(700)
    await w.pane.typeAt('two body text here', ' U1-mc5')
    await sleep(700)
    const all = await w.pane.docText()
    expect(all).toContain('one body U0-mc5')
    expect(all).toContain('two body text here U1-mc5')
    expect(all).toContain('three AGENT-MC5')

    await w.pane.undo()
    let text = await w.pane.docText()
    expect(text).not.toContain('U1-mc5')
    expect(text).toContain('U0-mc5')
    expect(text).toContain('three AGENT-MC5')

    await w.pane.undo()
    text = await w.pane.docText()
    expect(text).not.toContain('U0-mc5')
    expect(text).toContain('three AGENT-MC5')
    expect(text).toBe(SHORT.replace('three body', 'three AGENT-MC5'))

    await w.pane.redo()
    text = await w.pane.docText()
    expect(text).toContain('one body U0-mc5')
    expect(text).not.toContain('U1-mc5')
    expect(text).toContain('three AGENT-MC5')
  })

  it('MC6 光标在目标之后：多行修改落下后接着打字，字落在原来的光标处', async () => {
    const w = wins.short
    await resetDoc(w, SHORT)
    const caret = await w.pane.placeCaret({ after: 'after fence line' })
    expect(caret).toBe(SHORT.indexOf('after fence line') + 'after fence line'.length)
    await runToEnd(w, [
      {
        toolCalls: [
          call('mc6_edit', 'doc_edit', {
            find: 'intro paragraph',
            replace: 'intro paragraph\nsecond intro line\nthird intro line'
          })
        ]
      },
      { text: 'ok' }
    ])
    expect(await w.pane.docText()).toContain('intro paragraph\nsecond intro line\nthird intro line')
    await w.pane.insertText('CARET-MC6')
    const text = await poll(async () => {
      const t = await w.pane.docText()
      return t.includes('CARET-MC6') ? t : null
    }, 'typed after the agent edit')
    expect(text).toContain('after fence lineCARET-MC6')
    expect(text.indexOf('CARET-MC6')).toBe(
      text.indexOf('after fence line') + 'after fence line'.length
    )
  })

  it('MC7 失败（0 处 / 2 处 / 两个锚点）→ 红的，下一次请求带着错误，缓冲与文件不动', async () => {
    const w = wins.short
    const before = await settled(w)
    await runToEnd(w, [
      {
        toolCalls: [
          call('mc7_none', 'doc_edit', { find: 'nowhere-mc7', replace: 'x' }),
          call('mc7_twice', 'doc_edit', { find: 'twin marker', replace: 'x' }),
          call('mc7_both', 'doc_insert', { after: 'intro', before: 'three', text: 'x' })
        ]
      },
      { text: 'mc7-done' }
    ])
    const expected: Array<[string, string]> = [
      ['mc7_none', 'does not match'],
      ['mc7_twice', 'matches 2 places'],
      ['mc7_both', 'not both']
    ]
    for (const [id, words] of expected) {
      const end = await w.ev.toolEnd(id)
      expect(end.isError, id).toBe(true)
      const msg = toolMessage(id)
      expect(msg, id).toBeDefined()
      expect(msg!, id).toContain(words)
      const block = await toolBlock(w, id)
      expect(block?.isError, id).toBe(true)
    }
    // 下一次请求带着三条错误
    expect(provider.chatRequests()).toHaveLength(2)
    expect(await w.pane.docText()).toBe(before)
    await expectFileUnchanged(w.path, before, 500)
  })

  it('MC8 doc_insert before / after / 文末 → 落点对，报的行 = 新内容第一行，上下文从锚点上一行起', async () => {
    const w = wins.short
    await resetDoc(w, SHORT)
    await runToEnd(w, [
      {
        toolCalls: [
          call('mc8_before', 'doc_insert', { before: '## Three', text: 'INS-BEFORE-8\n\n' })
        ]
      },
      {
        toolCalls: [
          call('mc8_after', 'doc_insert', { after: 'three body', text: '\n\nINS-AFTER-8' })
        ]
      },
      { toolCalls: [call('mc8_end', 'doc_insert', { text: '\nINS-END-8' })] },
      { text: 'ok' }
    ])
    const text = await w.pane.docText()
    expect(text).toContain('twin marker B\n\nINS-BEFORE-8\n\n## Three')
    expect(text).toContain('three body\n\nINS-AFTER-8\n\n- item alpha')
    expect(text.endsWith('- item delta\n\nINS-END-8')).toBe(true)

    const firstLineNo = (out: string): number => Number(/^\s*(\d+)│/.exec(out.split('\n')[1])![1])
    const before = await waitToolMessage('mc8_before')
    expect(before.split('\n')[0]).toBe(
      `Inserted at line ${lineOf(text, 'INS-BEFORE-8')}. The text there now:`
    )
    expect(firstLineNo(before)).toBe(lineOf(text, 'INS-BEFORE-8') - 1)

    const after = await waitToolMessage('mc8_after')
    expect(after.split('\n')[0]).toBe(
      `Inserted at line ${lineOf(text, 'INS-AFTER-8')}. The text there now:`
    )
    // 锚点是 three body 那一行：上下文从它的上一行起
    expect(firstLineNo(after)).toBe(lineOf(text, 'three body') - 1)
    expect(after).toContain(`${lineOf(text, 'INS-AFTER-8')}│INS-AFTER-8`)

    const end = await waitToolMessage('mc8_end')
    expect(end.split('\n')[0]).toBe(
      `Inserted at line ${lineOf(text, 'INS-END-8')}. The text there now:`
    )
    await until(() => disk(w) === text, 'short.md saved the inserts')
  })
})

// ─── 虚影 ─────────────────────────────────────────────────

describe('生成期间的虚影', () => {
  it('MC9 流式 doc_edit：find 到齐才画；目标 = find、rewriting、新内容逐片变长；期间不动文档；放行后落下', async () => {
    const w = wins.ghost
    const before = await settled(w)
    const pieces = [
      '{"find": "two bo',
      'dy text here", "replace": "TWO ',
      'REWRITTEN ',
      'BY AGENT"}'
    ]
    await run(w, [
      {
        toolCalls: [call('mc9_edit', 'doc_edit', pieces)],
        chunkDelayMs: 900,
        holdMs: 45_000
      },
      { text: 'ok' }
    ])
    // 第一片到了：find 还没写完 → 不画
    await poll(
      async () =>
        (await eventsOf(w, 'toolcall_generating', 'mc9_edit')).some(
          (e) => e.argsDelta === pieces[0]
        ),
      'first args piece arrived'
    )
    await sleep(150)
    expect(await w.pane.ghosts()).toEqual([])
    expect(await w.pane.targetText()).toBe('')

    // find 到齐 → 画出来：目标被标出，新内容逐片变长
    const grown: string[] = []
    for (const want of ['TWO ', 'TWO REWRITTEN ', 'TWO REWRITTEN BY AGENT']) {
      const g = await poll(
        async () => {
          const gs = await w.pane.ghosts()
          return gs.length === 1 && gs[0].text === want ? gs[0] : null
        },
        `ghost text ${JSON.stringify(want)}`
      )
      expect(g.mode).toBe('rewriting')
      expect(g.label).toBe('ShuviX is rewriting this')
      expect(await w.pane.targetText()).toBe('two body text here')
      grown.push(g.text)
    }
    expect(grown).toEqual(['TWO ', 'TWO REWRITTEN ', 'TWO REWRITTEN BY AGENT'])

    // 挂着的时候：缓冲 / 文件都不动（过了自动保存的延迟也不动），⌘Z 碰不到它
    expect(await w.pane.docText()).toBe(before)
    await expectFileUnchanged(w.path, before, 700)
    await w.pane.undo()
    expect(await w.pane.docText()).toBe(before)
    expect(await w.pane.ghosts()).toHaveLength(1)

    await releaseHold()
    await w.ev.toolEnd('mc9_edit')
    await poll(async () => (await w.pane.ghosts()).length === 0, 'ghost gone after the edit ran')
    expect(await w.pane.targetText()).toBe('')
    const text = await w.pane.docText()
    expect(text).toBe(before.replace('two body text here', 'TWO REWRITTEN BY AGENT'))
    const marks = await w.pane.changeMarks()
    expect(marks.some((m) => m.text === 'TWO REWRITTEN BY AGENT' && !m.external)).toBe(true)
    await w.ev.runEnd()
    await until(() => disk(w) === text, 'ghost.md saved the edit')
  })

  it('MC10 find 不唯一 / 不存在 → 不画虚影；执行时失败', async () => {
    const w = wins.ghost
    const before = await settled(w)
    await run(w, [
      {
        toolCalls: [
          call('mc10_twice', 'doc_edit', ['{"find": "twin marker", ', '"replace": "X-MC10"}']),
          call('mc10_none', 'doc_edit', ['{"find": "nowhere-mc10", ', '"replace": "Y-MC10"}'])
        ],
        chunkDelayMs: 300,
        holdMs: 45_000
      },
      { text: 'ok' }
    ])
    await poll(
      async () => (await eventsOf(w, 'toolcall_generating', 'mc10_none')).length >= 3,
      'both calls fully streamed'
    )
    // 给画虚影留几帧：该画的话早画了
    const t0 = Date.now()
    while (Date.now() - t0 < 1200) {
      expect(await w.pane.ghosts()).toEqual([])
      expect(await w.pane.targetText()).toBe('')
      await sleep(100)
    }
    await releaseHold()
    expect((await w.ev.toolEnd('mc10_twice')).isError).toBe(true)
    expect((await w.ev.toolEnd('mc10_none')).isError).toBe(true)
    await w.ev.runEnd()
    expect(await w.pane.docText()).toBe(before)
  })

  it('MC11 doc_insert 的虚影：writing，挂在 after 那行之下 / before 那行之上 / 文末', async () => {
    const w = wins.ghost
    const before = await settled(w)
    await run(w, [
      {
        toolCalls: [
          call('mc11_after', 'doc_insert', [
            '{"after": "intro paragraph", ',
            '"text": "\\n\\nGHOST-AFTER-11"}'
          ]),
          call('mc11_before', 'doc_insert', [
            '{"before": "## Three", ',
            '"text": "GHOST-BEFORE-11\\n\\n"}'
          ]),
          call('mc11_end', 'doc_insert', ['{"text": "\\nGHOST-', 'END-11"}'])
        ],
        chunkDelayMs: 250,
        holdMs: 45_000
      },
      { text: 'ok' }
    ])
    const ghosts = await poll(async () => {
      const gs = await w.pane.ghosts()
      return gs.length === 3 && gs.some((g) => g.text.includes('GHOST-END-11')) ? gs : null
    }, 'three insert ghosts')
    for (const g of ghosts) {
      expect(g.mode).toBe('writing')
      expect(g.label).toBe('ShuviX is writing')
    }
    const byText = (s: string): (typeof ghosts)[number] => ghosts.find((g) => g.text.includes(s))!
    expect(byText('GHOST-AFTER-11').prevLine).toBe('intro paragraph')
    expect(byText('GHOST-BEFORE-11').nextLine).toContain('Three')
    expect(byText('GHOST-END-11').nextLine).toBeNull()
    expect(await w.pane.docText()).toBe(before)
    expect(await w.pane.targetText()).toBe('')

    await releaseHold()
    for (const id of ['mc11_after', 'mc11_before', 'mc11_end']) {
      expect((await w.ev.toolEnd(id)).isError, id).toBeFalsy()
    }
    await poll(async () => (await w.pane.ghosts()).length === 0, 'insert ghosts gone')
    const text = await w.pane.docText()
    expect(text).toContain('intro paragraph\n\nGHOST-AFTER-11')
    expect(text).toContain('GHOST-BEFORE-11\n\n## Three')
    expect(text.endsWith('\nGHOST-END-11')).toBe(true)
    await w.ev.runEnd()
  })

  it('MC12 虚影挂着时中止 → 虚影消失，缓冲与文件不动', async () => {
    const w = wins.ghost
    const before = await settled(w)
    await run(w, [
      {
        toolCalls: [
          call('mc12_edit', 'doc_edit', ['{"find": "three body", ', '"replace": "NEVER-MC12"}'])
        ],
        chunkDelayMs: 200,
        holdMs: 45_000
      },
      { text: 'never' }
    ])
    await poll(async () => (await w.pane.ghosts()).length === 1, 'ghost drawn')
    expect(await w.pane.targetText()).toBe('three body')
    await w.client.eval(`window.api.agent.abort(${JSON.stringify(w.sid)})`)
    await poll(async () => (await w.pane.ghosts()).length === 0, 'ghost gone after abort')
    await w.ev.waitFor((e) => e.type === 'agent_end' || e.type === 'error', 'run ended by abort')
    expect(await w.pane.targetText()).toBe('')
    expect(await w.pane.docText()).toBe(before)
    await expectFileUnchanged(w.path, before, 700)
    expect(await w.pane.docText()).not.toContain('NEVER-MC12')
  })

  it('MC20 toolcall_generating 的 toolCallId 与 tool_start 的是同一个', async () => {
    const w = wins.ghost
    await runToEnd(w, [
      {
        toolCalls: [
          call('mc20_a', 'doc_edit', ['{"find": "one body", ', '"replace": "one body 20"}']),
          call('mc20_b', 'doc_insert', ['{"after": "one body 20", ', '"text": " +b"}'])
        ],
        chunkDelayMs: 100
      },
      { text: 'ok' }
    ])
    const all = await w.ev.all()
    for (const id of ['mc20_a', 'mc20_b']) {
      const gen = all.filter((e) => e.type === 'toolcall_generating' && e.toolCallId === id)
      const start = all.filter((e) => e.type === 'tool_start' && e.toolCallId === id)
      expect(gen.length, id).toBeGreaterThanOrEqual(2)
      expect(start, id).toHaveLength(1)
      expect(gen.every((e) => e.hasToolCallId)).toBe(true)
    }
    // 生成事件里每一片都归到了对的那次调用：a 的增量拼起来是 a 的参数
    const argsOf = (id: string): string =>
      all
        .filter((e) => e.type === 'toolcall_generating' && e.toolCallId === id)
        .map((e) => e.argsDelta ?? '')
        .join('')
    expect(argsOf('mc20_a')).toBe('{"find": "one body", "replace": "one body 20"}')
    expect(argsOf('mc20_b')).toBe('{"after": "one body 20", "text": " +b"}')
    expect(all.filter((e) => e.type === 'toolcall_generating' && !e.toolCallId)).toEqual([])
  })
})

// ─── 等用户停手 ───────────────────────────────────────────

describe('用户正在那一段打字就等他停手', () => {
  it('MC13 一直在目标行末打字 → 虚影「等你」、缓冲不变；停手约 1.5s 后落下，用户的字都在', async () => {
    const w = wins.short
    await resetDoc(w, SHORT)
    const typing = w.pane.keepTyping('two body text here', 4000)
    await sleep(400)
    await run(w, [
      {
        toolCalls: [call('mc13_edit', 'doc_edit', { find: 'two body', replace: 'TWO-WAITED-13' })]
      },
      { text: 'ok' }
    ])
    const waitingGhost = await poll(async () => {
      const gs = await w.pane.ghosts()
      return gs.find((g) => g.mode === 'waiting') ?? null
    }, 'waiting ghost while the user types')
    expect(waitingGhost.label).toBe('ShuviX is waiting for you to pause')
    expect(await w.pane.docText()).not.toContain('TWO-WAITED-13')

    const { typed, lastAt } = await typing
    const end = await w.ev.toolEnd('mc13_edit', 15_000)
    expect(end.isError).toBeFalsy()
    const delay = end.at - lastAt
    expect(delay).toBeGreaterThanOrEqual(1300)
    expect(delay).toBeLessThanOrEqual(2600)
    await w.ev.runEnd()
    const out = await waitToolMessage('mc13_edit')
    expect(out).toMatch(
      /^Replaced at line \d+ \(waited \d+ seconds? for the user to pause typing there\)\./
    )
    const text = await w.pane.docText()
    expect(text).toContain(`TWO-WAITED-13 text here${typed}`)
    expect(await w.pane.ghosts()).toEqual([])
  })

  it('MC14 等的期间用户改掉了原文 → 失败 does not match，红的', async () => {
    const w = wins.short
    await resetDoc(w, SHORT)
    const typing = w.pane.keepTyping('two body text here', 3000)
    await sleep(400)
    await run(w, [
      {
        toolCalls: [call('mc14_edit', 'doc_edit', { find: 'two body text', replace: 'NEVER-14' })]
      },
      { text: 'ok' }
    ])
    await poll(
      async () => (await w.pane.ghosts()).some((g) => g.mode === 'waiting'),
      'waiting ghost'
    )
    // 等着的时候，把光标挪进原文中间 —— 之后打的字把原文改掉
    await w.pane.placeCaret({ after: 'two body' })
    await typing
    const end = await w.ev.toolEnd('mc14_edit', 15_000)
    expect(end.isError).toBe(true)
    await w.ev.runEnd()
    expect(await waitToolMessage('mc14_edit')).toContain('does not match')
    expect((await toolBlock(w, 'mc14_edit'))?.isError).toBe(true)
    expect(await w.pane.docText()).not.toContain('NEVER-14')
    expect(await w.pane.ghosts()).toEqual([])
  })

  it('MC15 一直打字超过 10s → 约 10s 时照样落下', async () => {
    const w = wins.short
    await resetDoc(w, SHORT)
    const typing = w.pane.keepTyping('two body text here', 13_000)
    await sleep(400)
    await run(w, [
      {
        toolCalls: [call('mc15_edit', 'doc_edit', { find: 'two body', replace: 'TWO-MAXWAIT-15' })]
      },
      { text: 'ok' }
    ])
    const start = await w.ev.waitFor(
      (e) => e.type === 'tool_start' && e.toolCallId === 'mc15_edit',
      'mc15 tool_start'
    )
    const end = await w.ev.toolEnd('mc15_edit', 20_000)
    expect(end.isError).toBeFalsy()
    const took = end.at - start.at
    expect(took).toBeGreaterThanOrEqual(9500)
    expect(took).toBeLessThanOrEqual(11_500)
    const { typed, lastAt } = await typing
    // 落下时用户还在打
    expect(end.at).toBeLessThan(lastAt)
    await w.ev.runEnd()
    expect(await waitToolMessage('mc15_edit')).toContain(
      '(waited 10 seconds for the user to pause typing there)'
    )
    expect(await w.pane.docText()).toContain(`TWO-MAXWAIT-15 text here${typed}`)
  }, 90_000)

  it('MC16 光标隔两行 → 不等；紧挨着的一行 → 等；输入法组字中也等', async () => {
    const w = wins.short
    await resetDoc(w, SHORT)
    // 隔两行（bravo → delta）
    const far = w.pane.keepTyping('item delta', 1500)
    await sleep(300)
    await runToEnd(w, [
      {
        toolCalls: [call('mc16_far', 'doc_edit', { find: 'item bravo', replace: 'item bravo-16a' })]
      },
      { text: 'ok' }
    ])
    await far
    const farOut = await waitToolMessage('mc16_far')
    expect(farOut).toMatch(/^Replaced at line \d+\. /)
    expect(farOut).not.toContain('(waited')

    // 紧挨着（charlie 在 bravo 下一行）
    await sleep(1700)
    const near = w.pane.keepTyping('item charlie', 1500)
    await sleep(300)
    await runToEnd(w, [
      {
        toolCalls: [
          call('mc16_near', 'doc_edit', { find: 'item bravo-16a', replace: 'item bravo-16b' })
        ]
      },
      { text: 'ok' }
    ])
    await near
    expect(await waitToolMessage('mc16_near')).toContain('(waited ')

    // 输入法组字中：最后一次改动早过了 1.5s，但组字没提交 → 仍算在打字
    await sleep(1700)
    await w.pane.placeCaret({ after: 'item charlie' })
    await w.pane.compose('ka')
    await sleep(1800)
    await run(w, [
      {
        toolCalls: [
          call('mc16_ime', 'doc_edit', { find: 'item bravo-16b', replace: 'item bravo-16c' })
        ]
      },
      { text: 'ok' }
    ])
    await poll(
      async () => (await w.pane.ghosts()).some((g) => g.mode === 'waiting'),
      'waiting ghost while composing'
    )
    expect(await w.pane.docText()).not.toContain('item bravo-16c')
    await w.pane.insertText('か')
    const end = await w.ev.toolEnd('mc16_ime', 15_000)
    expect(end.isError).toBeFalsy()
    await w.ev.runEnd()
    expect(await waitToolMessage('mc16_ime')).toContain('(waited ')
    expect(await w.pane.docText()).toContain('item bravo-16c')
  })

  it('MC17 一条消息里 doc_edit A→B 再 doc_insert after B → 逐个执行，都成功', async () => {
    const w = wins.short
    await resetDoc(w, SHORT)
    await runToEnd(w, [
      {
        toolCalls: [
          call('mc17_edit', 'doc_edit', { find: 'item alpha', replace: 'item ALPHA-17' }),
          call('mc17_insert', 'doc_insert', {
            after: 'item ALPHA-17',
            text: '\n- item inserted-17'
          })
        ]
      },
      { text: 'ok' }
    ])
    for (const id of ['mc17_edit', 'mc17_insert']) {
      expect((await w.ev.toolEnd(id)).isError, id).toBeFalsy()
    }
    expect(await w.pane.docText()).toContain('- item ALPHA-17\n- item inserted-17\n- item bravo')
  })
})

// ─── 痕迹与指路条 ─────────────────────────────────────────

describe('改动痕迹与指路条', () => {
  it('MC18 屏幕上的淡出移除；屏幕外的一直亮着、指路条指路、点了才滚；两处；删除竖线', async () => {
    const w = wins.long
    await w.pane.placeCaret({ line: 1 })
    await w.pane.scrollToLine(1)
    const top = await w.pane.scrollTop()

    // 屏幕上：看见 → 淡出 → 约 2.6s 后移除
    await run(w, [
      {
        toolCalls: [call('mc18_on', 'doc_edit', { find: row(3), replace: 'row-003 ONSCREEN-18' })]
      },
      { text: 'ok' }
    ])
    await w.ev.toolEnd('mc18_on')
    const fadingAt = await poll(
      async () => {
        const ms = await w.pane.changeMarks()
        return ms.some((m) => m.text === 'row-003 ONSCREEN-18' && m.fading) ? Date.now() : null
      },
      'on-screen mark starts fading',
      3000
    )
    await poll(
      async () => !(await w.pane.changeMarks()).some((m) => m.text.includes('ONSCREEN-18')),
      'on-screen mark removed',
      6000
    )
    expect(Date.now() - fadingAt).toBeGreaterThanOrEqual(1800)
    await w.ev.runEnd()
    expect(await w.pane.indicator()).toBeNull()

    // 屏幕外：3s 后仍没被看见，指路条指向下方；视图没被自动滚动
    await runToEnd(w, [
      {
        toolCalls: [call('mc18_below', 'doc_edit', { find: row(280), replace: 'row-280 BELOW-18' })]
      },
      { text: 'ok' }
    ])
    await sleep(3000)
    expect(await w.pane.indicator()).toEqual({
      direction: 'down',
      text: 'ShuviX changed 1 place below'
    })
    expect(await w.pane.scrollTop()).toBe(top)

    // 点它 → 滚过去、开始淡出、指路条消失
    await w.pane.clickIndicator()
    await poll(async () => (await w.pane.scrollTop()) > top + 1000, 'scrolled to the change')
    await poll(
      async () =>
        (await w.pane.changeMarks()).some((m) => m.text === 'row-280 BELOW-18' && m.fading),
      'revealed mark starts fading',
      3000
    )
    await poll(async () => (await w.pane.indicator()) === null, 'indicator gone', 3000)

    // 两处（屏幕外）→ 2 places
    await w.pane.scrollToLine(1)
    await sleep(3000) // 上一处的痕迹放完
    await runToEnd(w, [
      {
        toolCalls: [
          call('mc18_two_a', 'doc_edit', { find: row(285), replace: 'row-285 TWO-A-18' }),
          call('mc18_two_b', 'doc_edit', { find: row(287), replace: 'row-287 TWO-B-18' })
        ]
      },
      { text: 'ok' }
    ])
    await poll(
      async () => (await w.pane.indicator())?.text === 'ShuviX changed 2 places below',
      'indicator counts two changes'
    )
    expect((await w.pane.indicator())!.direction).toBe('down')
    await w.pane.clickIndicator()
    await poll(async () => (await w.pane.indicator()) === null, 'both revealed', 3000)

    // replace 为空 → 删除竖线
    await w.pane.scrollToLine(1)
    await sleep(3000)
    const barsBefore = await w.pane.deletionBars()
    await run(w, [
      { toolCalls: [call('mc18_del', 'doc_edit', { find: `${row(5)}\n`, replace: '' })] },
      { text: 'ok' }
    ])
    await w.ev.toolEnd('mc18_del')
    await poll(async () => (await w.pane.deletionBars()) > barsBefore, 'deletion bar drawn', 3000)
    const text = await w.pane.docText()
    expect(text).not.toContain(row(5))
    expect(text).toContain(`${row(4)}\n${row(6)}`)
    await w.ev.runEnd()
  })

  it('MC19 虚影在屏幕外 → 「working below」，落下后 → 「changed 1 place below」；读时一闪「reading」', async () => {
    const w = wins.long
    await w.pane.scrollToLine(1)
    await sleep(3000)
    expect(await w.pane.indicator()).toBeNull()
    await run(w, [
      {
        toolCalls: [
          call('mc19_edit', 'doc_edit', [
            '{"find": "row-270 of the long document", ',
            '"replace": "row-270 WORKED-19"}'
          ])
        ],
        chunkDelayMs: 200,
        holdMs: 45_000
      },
      { text: 'ok' }
    ])
    await poll(async () => {
      const ind = await w.pane.indicator()
      return ind?.direction === 'down' && ind.text === 'ShuviX is working below'
    }, 'indicator: working below')
    await releaseHold()
    await w.ev.toolEnd('mc19_edit')
    await poll(
      async () => (await w.pane.indicator())?.text === 'ShuviX changed 1 place below',
      'indicator: changed 1 place below'
    )
    await w.ev.runEnd()

    // 看掉它，再读一次：一闪「reading」
    await w.pane.clickIndicator()
    await poll(async () => (await w.pane.indicator()) === null, 'indicator cleared', 3000)
    await run(w, [{ toolCalls: [call('mc19_read', 'doc_read', {})] }, { text: 'ok' }])
    await poll(
      async () => (await w.pane.indicator())?.direction === 'reading',
      'reading flash',
      8000,
      30
    )
    await w.ev.runEnd()
    await poll(async () => (await w.pane.indicator()) === null, 'reading flash over', 4000)
  })
})

// ─── 外部写盘 ─────────────────────────────────────────────

describe('别的程序写了盘', () => {
  /** 把磁盘上当前内容里的一段换掉再写回（像别的程序那样：读盘 → 改 → 写） */
  function externalEdit(w: Win, find: string, replace: string): string {
    const now = disk(w)
    if (!now.includes(find)) throw new Error(`external edit: ${find} not on disk`)
    const next = now.replace(find, replace)
    writeFileSync(w.path, next)
    return next
  }

  it('EX1 没有本地改动 → 并进来：不重挂载、external 痕迹、不进指路条、⌘Z 撤不掉、不反复写盘', async () => {
    const w = wins.ext
    await settled(w)
    const tag = await w.pane.tagEditor()
    const next = disk(w)
      .replace('para B text', 'para B EXTERNAL-1')
      .replace('bottom para', 'bottom EXTERNAL-1B')
    writeFileSync(w.path, next)
    await poll(async () => (await w.pane.docText()) === next, 'external write merged', 10_000)
    const marks = await poll(
      async () => {
        const ms = await w.pane.changeMarks()
        return ms.some((m) => m.external && m.text.includes('EXTERNAL-1')) ? ms : null
      },
      'external mark',
      2500
    )
    expect(marks.filter((m) => m.text.includes('EXTERNAL-1')).every((m) => m.external)).toBe(true)
    expect(await w.pane.editorTag()).toBe(tag)
    // 屏幕外那一处（bottom）也是外部的：不进指路条
    await sleep(600)
    expect(await w.pane.indicator()).toBeNull()

    await w.pane.undo()
    expect(await w.pane.docText()).toBe(next)

    // 不回写成循环：落定之后 2s 内 mtime 不再变
    await sleep(1500)
    const mtime = statSync(w.path).mtimeMs
    await sleep(2000)
    expect(statSync(w.path).mtimeMs).toBe(mtime)
    expect(disk(w)).toBe(next)
  })

  it('EX2 一直在打字时别的程序改了另一段 → 缓冲与文件最后两边都有', async () => {
    const w = wins.ext
    await settled(w)
    const typing = w.pane.keepTyping('para A text', 2000, 150, 'a')
    await sleep(300)
    externalEdit(w, 'para C text', 'para C EXT-2')
    const { typed } = await typing
    await poll(async () => (await w.pane.docText()).includes('para C EXT-2'), 'EX2 merged')
    const text = await settled(w, 'EX2 settled')
    expect(text).toContain(`para A text${typed}`)
    expect(text).toContain('para C EXT-2')
    expect(disk(w)).toBe(text)
  })

  it('EX3 单纯打字永远不出 external 痕迹、不重复', async () => {
    const w = wins.ext
    await settled(w)
    // 上一条留下的 external 痕迹放完
    await poll(
      async () => !(await w.pane.changeMarks()).some((m) => m.external),
      'old marks gone',
      6000
    )
    await w.pane.placeCaret({ after: 'para B EXTERNAL-1' })
    const pauses = [60, 250, 90, 320, 40, 210, 400, 120, 260, 50, 300, 180]
    let typed = ''
    let sawExternal = false
    for (const [i, pause] of pauses.entries()) {
      const ch = String.fromCharCode(97 + i)
      await w.pane.insertText(ch)
      typed += ch
      await sleep(pause)
      if ((await w.pane.changeMarks()).some((m) => m.external)) sawExternal = true
    }
    const t0 = Date.now()
    while (Date.now() - t0 < 2000) {
      if ((await w.pane.changeMarks()).some((m) => m.external)) sawExternal = true
      await sleep(100)
    }
    expect(sawExternal).toBe(false)
    const text = await settled(w, 'EX3 settled')
    expect(text.split(typed)).toHaveLength(2)
    expect(text).toContain(`para B EXTERNAL-1${typed}`)
  })

  it('EX4 打一个字、20ms 内别的程序改了另一段 → 文件最后两边都有', async () => {
    const w = wins.ext
    await settled(w)
    await w.pane.placeCaret({ after: 'para A text' })
    const onDisk = disk(w)
    await w.pane.insertText('K')
    const t0 = Date.now()
    writeFileSync(w.path, onDisk.replace('para C EXT-2', 'para C EXT-4'))
    expect(Date.now() - t0).toBeLessThan(20)
    await poll(async () => (await w.pane.docText()).includes('para C EXT-4'), 'EX4 merged')
    const text = await settled(w, 'EX4 settled')
    expect(text).toContain('para C EXT-4')
    expect(text).toContain('para A textK')
    expect(disk(w)).toBe(text)
  })

  it('EX5 外部写下的内容与缓冲一样 → 不重复', async () => {
    const w = wins.ext
    await settled(w)
    await w.pane.typeAt('para C EXT-4', ' Q-ex5')
    const buffer = await poll(
      async () => {
        const t = await w.pane.docText()
        return t.includes('Q-ex5') ? t : null
      },
      'typed Q-ex5',
      2000,
      10
    )
    writeFileSync(w.path, buffer)
    await sleep(1500)
    const text = await settled(w, 'EX5 settled')
    expect(text.split('Q-ex5')).toHaveLength(2)
    expect(text).toBe(buffer)
  })

  it('EX6 外部把文件退回到我们更早存过的版本 → 照样并进来', async () => {
    const w = wins.ext
    const v1 = await settled(w)
    await w.pane.typeAt('bottom EXTERNAL-1B', ' typed-ex6')
    await until(() => disk(w).includes('typed-ex6'), 'EX6 v2 saved')
    const v2 = await settled(w)
    expect(v2).not.toBe(v1)
    writeFileSync(w.path, v1)
    await poll(async () => (await w.pane.docText()) === v1, 'reverted version merged', 10_000)
    const text = await settled(w, 'EX6 settled')
    expect(text).toBe(v1)
    expect(text).not.toContain('typed-ex6')
  })
})
