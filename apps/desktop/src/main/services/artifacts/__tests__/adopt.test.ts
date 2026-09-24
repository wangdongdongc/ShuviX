/**
 * 认领（services/artifacts/adopt.ts）—— 把对话里一张已画出来的 ```svg 图变成可反复修改的文件。
 *
 * 这条路存在的全部理由是**模型一个字都不用重发**：源码已经在会话转写里，宿主取出来写盘即可。
 * 于是「作画」可以永远走 ```svg 围栏（流式逐帧画、长在散文里、不落盘），只有「要改了」才付
 * 一次文件拷贝。所以这里钉的两类东西都关乎那条不变式：
 *
 *  - **抽取面必须与用户看到的东西同宽**。只认助手消息（用户贴进来的 SVG 不是这场对话的产物）、
 *    只认已闭合的围栏（流式被打断是常态，认领半张图会写出坏文件）、语言串**大小写敏感**
 *    （与 CodeBlock 的分发同宽 —— 那边只认小写，svgFence.test.ts 已把这点钉成契约；带 `i`
 *    会让 adopt 认领一个用户看到的其实是普通代码块的东西）。
 *  - **认领必须幂等**。否则设计文档自己的主线场景走到第二轮就坏：画图 → 认领 → `edit` 改矮
 *    一根柱子 → 用户「再改一下」→ 模型又认领同一张 → 拿到一个 `-2` 文件，内容是**转写里的
 *    原始源码**，第一次的编辑就此分叉丢失，而新发的引用展示的是未编辑版 —— 用户看到的是
 *    「我的修改被撤销了」。
 *
 * ```interactive 交互块走同一条路（AD-24…33）：`kind` 决定落盘扩展名（svg → `.svg`，interactive →
 * `.html`，html 落盘带一行 CSP），幂等按「标题 + 种类」派生的文件名判 —— 同名的一张 svg 与一块
 * 交互图各是各的一件。抽取面与 svg 同宽：只认小写 `interactive`、只认已闭合的、容忍缩进 / CRLF /
 * 语言串后的空格；```html 不算（那是代码示例）。（用例清单里这一组编号是 AD-8…18、其中 AD-13 已裁掉；
 * 本文件那几个号早已占用，顺延为 AD-24…33。）
 *
 * 顶桩纪律：adopt.ts 间接 import store.ts，所以这里同样必须顶掉 `getSessionArtifactsDir`
 * （漏一条的表现是往真实 home 写盘），文件末尾有真实 home 哨兵。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AssistantBlock,
  AssistantMessage,
  ChatMessage,
  ErrorEventMessage,
  UserTextMessage
} from '@shuvix/chat-protocol/types/chatMessage'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('../../../utils/paths', () => ({
  getSessionArtifactsDir: (sessionId: string) => `${state.root}/${sessionId}`
}))

import { SANDBOX_CSP } from '@shuvix/chat-protocol/utils/interactiveFence'
import { adoptFigure, figureArtifactName, listAdoptableFigures } from '../adopt'

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
const newSession = (): string => `s${++seq}`
const entries = (sessionId: string): string[] | null => {
  try {
    return readdirSync(join(state.root, sessionId)).sort()
  } catch {
    return null
  }
}

beforeAll(() => {
  homeBefore = homeSnapshot()
  state.root = join(realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-adopt-'))), 'artifacts')
})

afterAll(() => {
  expect(homeSnapshot()).toEqual(homeBefore)
  rmSync(join(state.root, '..'), { recursive: true, force: true })
})

// ─── 转写夹具 ────────────────────────────────────────────────────────────────
// 投影里 assistant 消息的 `content` 是**所有 text 块的拼接**（thinking 块不在其中），
// 所以夹具要照这条规则造：给 blocks 的同时自己拼 content，别让两者对不上

const assistant = (blocks: AssistantBlock[], id = 'a'): AssistantMessage => ({
  id,
  sessionId: 's',
  role: 'assistant',
  type: 'message',
  blocks,
  content: blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join(''),
  model: 'm',
  createdAt: 1,
  metadata: null
})

/** 只有正文的一条助手消息（最常见的形态） */
const said = (text: string, id = 'a'): AssistantMessage => assistant([{ type: 'text', text }], id)

