import { describe, it, expect } from 'vitest'
import type { InlineToken } from '../types/chatMessage'
import {
  BOT_MENTION_TOKEN_TYPE,
  buildBotToken,
  buildPasteToken,
  inlineTokensToPlainText,
  makeTokenMarker,
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

// ─────────────────────────────────────────────────────────────────────────
// A3 · @提及胶囊（bot 类型 token）—— 生产（buildBotToken）与四个消费面
// （Agent 展开 / 复制 / 人读明文 / 分段渲染 / 回退重建）在协议层的钉子。
// 用例一律用 name ≠ displayName 的语料（scout / 侦察兵）：id 是身份键、
// displayText/payload 是显示名，两者相同的语料会把「拿错字段」的缺陷全部掩掉。

const botToken: InlineToken = buildBotToken({ name: 'scout', displayName: '侦察兵' })

describe('buildBotToken（A1）', () => {
  it('全字段形状：type=bot、id=身份键、displayText===payload===`@显示名`、name=显示名', () => {
    expect(botToken).toEqual({
      type: BOT_MENTION_TOKEN_TYPE,
      id: 'scout',
      displayText: '@侦察兵',
      payload: '@侦察兵',
      name: '侦察兵'
    })
    // 常量本身也是契约：L0 的 mentionsFromTokens 按这个字符串认提及
    expect(BOT_MENTION_TOKEN_TYPE).toBe('bot')
    // 展开给模型的与胶囊上显示的必须是同一句提及原文
    expect(botToken.displayText).toBe(botToken.payload)
  })
})

describe('resolveTokensForAgent（bot token，A2）', () => {
  it('非 cmd 默认分支：bot 标记就地替换为 payload，周围文本保留', () => {
    const content = `帮我叫 ${makeTokenMarker('a0')} 看看这段`
    expect(resolveTokensForAgent(content, { a0: botToken })).toBe('帮我叫 @侦察兵 看看这段')
  })

  it('同条 content 混 bot + at：各自就地展开互不干扰', () => {
    const content = `${makeTokenMarker('a0')} 看下 ${makeTokenMarker('a1')} 谢谢`
    const out = resolveTokensForAgent(content, { a0: botToken, a1: atToken })
    expect(out).toBe('@侦察兵 看下 [workspace file: src/foo.ts] 谢谢')
  })
})

describe('resolveTokensForCopy / inlineTokensToPlainText（bot token，A3）', () => {
  it('复制原文：bot token 得 displayText（`@显示名`）', () => {
    const content = `问 ${makeTokenMarker('a0')} 吧`
    expect(resolveTokensForCopy(content, { a0: botToken })).toBe('问 @侦察兵 吧')
  })

  it('人读明文（标题派生）：bot token 同样得 displayText', () => {
    const content = `问 ${makeTokenMarker('a0')} 吧`
    expect(inlineTokensToPlainText(content, { a0: botToken })).toBe('问 @侦察兵 吧')
  })
})

describe('cmd 优先级不因 bot token 而破（A4）', () => {
  it('cmd 与 bot 同存：仍整条替换为 cmd payload（bot 标记不在 payload 中即消失）', () => {
    const cmd: InlineToken = {
      type: 'cmd',
      id: 'review',
      displayText: '/review',
      payload: 'Please review the code.',
      name: 'Review'
    }
    const content = `${makeTokenMarker('t0')} ${makeTokenMarker('a0')} extra`
    expect(resolveTokensForAgent(content, { t0: cmd, a0: botToken })).toBe(
      'Please review the code.'
    )
  })

  it('bot 标记嵌在 cmd payload 中：整条替换后做二次就地替换', () => {
    const cmd: InlineToken = {
      type: 'cmd',
      id: 'review',
      displayText: '/review',
      payload: `Ask ${makeTokenMarker('a0')} to review this.`,
      name: 'Review'
    }
    const content = `${makeTokenMarker('t0')} ${makeTokenMarker('a0')}`
    expect(resolveTokensForAgent(content, { t0: cmd, a0: botToken })).toBe(
      'Ask @侦察兵 to review this.'
    )
  })
})

describe('segmentContent（bot token，A6）', () => {
  it('bot 标记拆分为 token 段：uid 与 token 原样、周围文本各成段', () => {
    const content = `叫 ${makeTokenMarker('a0')} 来`
    expect(segmentContent(content, { a0: botToken })).toEqual([
      { type: 'text', text: '叫 ' },
      { type: 'token', uid: 'a0', token: botToken },
      { type: 'text', text: ' 来' }
    ])
  })
})

describe('rebuildDraftFromContent（bot token 回退重建，A7）', () => {
  it('回填明文恰为单个 `@显示名`（displayText 已带 @，不得再拼前缀翻成 @@），token 进 atTokens', () => {
    const content = `大家好 ${makeTokenMarker('a0')} 在吗`
    const r = rebuildDraftFromContent(content, { a0: botToken })
    expect(r.text).toBe('大家好 @侦察兵 在吗')
    expect(r.text).not.toContain('@@')
    expect(r.atTokens).toEqual([botToken])
    expect(r.pasteTokens).toEqual([])
  })

  it('同 uid 两处出现：明文两处各回填一次，atTokens 只登记一次', () => {
    const content = `${makeTokenMarker('a0')} 和 ${makeTokenMarker('a0')} 都是你`
    const r = rebuildDraftFromContent(content, { a0: botToken })
    expect(r.text).toBe('@侦察兵 和 @侦察兵 都是你')
    expect(r.atTokens).toEqual([botToken])
  })

  it('bot 与 at 混排：bot 原样回填、at 拼前缀，两类都进 atTokens（restoreFromTokens 按 type 分支）', () => {
    const content = `${makeTokenMarker('a0')} 看下 ${makeTokenMarker('a1')}`
    const r = rebuildDraftFromContent(content, { a0: botToken, a1: atToken })
    expect(r.text).toBe('@侦察兵 看下 @foo.ts')
    expect(r.atTokens).toEqual([botToken, atToken])
  })
})
