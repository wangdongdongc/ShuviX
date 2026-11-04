/**
 * TokenChip 展示层纯逻辑：
 *   - tokenKind：at 按 id 的 `knowledge:` 前缀细分 文件 / 知识库；
 *   - splitTokenTitle：displayText 按第一个 `:` 切分（prefix 含冒号；消歧后缀 ` (kb-b)` 归标题；
 *     prefix + title 逐字等于原串 —— 镜像层两段 span 拼接对齐的根基）；
 *   - tokenTitle / tokenSourcePath / payloadPreview；
 *   - TD-1 会话引用与发送方：会话引用同时看 id 前缀与 payload（文件路径也可能以 `session:` 开头）；标题去前缀、冒号保留；
 *     来源是裸 id；发送方标题是 name，没有 name 是空串。
 */
import { describe, expect, it } from 'vitest'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { midRunNoteToken } from '@shuvix/chat-protocol/midRunNote'
import { sessionSenderToken } from '@shuvix/chat-protocol/sessionSender'
import { buildAtToken } from '@shuvix/chat-protocol/utils/inlineTokens'
import {
  payloadPreview,
  splitTokenTitle,
  tokenKind,
  tokenSourcePath,
  tokenTitle
} from './tokenDisplay'

const fileToken: InlineToken = {
  type: 'at',
  id: 'docs/alpha-guide.md',
  displayText: 'alpha-guide.md',
  payload: '[workspace file: docs/alpha-guide.md]',
  name: 'alpha-guide.md'
}

const knowledgeToken: InlineToken = {
  type: 'at',
  id: 'knowledge:knowledge/kb-b/token-refresh.md',
  displayText: 'knowledge:Token 刷新 (kb-b)',
  payload: '[knowledge entry: base kb-b, path /token-refresh.md — Token 刷新]',
  name: 'Token 刷新'
}

describe('tokenKind', () => {
  it('cmd / paste 直取 type', () => {
    expect(tokenKind({ ...fileToken, type: 'cmd' })).toBe('cmd')
    expect(tokenKind({ ...fileToken, type: 'paste' })).toBe('paste')
  })

  it('at 按 id 前缀细分 文件 / 知识库', () => {
    expect(tokenKind(fileToken)).toBe('file')
    expect(tokenKind(knowledgeToken)).toBe('knowledge')
  })

  it('未知类型归 other', () => {
    expect(tokenKind({ ...fileToken, type: 'bot' })).toBe('other')
  })

  it('TK-1: 插话说明 Token 归 note —— 只认 type + id，id 不对 / type 不对按原规则分', () => {
    expect(tokenKind(midRunNoteToken())).toBe('note')
    expect(tokenKind({ type: 'note', id: 'x', displayText: '', payload: '' })).toBe('other')
    expect(tokenKind({ type: 'at', id: 'mid-run', displayText: 'a', payload: '' })).toBe('file')
    expect(tokenKind({ type: 'cmd', id: 'mid-run', displayText: '/a', payload: '' })).toBe('cmd')
    expect(tokenKind({ type: 'paste', id: 'mid-run', displayText: 'p', payload: '' })).toBe('paste')
  })
})

describe('splitTokenTitle —— displayText 按第一个 `:` 切分', () => {
  it('prefix 含冒号，title 为其余部分，且拼接后逐字等于原串', () => {
    const { prefix, title } = splitTokenTitle('knowledge:Token 刷新')
    expect(prefix).toBe('knowledge:')
    expect(title).toBe('Token 刷新')
    expect(prefix + title).toBe('knowledge:Token 刷新')
  })

  it('消歧后缀 ` (kb-b)` 视为标题一部分', () => {
    const { prefix, title } = splitTokenTitle('knowledge:Token 刷新 (kb-b)')
    expect(prefix).toBe('knowledge:')
    expect(title).toBe('Token 刷新 (kb-b)')
  })

  it('镜像层场景：带 `@` 的原始子串同样按第一个 `:` 切（前缀段即 `@knowledge:`）', () => {
    const { prefix, title } = splitTokenTitle('@knowledge:Token 刷新 (kb-b)')
    expect(prefix).toBe('@knowledge:')
    expect(title).toBe('Token 刷新 (kb-b)')
    expect(prefix + title).toBe('@knowledge:Token 刷新 (kb-b)')
  })

  it('标题自身再含 `:` 不误切（只认第一个）', () => {
    const { prefix, title } = splitTokenTitle('knowledge:时间: 与历法')
    expect(prefix).toBe('knowledge:')
    expect(title).toBe('时间: 与历法')
  })

  it('无 `:` 时整体为标题、prefix 为空', () => {
    expect(splitTokenTitle('alpha-guide.md')).toEqual({ prefix: '', title: 'alpha-guide.md' })
  })
})

