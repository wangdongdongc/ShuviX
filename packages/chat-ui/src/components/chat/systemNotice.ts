/**
 * 后台完成通知的一行摘要。
 *
 * 通知正文是主进程写给**模型**看的（`<background-task …>` / `<sub-session …>` 标签包着
 * 若干行），直接把首行摆到摘要位就是一截尖括号标签。这里按标签宽松地解出
 * 命令 / 状态 / 时长（后台任务）或 标题 / 状态（子会话），拼成人读的一句；认不出的
 * 格式退回首个非空行。几件事在同一合并窗口里一起完成时通知会拼成一条下发，逐条各出一句。
 *
 * 只做「够看」的解析，不做校验：文案格式属于桌面主进程（bgTaskService / subSessionRunner），
 * 这里改动滞后时最坏也只是摘要退回首行 —— 原文原样还在展开态里。
 */
import { systemNoticeBlockRe } from '@shuvix/chat-protocol/systemNoticeContract'
import { clipLine } from '../../utils/clipLine'

export interface SystemNoticeSummary {
  kind: 'background-task' | 'sub-session' | 'unknown'
  text: string
}

const ATTR_RE = /([\w-]+)="([^"]*)"/g
/** 单句上限 —— 行内还要给标签与其他句子留位置 */
const MAX_LEN = 80
/**
 * 命令 / 标题自己的上限：状态与时长是这句里最要紧的部分（「成没成」），
 * 一条长命令不能把它们挤出行尾 —— 所以先裁命令，再拼状态。
 */
const HEAD_LEN = 48

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(ATTR_RE)) out[m[1]] = m[2]
  return out
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  )
}

export function summarizeSystemNotice(content: string): SystemNoticeSummary[] {
  const out: SystemNoticeSummary[] = []
  // 标签表与投影层认通知的那份是同一份（chat-protocol 的 systemNoticeContract）
  for (const m of content.matchAll(systemNoticeBlockRe())) {
    const [, tag, rawAttrs, inner] = m
    const attrs = attrsOf(rawAttrs)
    if (tag === 'background-task') {
      // 标签后的第一行是命令本身（见 bgTaskService.formatExitNotice）
      const head = clipLine(firstLine(inner), HEAD_LEN)
      const parts = [head, attrs.status, attrs.duration].filter(Boolean)
      out.push({ kind: 'background-task', text: clipLine(parts.join(' · '), MAX_LEN) })
    } else {
      // 标题缺失时退到 id，再退到正文首行 —— 一条通知不该在摘要位上是空白
      const head = clipLine(attrs.title || attrs.id || firstLine(inner), HEAD_LEN)
      const parts = [head, attrs.status].filter(Boolean)
      out.push({ kind: 'sub-session', text: clipLine(parts.join(' · '), MAX_LEN) })
    }
  }
  if (out.length === 0) {
    const line = firstLine(content)
    if (line) out.push({ kind: 'unknown', text: clipLine(line, MAX_LEN) })
  }
  return out
}