const user = (content: string): UserTextMessage => ({
  id: 'u',
  sessionId: 's',
  role: 'user',
  type: 'text',
  content,
  model: 'm',
  createdAt: 1,
  metadata: null
})

const notice = (content: string): ErrorEventMessage => ({
  id: 'e',
  sessionId: 's',
  role: 'system_notify',
  type: 'error_event',
  content,
  model: '',
  createdAt: 1,
  metadata: null
})

/** ```svg 围栏；indent 用来验「容忍围栏缩进」，eol 用来验 CRLF */
const fence = (
  body: string,
  opts: { indent?: string; eol?: string; lang?: string } = {}
): string => {
  const { indent = '', eol = '\n', lang = 'svg' } = opts
  return [`${indent}\`\`\`${lang}`, body, `${indent}\`\`\``].join(eol)
}

const svg = (label: string): string =>
  `<svg viewBox="0 0 4 4" aria-label="${label}">\n  <rect/>\n</svg>`

describe('listAdoptableFigures —— 抽取面与用户看到的东西同宽', () => {
  it('AD-1 单围栏抽出来，source 已 trim（前后空行不进文件）', () => {
    const body = `\n${svg('Tiers')}\n`
    const figures = listAdoptableFigures([said(`看这张：\n${fence(body)}\n就这样。`)])
    expect(figures).toHaveLength(1)
    expect(figures[0]).toEqual({ title: 'Tiers', index: 1, source: svg('Tiers'), kind: 'svg' })
  })

  it('AD-2 多围栏按出现顺序，index 从 1 连续（跨消息也连续）', () => {
    const figures = listAdoptableFigures([
      said(`${fence(svg('One'))}\n中间一段散文\n${fence(svg('Two'))}`, 'a1'),
      user(`用户插话，里面也有 ${fence(svg('UserPasted'))}`),
      said(fence(svg('Three')), 'a2')
    ])
    expect(figures.map((f) => [f.index, f.title])).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three']
    ])
  })

  it('AD-3 title 走 titleOf（aria-label / 根 <title> 都算）', () => {
    const rootTitle = '<svg viewBox="0 0 4 4">\n  <title>Latency</title>\n</svg>'
    const figures = listAdoptableFigures([said(`${fence(svg('Aria'))}\n${fence(rootTitle)}`)])
    expect(figures.map((f) => f.title)).toEqual(['Aria', 'Latency'])
  })

  it('AD-4 取不到标题 ⇒ 回落 `figure-<n>`（n 是它在整场会话里的序号）', () => {
    const bare = '<svg viewBox="0 0 4 4">\n  <rect/>\n</svg>'
    const figures = listAdoptableFigures([said(`${fence(svg('Named'))}\n${fence(bare)}`)])
    expect(figures.map((f) => f.title)).toEqual(['Named', 'figure-2'])
  })

  it('AD-5 user 角色的围栏不被认领（用户贴进来的不是这场对话的产物）', () => {
    expect(listAdoptableFigures([user(fence(svg('Pasted')))])).toEqual([])
  })

  it('AD-6 system_notify 的围栏不被认领', () => {
    expect(listAdoptableFigures([notice(fence(svg('FromError')))])).toEqual([])
  })

  it('AD-7 thinking 块里的围栏不被认领（content 只拼 text 块）', () => {
    // 模型在思考里试画的草图不是它交出去的东西；投影的 content 本就不含 thinking，
    // 这条钉的是「抽取读 content 而不是遍历 blocks」这个选择的后果
    const msg = assistant([
      { type: 'thinking', text: `先试试：\n${fence(svg('Draft'))}` },
      { type: 'text', text: `成品：\n${fence(svg('Final'))}` }
    ])
    expect(listAdoptableFigures([msg]).map((f) => f.title)).toEqual(['Final'])
  })

  it('AD-8 半截围栏不被认领（流式被打断是常态，认领半张图会写出坏文件）', () => {
    expect(listAdoptableFigures([said('```svg\n<svg viewBox="0 0 4 4"><rect/>')])).toEqual([])
    // 开了两次却只闭合一次：只有闭合的那一段成图
    const figures = listAdoptableFigures([said(`${fence(svg('Closed'))}\n\`\`\`svg\n<svg/>`)])
    expect(figures.map((f) => f.title)).toEqual(['Closed'])
  })

  it('AD-9 空围栏体跳过（不写出一个 0 字节的 artifact）', () => {
    expect(listAdoptableFigures([said('```svg\n\n```')])).toEqual([])
    expect(listAdoptableFigures([said('```svg\n   \n```')])).toEqual([])
  })

  it('AD-10 非 svg 语言围栏里的 `<svg>` 不被认领', () => {
    const msgs = [
      said(fence(svg('AsXml'), { lang: 'xml' }), 'a1'),
      said(fence(svg('AsHtml'), { lang: 'html' }), 'a2'),
      said(fence(svg('Bare'), { lang: '' }), 'a3')
    ]
    expect(listAdoptableFigures(msgs)).toEqual([])
  })

  it('AD-11 大写 ```SVG 不被认领（与 CodeBlock 只分发小写 `svg` 同宽）', () => {
    // 带 `i` 的话，adopt 会认领一个用户看到的其实是普通代码块的东西
    expect(listAdoptableFigures([said(fence(svg('Upper'), { lang: 'SVG' }))])).toEqual([])
    expect(listAdoptableFigures([said(fence(svg('Mixed'), { lang: 'Svg' }))])).toEqual([])
  })

  it('AD-12 CRLF 与缩进围栏照样认领', () => {
    const crlf = listAdoptableFigures([said(fence(svg('Crlf'), { eol: '\r\n' }))])
    expect(crlf.map((f) => f.title)).toEqual(['Crlf'])
    const indented = listAdoptableFigures([said(fence(svg('Indented'), { indent: '  ' }))])
    expect(indented.map((f) => f.title)).toEqual(['Indented'])
  })

  it('AD-13 连续调用两次结果相同（模块级 /g 正则不带状态过去）', () => {
    const msgs = [said(`${fence(svg('One'))}\n${fence(svg('Two'))}`)]
    expect(listAdoptableFigures(msgs)).toEqual(listAdoptableFigures(msgs))
    expect(listAdoptableFigures(msgs)).toHaveLength(2)
  })

  it('AD-14 空转写 / 没有围栏的转写 ⇒ []', () => {
    expect(listAdoptableFigures([])).toEqual([])
    expect(listAdoptableFigures([said('纯散文，没有图。'), user('也是')])).toEqual([])
  })
})