describe('tokenTitle', () => {
  it('at 知识：去 `knowledge:` 前缀（消歧后缀保留在标题里）', () => {
    expect(tokenTitle(knowledgeToken)).toBe('Token 刷新 (kb-b)')
  })

  it('at 文件 / cmd / paste：标题即 displayText', () => {
    expect(tokenTitle(fileToken)).toBe('alpha-guide.md')
    expect(tokenTitle({ ...fileToken, type: 'cmd', displayText: '/review' })).toBe('/review')
  })
})

describe('tokenSourcePath', () => {
  it('at 文件 = 相对路径（id）；cmd = 命令 id', () => {
    expect(tokenSourcePath(fileToken)).toBe('docs/alpha-guide.md')
    expect(tokenSourcePath({ ...fileToken, type: 'cmd', id: 'review' })).toBe('review')
  })

  it('at 知识 = 条目 id（去 `knowledge:` 前缀）', () => {
    expect(tokenSourcePath(knowledgeToken)).toBe('knowledge/kb-b/token-refresh.md')
  })

  it('paste / 未知类型无来源路径', () => {
    expect(tokenSourcePath({ ...fileToken, type: 'paste' })).toBeUndefined()
    expect(tokenSourcePath({ ...fileToken, type: 'bot' })).toBeUndefined()
  })
})

describe('payloadPreview', () => {
  it('不足 3 行原样返回', () => {
    expect(payloadPreview('a\nb')).toBe('a\nb')
  })

  it('超 3 行截断并补省略行', () => {
    expect(payloadPreview('a\nb\nc\nd')).toBe('a\nb\nc\n…')
  })

  it('单行超长按字符截断', () => {
    const long = 'x'.repeat(300)
    const preview = payloadPreview(long)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.length).toBeLessThanOrEqual(241)
  })
})

describe('TD-1 会话引用与发送方', () => {
  const sessionToken = buildAtToken({ kind: 'session', sessionId: 'sid-1', title: '修: 复 bug' })

  it('buildAtToken({kind: session}) 判 session', () => {
    expect(tokenKind(sessionToken)).toBe('session')
  })

  it('tokenTitle 去前缀，标题里的 `:` 保留', () => {
    expect(sessionToken.displayText).toBe('session:修: 复 bug')
    expect(tokenTitle(sessionToken)).toBe('修: 复 bug')
  })

  it('tokenSourcePath 是裸 id', () => {
    expect(tokenSourcePath(sessionToken)).toBe('sid-1')
  })

  it('id 以 session: 开头的文件引用（file / path 两种 payload）判 file，标题与路径原样', () => {
    const file = buildAtToken({ kind: 'file', rel: 'session:notes.md', base: 'session:notes.md' })
    expect(file.payload.startsWith('[workspace file:')).toBe(true)
    expect(tokenKind(file)).toBe('file')
    expect(tokenTitle(file)).toBe('session:notes.md')
    expect(tokenSourcePath(file)).toBe('session:notes.md')

    const path = buildAtToken({ kind: 'path', path: 'session:notes.md', base: 'session:notes.md' })
    expect(path.payload.startsWith('[file:')).toBe(true)
    expect(tokenKind(path)).toBe('file')
    expect(tokenTitle(path)).toBe('session:notes.md')
    expect(tokenSourcePath(path)).toBe('session:notes.md')
  })

  it('发送方判 sender，标题是 name，来源是 id；没有 name 标题是空串', () => {
    const sender = sessionSenderToken({ kind: 'session', sessionId: 'sid-2', title: '修: 复' })
    expect(tokenKind(sender)).toBe('sender')
    expect(tokenTitle(sender)).toBe('修: 复')
    expect(tokenSourcePath(sender)).toBe('sid-2')
    const { name: _name, ...bare } = sender
    expect(tokenKind(bare)).toBe('sender')
    expect(tokenTitle(bare)).toBe('')
    expect(tokenSourcePath(bare)).toBe('sid-2')
  })
})
