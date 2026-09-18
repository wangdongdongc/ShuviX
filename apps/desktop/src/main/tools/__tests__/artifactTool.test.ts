/**
 * artifact 工具（tools/artifact.ts）—— 会话 Artifacts 的 `list` / `adopt` / `create`。
 * 真实临时目录 + 真实 store/adopt + 真实 fileTime，只把转写（messageService）与注册表换成替身。
 *
 * 两组东西钉在这里：
 *
 *  1. **回执就是模型唯一的读面**。它拿不到返回值里的结构，只读那段文本，所以「路径 + 文件名 +
 *     ```artifact 围栏示例」三样缺一不可；三条前置校验的回执必须各自可辨（否则模型补不对参数）；
 *     未知 action 要**列出三个合法值而不是抛异常**（抛出去它只看到一行报错）。
 *  2. **「模型零重发」不变式**（AT-15/16）。这是整条路存在的理由，也最容易写成空转门，所以用
 *     **双哨兵**：转写里那张图埋 A、调用时故意在 `content` 参数里塞 B —— 落盘文件**含 A**
 *     （正向锚点：字节确实来自转写）**且不含 B**（adopt 分支根本不读 content）。两半缺一都是
 *     空转门。再加一条：回执文本不含内容哨兵 —— 挡的是「给回执加上『这是你认领的内容：<全文>』
 *     当凭据」这种善意回归，那会让 SVG 在下一个请求里整份回到上下文。
 *
 * `recordRead` 买到的**不是**「让 edit 能用」（edit 只在本会话读过时才校验陈旧，没读过不拦）——
 * 它买到的是**开启陈旧检测**。这里只钉「对返回的那个 path 记了一笔」，拦不拦得住在
 * artifactEditGuard.test.ts。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

const state = vi.hoisted(() => ({
  root: '',
  registered: [] as Array<Record<string, unknown>>,
  messages: [] as ChatMessage[]
}))

vi.mock('../../utils/paths', () => ({
  getSessionArtifactsDir: (sessionId: string) => `${state.root}/${sessionId}`
}))
vi.mock('../../services/messageService', () => ({
  messageService: { listBySession: async () => state.messages }
}))
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: (meta: Record<string, unknown>) => {
    state.registered.push(meta)
  }
}))
vi.mock('../../i18n', () => ({ t: (k: string) => k }))

import { ARTIFACT_DESCRIPTION, ArtifactParamsSchema, ArtifactTool } from '../artifact'
import { _resetAll, getReadTime } from '../../utils/toolUtils/fileTime'
import type { ToolContext } from '../../services/toolContext'

const HOME_ARTIFACTS = join(homedir(), '.shuvix', 'artifacts')
const homeSnapshot = (): string[] | null => {
  try {
    return readdirSync(HOME_ARTIFACTS).sort()
  } catch {
    return null
  }
}
let homeBefore: string[] | null = null

let seq = 0
let sid = ''
const entries = (sessionId = sid): string[] | null => {
  try {
    return readdirSync(join(state.root, sessionId)).sort()
  } catch {
    return null
  }
}

const ctxFor = (sessionId: string): ToolContext => ({ sessionId }) as ToolContext
const toolFor = (sessionId: string): ArtifactTool => new ArtifactTool(ctxFor(sessionId))
const textOf = (res: AgentToolResult<unknown>): string => (res.content[0] as { text: string }).text
const run = async (
  params: Record<string, unknown>,
  sessionId = sid
): Promise<AgentToolResult<unknown>> => toolFor(sessionId).execute('call-1', params as never)

/** 一条只有正文的助手消息（投影里 content 就是 text 块的拼接） */
const said = (text: string, id = 'a'): AssistantMessage => ({
  id,
  sessionId: 's',
  role: 'assistant',
  type: 'message',
  blocks: [{ type: 'text', text }],
  content: text,
  model: 'm',
  createdAt: 1,
  metadata: null
})
const fenced = (body: string): string => ['```svg', body, '```'].join('\n')
const svg = (label: string, extra = ''): string =>
  `<svg viewBox="0 0 4 4" aria-label="${label}">\n  <rect/>${extra}\n</svg>`