describe('figureArtifactName —— 幂等的钥匙', () => {
  it('AD-15 同一标题恒得同一个文件名（认领两次才能命中既有那件）', () => {
    expect(figureArtifactName('Requests by tier')).toBe('requests-by-tier.svg')
    expect(figureArtifactName('Requests by tier')).toBe(figureArtifactName('Requests by tier'))
    expect(figureArtifactName('各档请求量')).toBe('各档请求量.svg')
    expect(figureArtifactName('***')).toBe('artifact.svg')
  })
})

describe('adoptFigure —— ref 语义', () => {
  const three = (): ChatMessage[] => [
    said(`${fence(svg('One'))}\n${fence(svg('Two'))}\n${fence(svg('Three'))}`)
  ]

  it('AD-16 缺省取最后一张（「把刚才那张图改一下」的常态）', () => {
    const sid = newSession()
    const got = adoptFigure({ sessionId: sid, messages: three() })
    expect(got?.figure.title).toBe('Three')
    expect(got?.existing).toBe(false)
    expect(readFileSync(got!.artifact.path, 'utf-8')).toBe(svg('Three'))
    expect(adoptFigure({ sessionId: sid, messages: three(), ref: '   ' })?.figure.title).toBe(
      'Three'
    )
  })

  it('AD-17 纯数字 ref 按 index；越界 ⇒ null', () => {
    const sid = newSession()
    expect(adoptFigure({ sessionId: sid, messages: three(), ref: '2' })?.figure.title).toBe('Two')
    expect(adoptFigure({ sessionId: sid, messages: three(), ref: '4' })).toBeNull()
    expect(adoptFigure({ sessionId: sid, messages: three(), ref: '0' })).toBeNull()
  })

  it('AD-18 文本 ref 按 includes 且大小写不敏感', () => {
    const sid = newSession()
    const messages = [said(fence(svg('Requests by tier')))]
    expect(adoptFigure({ sessionId: sid, messages, ref: 'BY TIER' })?.figure.title).toBe(
      'Requests by tier'
    )
    expect(adoptFigure({ sessionId: sid, messages, ref: 'tier' })?.figure.title).toBe(
      'Requests by tier'
    )
  })

  it('AD-19 同名时后出现的优先（用户说的几乎总是最近那张）', () => {
    const sid = newSession()
    const messages = [
      said(`${fence(svg('Latency'))}\n${fence(svg('Latency'))}`, 'a1'),
      said(fence(svg('Latency')), 'a2')
    ]
    expect(adoptFigure({ sessionId: sid, messages, ref: 'latency' })?.figure.index).toBe(3)
  })

  it('AD-20 匹配不上 ⇒ null 且一个文件都没落盘', () => {
    const sid = newSession()
    expect(adoptFigure({ sessionId: sid, messages: three(), ref: 'nope' })).toBeNull()
    expect(entries(sid)).toBeNull()
    // 转写里根本没有图时同样如此（目录连建都没建）
    const empty = newSession()
    expect(adoptFigure({ sessionId: empty, messages: [said('没有图')] })).toBeNull()
    expect(existsSync(join(state.root, empty))).toBe(false)
  })
})

