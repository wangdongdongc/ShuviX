import { describe, it, expect } from 'vitest'
import type { InlineToken } from '../types/chatMessage'
import { baseNameFromEntryPath } from '../knowledge'
import {
  atTokenRef,
  buildAtToken,
  buildPasteToken,
  makeTokenMarker,
  mentionRefId,
  parseSlashCommandInput,
  rebuildDraftFromContent,
  resolveTokensForAgent,
  resolveTokensForCopy,
  segmentContent
} from './inlineTokens'

const atToken: InlineToken = {
  type: 'at',
  id: 'src/foo.ts',
  displayText: 'foo.ts',
  payload: '[workspace file: src/foo.ts]',
  name: 'foo.ts'
}

const pasteToken: InlineToken = buildPasteToken({
  payload: 'line1\nline2\nline3',
  displayText: '[粘贴文本 #1 · 3 行]',
  seq: 1,
  name: '粘贴文本 #1'
})

describe('buildAtToken —— 按 ref 分派 payload', () => {
  it('文件 ref：与存量 token 逐字一致（零迁移）', () => {
    expect(buildAtToken({ kind: 'file', rel: 'src/foo.ts', base: 'foo.ts' })).toEqual(atToken)
  })

  it('知识库 ref：payload 为 knowledge 工具指针（base + bundle 相对路径 + 标题）', () => {
    const token = buildAtToken({
      kind: 'knowledge',
      entryPath: 'knowledge/notes/auth/token-refresh.md',
      baseName: 'notes',
      bundlePath: '/auth/token-refresh.md',
      title: 'Token 刷新'
    })
    expect(token).toEqual({
      type: 'at',
      id: 'knowledge:knowledge/notes/auth/token-refresh.md',
      displayText: 'knowledge:Token 刷新',
      payload: '[knowledge entry: base notes, path /auth/token-refresh.md — Token 刷新]',
      name: 'Token 刷新'
    })
  })

  it('displayText 覆盖：消歧后缀随 token 存活（草稿回填逐字恢复）', () => {
    const token = buildAtToken(
      {
        kind: 'knowledge',
        entryPath: 'knowledge/work/配置中心.md',
        baseName: 'work',
        bundlePath: '/配置中心.md',
        title: '配置中心'
      },
      'knowledge:配置中心 (work)'
    )
    expect(token.displayText).toBe('knowledge:配置中心 (work)')
  })
})

describe('atTokenRef —— 从持久化 token 反推实体引用', () => {
  it('存量文件 token → file ref（id=相对路径，displayText=文件名）', () => {
    expect(atTokenRef(atToken)).toEqual({ kind: 'file', rel: 'src/foo.ts', base: 'foo.ts' })
  })

  it('知识库 token → knowledge ref（base/path 从条目 id 派生，发送时能重建等价 payload）', () => {
    const ref = {
      kind: 'knowledge' as const,
      entryPath: 'projects/p1/架构.md',
      baseName: 'project',
      bundlePath: '/架构.md',
      title: '架构'
    }
    const token = buildAtToken(ref, 'knowledge:架构 (项目A)')
    const back = atTokenRef(token)
    expect(back).toEqual(ref)
    // 反推的 ref 重建 payload 与原始 token 一致（displayText 照旧由调用方带）
    expect(buildAtToken(back, token.displayText).payload).toBe(token.payload)
  })

  it('payload 不是知识库指针的一律按文件 token 处理（哪怕 id 带 knowledge: 前缀）', () => {
    const weird: InlineToken = {
      type: 'at',
      id: 'knowledge:foo.ts',
      displayText: 'knowledge:foo.ts',
      payload: '[workspace file: knowledge:foo.ts]'
    }
    expect(atTokenRef(weird)).toEqual({
      kind: 'file',
      rel: 'knowledge:foo.ts',
      base: 'knowledge:foo.ts'
    })
  })
})

describe('mentionRefId —— 实体稳定标识', () => {
  it('文件用相对路径；知识条目用 `knowledge:` + 条目 id（两者不撞名）', () => {
    expect(mentionRefId({ kind: 'file', rel: 'a.ts', base: 'a.ts' })).toBe('a.ts')
    expect(
      mentionRefId({
        kind: 'knowledge',
        entryPath: 'knowledge/n/x.md',
        baseName: 'n',
        bundlePath: '/x.md',
        title: 'x'
      })
    ).toBe('knowledge:knowledge/n/x.md')
  })
})

describe('baseNameFromEntryPath —— 条目 id → 工具指针', () => {
  it('三类库名映射 + bundle 相对路径', () => {
    expect(baseNameFromEntryPath('knowledge/notes/auth/token-refresh.md')).toEqual({
      baseName: 'notes',
      bundlePath: '/auth/token-refresh.md'
    })
    expect(baseNameFromEntryPath('projects/p1/架构.md')).toEqual({
      baseName: 'project',
      bundlePath: '/架构.md'
    })
    expect(baseNameFromEntryPath('builtin/shuvix/agents.md')).toEqual({
      baseName: 'shuvix',
      bundlePath: '/agents.md'
    })
  })

  it('落不进任何形态（未知容器 / 只到库没有文件）返回 null', () => {
    expect(baseNameFromEntryPath('elsewhere/n/x.md')).toBeNull()
    expect(baseNameFromEntryPath('knowledge/notes')).toBeNull()
  })
})