beforeAll(() => {
  homeBefore = homeSnapshot()
  state.root = join(realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-artifact-tool-'))), 'artifacts')
})

afterAll(() => {
  expect(homeSnapshot()).toEqual(homeBefore)
  rmSync(join(state.root, '..'), { recursive: true, force: true })
})

beforeEach(() => {
  // 每个用例一个新会话目录：去重按目录实况探测，共用会污染出「为什么第一个就 -2 了」
  sid = `s${++seq}`
  state.messages = []
  _resetAll()
})

describe('注册元数据', () => {
  it('AT-1 name / group / icon 钉板，describe() 与导出常量同源', () => {
    const meta = state.registered.find((m) => m.name === 'artifact')
    expect(meta).toBeDefined()
    expect(meta!.group).toBe('general')
    expect(meta!.presentation).toEqual({ icon: 'Archive', iconColor: '#8b5cf6' })
    const described = (meta!.describe as () => { description: string; parameters: unknown })()
    // 两份文案漂开的话，settings 里看到的与模型拿到的就不是一件事
    expect(described.description).toBe(ARTIFACT_DESCRIPTION)
    expect(described.parameters).toBe(ArtifactParamsSchema)
    expect((meta!.getLabel as () => string)()).toBe('tool.artifactLabel')
    expect((meta!.getHint as () => string)()).toBe('tool.artifactHint')
    expect(toolFor('s').name).toBe('artifact')
    expect(toolFor('s').description).toBe(ARTIFACT_DESCRIPTION)
  })
})

describe('action 归一与未知 action', () => {
  it('AT-2 大小写与空白都归一（`  LIST  ` 就是 list）', async () => {
    expect(textOf(await run({ action: '  LIST  ' }))).toContain('Artifacts: none yet.')
    expect(textOf(await run({ action: 'List' }))).toContain('Artifacts: none yet.')
  })

  it('AT-3 未知 action ⇒ 回执列出三个合法值，且不抛', async () => {
    const res = await run({ action: 'delete' })
    const out = textOf(res)
    expect(out).toContain('Unknown action "delete"')
    expect(out).toContain('Use one of: list, adopt, create.')
    // 空 / 缺省 action 也走同一条兜底（抛出去模型只看到一行报错，补不对参数）
    expect(textOf(await run({ action: '' }))).toContain('Use one of: list, adopt, create.')
    expect(textOf(await run({}))).toContain('Use one of: list, adopt, create.')
  })
})

describe('list —— 已有哪些 + 转写里还有哪些可认领', () => {
  it('AT-4 空会话两行 none（而不是空串或一行）', async () => {
    const out = textOf(await run({ action: 'list' }))
    expect(out).toContain('Artifacts: none yet.')
    expect(out).toContain('Figures in the transcript not yet adopted: none.')
    expect(entries()).toBeNull()
  })

  it('AT-5 已有与未认领两段同时给出（名字 / 标题 / 绝对路径 + [序号] 标题）', async () => {
    await run({ action: 'create', title: 'Draft', ext: 'md', content: '# Draft doc' })
    state.messages = [said(fenced(svg('Requests by tier')))]
    const out = textOf(await run({ action: 'list' }))
    expect(out).toContain('Artifacts (1)')
    expect(out).toContain('draft.md — Draft doc')
    expect(out).toContain(join(state.root, sid, 'draft.md'))
    expect(out).toContain('Figures in the transcript not yet adopted (1):')
    expect(out).toContain('[1] Requests by tier')
  })

  it('AT-6 已认领的图不再列为「可认领」（那个邀请本身就是误导）', async () => {
    state.messages = [said(`${fenced(svg('One'))}\n${fenced(svg('Two'))}`)]
    expect(textOf(await run({ action: 'list' }))).toContain('not yet adopted (2)')

    await run({ action: 'adopt', ref: '1' })
    const out = textOf(await run({ action: 'list' }))
    expect(out).toContain('not yet adopted (1):')
    expect(out).toContain('[2] Two')
    expect(out).not.toContain('[1] One')
    // 已认领的那张出现在上半段（改它走 `edit`，不是再认领一次）
    expect(out).toContain('one.svg — One')

    await run({ action: 'adopt', ref: '2' })
    expect(textOf(await run({ action: 'list' }))).toContain(
      'Figures in the transcript not yet adopted: none.'
    )
  })
})

describe('create —— 内容经参数写盘（给本来就是文件的产物）', () => {
  it('AT-7 三条前置校验各自回执，且一个文件都没写', async () => {
    const noTitle = textOf(await run({ action: 'create', ext: 'md', content: 'x' }))
    const noExt = textOf(await run({ action: 'create', title: 'T', content: 'x' }))
    const noContent = textOf(await run({ action: 'create', title: 'T', ext: 'md' }))
    expect(noTitle).toContain('`title`')
    expect(noExt).toContain('`ext`')
    expect(noContent).toContain('`content`')
    // 三条必须互不相同：回执是模型唯一的读面，一样的话它不知道补哪个参数
    expect(new Set([noTitle, noExt, noContent]).size).toBe(3)
    // 空白 title / ext 同样被拦（`trim()` 后为空）
    expect(textOf(await run({ action: 'create', title: '  ', ext: 'md', content: 'x' }))).toContain(
      '`title`'
    )
    expect(textOf(await run({ action: 'create', title: 'T', ext: ' ', content: 'x' }))).toContain(
      '`ext`'
    )
    expect(entries()).toBeNull()
  })

  it("AT-8 `content: ''` 合法 —— 只有 undefined 才拒（空文件是有意义的起点）", async () => {
    const out = textOf(await run({ action: 'create', title: 'Empty', ext: 'md', content: '' }))
    expect(out).toContain('Created empty.md.')
    expect(readFileSync(join(state.root, sid, 'empty.md'), 'utf-8')).toBe('')
  })

  it('AT-9 非法 ext ⇒ 可读回执（含允许集），不是工具异常，且一个文件都没写', async () => {
    // 四条失败模式要同形：另外三条前置校验都是回执，单这一条抛成工具异常是两种 UI，
    // 而且模型从异常里拿不到「允许哪些」。白名单里没有 html（第 1 期渲染分支只内联 SVG）。
    const res = await run({ action: 'create', title: 'Page', ext: 'html', content: '<h1/>' })
    const out = textOf(res)
    expect(out).toMatch(/Unsupported artifact type "\.html"/)
    expect(out).toMatch(/svg/) // 回执要把允许集摆出来，模型才知道改成什么
    expect(entries()).toBeNull() // 抛错前不该已经 mkdir
  })

  it('AT-10 成功回执含绝对路径 + 文件名 + ```artifact 围栏示例', async () => {
    const res = await run({ action: 'create', title: 'Bar chart', ext: 'svg', content: '<svg/>' })
    const out = textOf(res)
    const path = join(state.root, sid, 'bar-chart.svg')
    expect(out).toContain('Created bar-chart.svg.')
    expect(out).toContain(path)
    // 围栏示例是「怎么把它展示出来」的唯一教学面
    expect(out).toContain('```artifact\nbar-chart.svg\n```')
    expect(out).toContain('`edit`')
    expect(res.details).toEqual({ type: 'artifact', action: 'create', name: 'bar-chart.svg' })
  })
})

describe('adopt —— 失败文案与幂等文案', () => {
  it('AT-11 两种失败文案不同：一张图都没有 vs 有图但 ref 匹配不上', async () => {
    const none = textOf(await run({ action: 'adopt' }))
    expect(none).toContain('There is no ```svg figure in this conversation to adopt.')
    expect(none).toContain('action "create"')

    state.messages = [said(`${fenced(svg('One'))}\n${fenced(svg('Two'))}`)]
    const missed = textOf(await run({ action: 'adopt', ref: 'nope' }))
    expect(missed).toContain('No figure matched "nope".')
    // 匹配不上时要把可选项报回给模型，否则它只能再猜一次
    expect(missed).toContain('[1] One')
    expect(missed).toContain('[2] Two')
    expect(missed).not.toBe(none)
    expect(entries()).toBeNull()
  })

  it('AT-12 幂等回执与首次回执可辨，且说清「早先的编辑还在」', async () => {
    state.messages = [said(fenced(svg('Bar chart')))]
    const first = textOf(await run({ action: 'adopt' }))
    expect(first).toContain('Adopted "Bar chart" as bar-chart.svg.')

    const again = await run({ action: 'adopt' })
    const out = textOf(again)
    expect(out).toContain('was already adopted as bar-chart.svg')
    expect(out).toContain('earlier edits are intact')
    expect(out).not.toBe(first)
    expect(again.details).toEqual({ type: 'artifact', action: 'adopt', name: 'bar-chart.svg' })
    expect(entries()).toEqual(['bar-chart.svg'])
  })

  it('AT-13 成功回执同样含路径 + 文件名 + 围栏示例', async () => {
    state.messages = [said(fenced(svg('Latency p99')))]
    const out = textOf(await run({ action: 'adopt' }))
    expect(out).toContain(join(state.root, sid, 'latency-p99.svg'))
    expect(out).toContain('```artifact\nlatency-p99.svg\n```')
  })
})

describe('recordRead / 会话粒度', () => {
  it('AT-14 create 与 adopt 都对**返回的那个 path** 记了一笔（开启陈旧检测）', async () => {
    state.messages = [said(fenced(svg('Figure')))]
    const adopted = await run({ action: 'adopt' })
    const adoptedPath = join(state.root, sid, 'figure.svg')
    expect((adopted.details as { name: string }).name).toBe('figure.svg')
    expect(getReadTime(sid, adoptedPath)).toBeInstanceOf(Date)

    const created = await run({ action: 'create', title: 'Doc', ext: 'md', content: '# Doc' })
    expect((created.details as { name: string }).name).toBe('doc.md')
    expect(getReadTime(sid, join(state.root, sid, 'doc.md'))).toBeInstanceOf(Date)
    // 记的键是会话 id + 绝对路径：换一场会话问就没有
    expect(getReadTime('other-session', adoptedPath)).toBeUndefined()
  })

  it('AT-15 目录取 ctx.sessionId，不上溯根会话（子代理写进自己的目录）', async () => {
    // 认领读的是**本会话**的转写，目录跟转写对齐才不会出现「看得见的图认领不到、
    // 认领到的图看不见」
    const child = `${sid}-child`
    state.messages = [said(fenced(svg('Child figure')))]
    const res = await toolFor(child).execute('c', { action: 'adopt' } as never)
    expect(textOf(res)).toContain(join(state.root, child, 'child-figure.svg'))
    expect(entries(child)).toEqual(['child-figure.svg'])
    expect(entries(sid)).toBeNull()
  })
})

describe('「模型零重发」不变式（双哨兵）', () => {
  it('AT-16 adopt 落盘的字节来自转写（含 A），不来自 content 参数（不含 B）', async () => {
    const A = '<!--SENTINEL-A-->'
    const B = '<!--SENTINEL-B-->'
    state.messages = [said(fenced(svg('Sentinel', `\n  ${A}`)))]

    // 故意把 B 塞进 content：adopt 分支若读了它，落盘就会带上 B
    const res = await run({ action: 'adopt', content: `<svg>${B}</svg>` })
    const written = readFileSync(join(state.root, sid, 'sentinel.svg'), 'utf-8')
    expect(written).toContain(A) // 正向锚点：字节确实来自转写
    expect(written).not.toContain(B) // adopt 根本不读 content
    expect(written).toBe(svg('Sentinel', `\n  ${A}`))

    // 回执不许携带内容：否则 SVG 会在下一个请求里整份回到上下文，
    // 「模型零重发」当场作废（挡的是「这是你认领的内容：<全文>」这种善意回归）
    const out = textOf(res)
    expect(out).not.toContain(A)
    expect(out).not.toContain('<svg')
    expect(out).toContain(join(state.root, sid, 'sentinel.svg'))
    expect(out).toContain('```artifact\nsentinel.svg\n```')
  })

  it('AT-17 create 的回执也不回显内容（只有路径与围栏）', async () => {
    const C = '<!--SENTINEL-C-->'
    const body = `# Draft\n\n${C}\n`
    const out = textOf(await run({ action: 'create', title: 'Draft', ext: 'md', content: body }))
    expect(readFileSync(join(state.root, sid, 'draft.md'), 'utf-8')).toBe(body)
    expect(out).not.toContain(C)
    expect(out).toContain(join(state.root, sid, 'draft.md'))
    expect(out).toContain('```artifact\ndraft.md\n```')
  })

  it('AT-18 list 只给名字 / 标题 / 路径，不给任何一件的内容', async () => {
    const D = '<!--SENTINEL-D-->'
    await run({ action: 'create', title: 'Chart', ext: 'svg', content: `<svg>${D}</svg>` })
    state.messages = [said(fenced(svg('Pending', `\n  ${D}`)))]
    const out = textOf(await run({ action: 'list' }))
    expect(out).toContain('chart.svg')
    expect(out).toContain('[1] Pending')
    expect(out).not.toContain(D)
    expect(out).not.toContain('<svg')
  })
})