describe('adoptFigure —— 幂等（主线场景第二轮的全部依赖）', () => {
  it('AD-21 再认领同一张 ⇒ existing: true、同一路径、目录里只有一件，且编辑被保留', () => {
    const sid = newSession()
    const messages = [said(fence(svg('Bar chart')))]

    const first = adoptFigure({ sessionId: sid, messages })
    expect(first?.existing).toBe(false)
    // 模型随后用 `edit` 改矮一根柱子（外科手术式，不重画）
    const edited = `${svg('Bar chart')}\n<!-- edited -->`
    writeFileSync(first!.artifact.path, edited, 'utf-8')

    const second = adoptFigure({ sessionId: sid, messages })
    expect(second?.existing).toBe(true)
    expect(second?.artifact.path).toBe(first?.artifact.path)
    expect(second?.artifact.name).toBe(first?.artifact.name)
    // 新建的话这里会是 ['bar-chart-2.svg', 'bar-chart.svg']，且 -2 里是转写的原始源码
    expect(entries(sid)).toEqual(['bar-chart.svg'])
    expect(readFileSync(second!.artifact.path, 'utf-8')).toBe(edited)
  })

  it('AD-22 幂等按**标题派生的文件名**判，与 ref 的写法无关', () => {
    const sid = newSession()
    const messages = [said(`${fence(svg('One'))}\n${fence(svg('Two'))}`)]
    const byDefault = adoptFigure({ sessionId: sid, messages })
    expect(byDefault?.figure.title).toBe('Two')
    for (const ref of ['2', 'two', 'TWO']) {
      const again = adoptFigure({ sessionId: sid, messages, ref })
      expect([ref, again?.existing]).toEqual([ref, true])
      expect(again?.artifact.path).toBe(byDefault?.artifact.path)
    }
    expect(entries(sid)).toEqual(['two.svg'])
  })

  it('AD-23 标题相同但内容不同的两张图会共用一件（幂等的代价，钉住现状）', () => {
    // 幂等的钥匙是**标题**，所以同名两张图认领第二张时拿回的是第一张那件。
    // 这是刻意的取舍（消歧靠 index，list 也不再把已认领的列为可认领）—— 写在这里
    // 是为了让「改成按内容判」的人先看见它被钉住过
    const sid = newSession()
    const a = '<svg aria-label="Same">A</svg>'
    const b = '<svg aria-label="Same">B</svg>'
    const messages = [said(`${fence(a)}\n${fence(b)}`)]
    const first = adoptFigure({ sessionId: sid, messages, ref: '1' })
    expect(readFileSync(first!.artifact.path, 'utf-8')).toBe(a)
    const second = adoptFigure({ sessionId: sid, messages, ref: '2' })
    expect(second?.existing).toBe(true)
    expect(second?.artifact.path).toBe(first?.artifact.path)
    expect(entries(sid)).toEqual(['same.svg'])
  })
})

// ─── ```interactive 交互块 ─────────────────────────────────────────────────────

/** 一块带标题的交互图（开头的 <title> 就是它的名字） */
const block = (title: string, extra = ''): string =>
  `<title>${title}</title>\n<p id="out"></p>\n<script>\n  document.getElementById('out').textContent = '${title}'${extra}\n</script>`

