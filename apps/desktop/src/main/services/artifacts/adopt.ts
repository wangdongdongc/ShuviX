/**
 * 认领（adopt）—— 把对话里一张已经画出来的 ```svg 图变成可反复修改的 artifact。
 *
 * **这条路存在的全部理由是：模型一个字都不用重发。** 源码已经在会话转写里，宿主直接取出来
 * 写盘即可 —— 于是「作画」可以永远走 ```svg 围栏（流式逐帧画、长在散文里、不落盘），
 * 而「要改了」才付出一次文件拷贝的代价。
 *
 * 为什么不让模型在动笔前就决定用不用 artifact：那要预测未来。「这张图以后会不会被改」
 * 只有用户知道，而且是**看到图之后**才知道；逼模型猜，它会为保险起见都选 artifact，
 * 于是每张图都失去逐帧画，而多数图是看一眼就结束的。
 *
 * **边界（已核实）**：投影走 `buildContextEntries()`，是压缩过滤过的，所以被压缩掉的图
 * 认领不到。这不是缺陷而是自洽 —— 那些消息在界面上也已经被一张摘要卡取代了，
 * 认领一张用户已经看不见的图才是怪事。
 */
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { slugify } from '@shuvix/agent-runtime'
import { findArtifact, titleOf, writeArtifact, type ArtifactInfo } from './store'

/** 转写里一张可被认领的图 */
export interface AdoptableFigure {
  /** 从 aria-label / <title> 取的标题（模型按它指名） */
  title: string
  /** 在整场会话里的出现序号，1 起（标题重名时的消歧钥匙） */
  index: number
  source: string
}

/**
 * ```svg 围栏。三处宽容度都是刻意的：
 *  - **只认已闭合的**：半截的本就不成图（流式被打断是常态，认领半张图会写出坏文件）。
 *  - **语言串大小写敏感**：与 CodeBlock 的分发同宽（那边只认小写，svgFence.test.ts 已把
 *    这点钉成契约）。带 `i` 会让 adopt 认领一个用户看到的其实是普通代码块的东西。
 *  - 容忍围栏缩进与 CRLF。
 */
const SVG_FENCE_RE = /^[ \t]*```[ \t]*svg[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gm

/**
 * 扫出转写里所有可认领的图 —— 按出现顺序，最后一张在数组末尾。
 * 只看助手消息：用户贴进来的 SVG 不是这场对话的产物，不该被当成 artifact 认领。
 */
export function listAdoptableFigures(messages: readonly ChatMessage[]): AdoptableFigure[] {
  const out: AdoptableFigure[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const text = typeof msg.content === 'string' ? msg.content : ''
    if (!text) continue
    for (const m of text.matchAll(SVG_FENCE_RE)) {
      const source = m[1].trim()
      if (!source) continue
      out.push({
        title: titleOf(source, `figure-${out.length + 1}`),
        index: out.length + 1,
        source
      })
    }
  }
  return out
}

/** 一张图认领后会落成的文件名 —— 幂等的钥匙（同一标题恒得同一个名字） */
export function figureArtifactName(title: string): string {
  return `${slugify(title, 'artifact')}.svg`
}

/**
 * 认领一张：`ref` 给标题或序号，缺省取**最近一张**（「把刚才那张图改一下」的常态）。
 * 找不到返回 null，调用方负责把可选项报回给模型。
 *
 * **幂等**：这张图已经认领过就把既有那件原样交回（`existing: true`），绝不新建。
 * 不这么做的话，设计文档自己的主线场景走到第二轮就坏：画图 → 认领 → edit 改矮一根柱子 →
 * 用户「再改一下」→ 模型又认领同一张 → 拿到一个 `-2` 文件，内容是**转写里的原始源码**，
 * 第一次的编辑就此分叉丢失，而新发的引用展示的是未编辑版 —— 用户看到的是「我的修改被撤销了」。
 */
export function adoptFigure(params: {
  sessionId: string
  messages: readonly ChatMessage[]
  ref?: string
}): { artifact: ArtifactInfo; figure: AdoptableFigure; existing: boolean } | null {
  const figures = listAdoptableFigures(params.messages)
  if (figures.length === 0) return null

  const ref = params.ref?.trim()
  let figure: AdoptableFigure | undefined
  if (!ref) {
    figure = figures[figures.length - 1]
  } else if (/^\d+$/.test(ref)) {
    figure = figures.find((f) => f.index === Number(ref))
  } else {
    const wanted = ref.toLowerCase()
    // 后出现的优先：同名时用户说的几乎总是最近那张
    figure = [...figures].reverse().find((f) => f.title.toLowerCase().includes(wanted))
  }
  if (!figure) return null

  const already = findArtifact(params.sessionId, figureArtifactName(figure.title))
  if (already) return { artifact: already, figure, existing: true }

  const artifact = writeArtifact({
    sessionId: params.sessionId,
    title: figure.title,
    ext: 'svg',
    content: figure.source
  })
  return { artifact, figure, existing: false }
}