describe('buildPasteToken', () => {
  it('构造 paste 类型 token', () => {
    expect(pasteToken).toEqual({
      type: 'paste',
      id: 'paste-1',
      displayText: '[粘贴文本 #1 · 3 行]',
      payload: 'line1\nline2\nline3',
      name: '粘贴文本 #1'
    })
  })
})

describe('parseSlashCommandInput', () => {
  const commands = [
    { commandId: 'review', name: 'review', template: 'Review this: $ARGUMENTS' },
    { commandId: 'explore', name: 'Explore', template: '', kind: 'agent' }
  ]

  it('普通命令构造 cmd token（payload 为展开模板）', () => {
    const r = parseSlashCommandInput('/review src/foo.ts', commands)
    expect(r?.command.commandId).toBe('review')
    expect(r?.inlineTokens['t0'].payload).toBe('Review this: src/foo.ts')
  })

  it("kind='agent' 的派发命令不构造 cmd token（视为未匹配，由派发链路在上游处理）", () => {
    expect(parseSlashCommandInput('/explore find the auth code', commands)).toBeNull()
  })

  it('未知命令返回 null', () => {
    expect(parseSlashCommandInput('/nope xxx', commands)).toBeNull()
  })
})

describe('resolveTokensForAgent', () => {
  it('无 tokens 时原样返回', () => {
    expect(resolveTokensForAgent('hello')).toBe('hello')
    expect(resolveTokensForAgent('hello', {})).toBe('hello')
  })

  it('at / paste 类型就地替换为 payload，保留周围文本', () => {
    const content = `看下 ${makeTokenMarker('a0')} 和这段：${makeTokenMarker('p0')} 谢谢`
    const out = resolveTokensForAgent(content, { a0: atToken, p0: pasteToken })
    expect(out).toBe('看下 [workspace file: src/foo.ts] 和这段：line1\nline2\nline3 谢谢')
  })

  it('cmd 类型整条替换为 payload', () => {
    const cmd: InlineToken = {
      type: 'cmd',
      id: 'review',
      displayText: '/review',
      payload: 'Please review the code.',
      name: 'Review'
    }
    const content = `${makeTokenMarker('t0')} extra args`
    expect(resolveTokensForAgent(content, { t0: cmd })).toBe('Please review the code.')
  })

  it('cmd payload 内嵌 paste 标记时做二次就地替换', () => {
    const cmd: InlineToken = {
      type: 'cmd',
      id: 'review',
      displayText: '/review',
      payload: `Review this:\n${makeTokenMarker('p0')}`,
      name: 'Review'
    }
    const content = `${makeTokenMarker('t0')} ${makeTokenMarker('p0')}`
    const out = resolveTokensForAgent(content, { t0: cmd, p0: pasteToken })
    expect(out).toBe('Review this:\nline1\nline2\nline3')
  })

  it('未知 uid 标记替换为空串', () => {
    expect(resolveTokensForAgent(`a ${makeTokenMarker('zz')} b`, { p0: pasteToken })).toBe('a  b')
  })
})

describe('resolveTokensForCopy', () => {
  it('paste 还原 payload，其余类型用 displayText', () => {
    const content = `前缀 ${makeTokenMarker('a0')} 中缀 ${makeTokenMarker('p0')} 后缀`
    const out = resolveTokensForCopy(content, { a0: atToken, p0: pasteToken })
    expect(out).toBe('前缀 foo.ts 中缀 line1\nline2\nline3 后缀')
  })

  it('无 tokens 时原样返回', () => {
    expect(resolveTokensForCopy('hello')).toBe('hello')
  })
})

describe('segmentContent（paste token）', () => {
  it('paste 标记拆分为 token 段', () => {
    const content = `请分析：${makeTokenMarker('p0')}`
    const segs = segmentContent(content, { p0: pasteToken })
    expect(segs).toEqual([
      { type: 'text', text: '请分析：' },
      { type: 'token', uid: 'p0', token: pasteToken }
    ])
  })
})

describe('rebuildDraftFromContent（回退草稿重建）', () => {
  it('paste → 占位明文并收集 token；at → @名并收集；周围文本保留', () => {
    const content = `看下 ${makeTokenMarker('a0')} 和 ${makeTokenMarker('p0')} 谢谢`
    const r = rebuildDraftFromContent(content, { a0: atToken, p0: pasteToken })
    expect(r.text).toBe('看下 @foo.ts 和 [粘贴文本 #1 · 3 行] 谢谢')
    expect(r.atTokens).toEqual([atToken])
    expect(r.pasteTokens).toEqual([pasteToken])
  })

  it('cmd → displayText 明文（发送时重新解析），不进登记列表', () => {
    const cmd: InlineToken = {
      type: 'cmd',
      id: 'review',
      displayText: '/review',
      payload: 'Please review.',
      name: 'Review'
    }
    const r = rebuildDraftFromContent(`${makeTokenMarker('t0')} src/`, { t0: cmd })
    expect(r.text).toBe('/review src/')
    expect(r.atTokens).toEqual([])
    expect(r.pasteTokens).toEqual([])
  })

  it('同 uid 多次出现只登记一次；无效标记丢弃；无 tokens 原样返回', () => {
    const content = `${makeTokenMarker('p0')} x ${makeTokenMarker('p0')} ${makeTokenMarker('zz')}`
    const r = rebuildDraftFromContent(content, { p0: pasteToken })
    expect(r.pasteTokens).toHaveLength(1)
    expect(r.text).toBe('[粘贴文本 #1 · 3 行] x [粘贴文本 #1 · 3 行] ')
    expect(rebuildDraftFromContent('plain text').text).toBe('plain text')
  })
})