/** html artifact 开头那一行（与沙箱的 SANDBOX_CSP 同一条）—— 按契约自己拼 */
const CSP_LINE = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`

const interactive = (body: string, opts: { indent?: string; eol?: string } = {}): string =>
  fence(body, { ...opts, lang: 'interactive' })

describe('```interactive —— 与 ```svg 走同一条认领路', () => {
  it('AD-24 一块交互图可以认领：title 取开头的 <title>，source 已 trim，kind 是 interactive', () => {
    const figures = listAdoptableFigures([said(`看：\n${interactive(`\n${block('Growth')}\n`)}`)])
    expect(figures).toEqual([
      { title: 'Growth', index: 1, source: block('Growth'), kind: 'interactive' }
    ])
  })

  it('AD-25 svg 与交互图混排、跨消息：index 连续，kind 各自对得上', () => {
    const figures = listAdoptableFigures([
      said(`${fence(svg('One'))}\n散文\n${interactive(block('Two'))}`, 'a1'),
      said(fence(svg('Three')), 'a2')
    ])
    expect(figures.map((f) => [f.index, f.title, f.kind])).toEqual([
      [1, 'One', 'svg'],
      [2, 'Two', 'interactive'],
      [3, 'Three', 'svg']
    ])
  })

  it('AD-26 与渲染器同宽：大小写变体 / ```html / 没闭合 / 用户消息里的都不算；语言串后有空格、缩进、CRLF 照样算', () => {
    for (const msg of [
      said(fence(block('Cap'), { lang: 'Interactive' })),
      said(fence(block('Upper'), { lang: 'INTERACTIVE' })),
      said(fence(block('Html'), { lang: 'html' })),
      said(`\`\`\`interactive\n${block('Open')}`),
      user(interactive(block('Pasted')))
    ]) {
      expect(listAdoptableFigures([msg]), msg.content.slice(0, 40)).toEqual([])
    }
    const trailing = listAdoptableFigures([
      said(`\`\`\`interactive   \n${block('Spaced')}\n\`\`\``)
    ])
    expect(trailing.map((f) => [f.title, f.kind])).toEqual([['Spaced', 'interactive']])
    const indented = listAdoptableFigures([said(interactive(block('Indented'), { indent: '  ' }))])
    expect(indented.map((f) => f.title)).toEqual(['Indented'])
    const crlf = listAdoptableFigures([said(interactive(block('Crlf'), { eol: '\r\n' }))])
    expect(crlf.map((f) => f.title)).toEqual(['Crlf'])
  })

  it('AD-27 文件名按种类：interactive → .html；缺省种类仍是 .svg', () => {
    expect(figureArtifactName('Growth', 'interactive')).toBe('growth.html')
    expect(figureArtifactName('Growth', 'svg')).toBe('growth.svg')
    expect(figureArtifactName('Growth')).toBe('growth.svg')
  })

  it('AD-28 名字取这一块自己开头的 <title>，块里那张 SVG 的 aria-label 抢不走', () => {
    const sid = newSession()
    const source =
      '<title>Dashboard</title>\n<svg viewBox="0 0 4 4" role="img" aria-label="Bars"><rect/></svg>'
    const messages = [said(interactive(source))]
    expect(listAdoptableFigures(messages).map((f) => f.title)).toEqual(['Dashboard'])
    const got = adoptFigure({ sessionId: sid, messages })
    expect(got?.figure.title).toBe('Dashboard')
    expect(got?.artifact.name).toBe('dashboard.html')
  })

  it('AD-29 认领交互图 → 新建 growth.html，文件 = CSP 那一行 + 换行 + 转写里的源码', () => {
    const sid = newSession()
    const got = adoptFigure({ sessionId: sid, messages: [said(interactive(block('Growth')))] })
    expect(got?.existing).toBe(false)
    expect(got?.figure.kind).toBe('interactive')
    expect(got?.artifact.name).toBe('growth.html')
    expect(readFileSync(got!.artifact.path, 'utf-8')).toBe(`${CSP_LINE}\n${block('Growth')}`)
    expect(entries(sid)).toEqual(['growth.html'])
  })

  it('AD-30 再认领 → existing: true、同一件、字节不动（手改过也不动），不会冒出 growth-2.html', () => {
    const sid = newSession()
    const messages = [said(interactive(block('Growth')))]
    const first = adoptFigure({ sessionId: sid, messages })
    const again = adoptFigure({ sessionId: sid, messages })
    expect(again?.existing).toBe(true)
    expect(again?.artifact.name).toBe(first?.artifact.name)
    expect(readFileSync(again!.artifact.path, 'utf-8')).toBe(`${CSP_LINE}\n${block('Growth')}`)

    const edited = `${CSP_LINE}\n${block('Growth', ' + " (edited)"')}`
    writeFileSync(first!.artifact.path, edited, 'utf-8')
    const third = adoptFigure({ sessionId: sid, messages })
    expect(third?.existing).toBe(true)
    expect(readFileSync(third!.artifact.path, 'utf-8')).toBe(edited)
    expect(entries(sid)).toEqual(['growth.html'])
  })

  it('AD-31 幂等按种类分开：同名的 svg 已认领，再认领同名交互图得 growth.html（不是 growth-2.svg），反过来也一样', () => {
    const sid = newSession()
    const svgFirst = [said(`${fence(svg('Growth'))}\n${interactive(block('Growth'))}`)]
    expect(adoptFigure({ sessionId: sid, messages: svgFirst, ref: '1' })?.artifact.name).toBe(
      'growth.svg'
    )
    const html = adoptFigure({ sessionId: sid, messages: svgFirst, ref: '2' })
    expect([html?.existing, html?.artifact.name]).toEqual([false, 'growth.html'])
    expect(entries(sid)).toEqual(['growth.html', 'growth.svg'])

    const other = newSession()
    const htmlFirst = [said(`${interactive(block('Growth'))}\n${fence(svg('Growth'))}`)]
    expect(adoptFigure({ sessionId: other, messages: htmlFirst, ref: '1' })?.artifact.name).toBe(
      'growth.html'
    )
    const svgAfter = adoptFigure({ sessionId: other, messages: htmlFirst, ref: '2' })
    expect([svgAfter?.existing, svgAfter?.artifact.name]).toEqual([false, 'growth.svg'])
    expect(entries(other)).toEqual(['growth.html', 'growth.svg'])
  })

  it('AD-32 ref 跨种类选：按标题取最近那张（哪种都算）；数字按序号；不给取最后一张', () => {
    const svgThenBlock = [said(`${fence(svg('Growth'))}\n${interactive(block('Growth'))}`)]
    const blockThenSvg = [said(`${interactive(block('Growth'))}\n${fence(svg('Growth'))}`)]
    const pick = (messages: ChatMessage[], ref?: string): [number, string] | undefined => {
      const got = adoptFigure({ sessionId: newSession(), messages, ref })
      return got ? [got.figure.index, got.figure.kind] : undefined
    }
    expect(pick(svgThenBlock, 'growth')).toEqual([2, 'interactive'])
    expect(pick(blockThenSvg, 'growth')).toEqual([2, 'svg'])
    expect(pick(svgThenBlock, '1')).toEqual([1, 'svg'])
    expect(pick(blockThenSvg, '1')).toEqual([1, 'interactive'])
    expect(pick(svgThenBlock)).toEqual([2, 'interactive'])
    expect(pick(blockThenSvg)).toEqual([2, 'svg'])
  })

  it('AD-33 没有 <title> 的交互块：标题回落 figure-<它在整场里的序号>，文件 figure-N.html；再认领幂等', () => {
    const sid = newSession()
    const untitled =
      '<div id="x"></div>\n<script>\n  document.getElementById("x").textContent = 1\n</script>'
    const messages = [said(`${fence(svg('One'))}\n${interactive(untitled)}`)]
    expect(listAdoptableFigures(messages).map((f) => [f.title, f.kind])).toEqual([
      ['One', 'svg'],
      ['figure-2', 'interactive']
    ])
    const first = adoptFigure({ sessionId: sid, messages })
    expect([first?.existing, first?.artifact.name]).toEqual([false, 'figure-2.html'])
    const again = adoptFigure({ sessionId: sid, messages })
    expect([again?.existing, again?.artifact.name]).toEqual([true, 'figure-2.html'])
    expect(entries(sid)).toEqual(['figure-2.html'])
  })
})
