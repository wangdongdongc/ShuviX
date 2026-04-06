import { describe, it, expect } from 'vitest'
import { findOsc633, stripOsc } from '../agentTerminalManager'

// ─── findOsc633 ──────────────────────────────────────────────────

describe('findOsc633', () => {
  it('找到 633;C 序列（无参数）', () => {
    const text = 'hello\x1b]633;C\x07world'
    const result = findOsc633(text, 'C')
    expect(result).not.toBe(-1)
    if (result === -1) return
    expect(result.start).toBe(5)
    expect(result.end).toBe(13)
    expect(result.param).toBe('')
  })

  it('找到 633;D 序列（带退出码参数）', () => {
    const text = 'output\x1b]633;D;0\x07prompt'
    const result = findOsc633(text, 'D')
    expect(result).not.toBe(-1)
    if (result === -1) return
    expect(result.param).toBe('0')
  })

  it('633;D 非零退出码', () => {
    const text = '\x1b]633;D;127\x07'
    const result = findOsc633(text, 'D')
    expect(result).not.toBe(-1)
    if (result === -1) return
    expect(result.param).toBe('127')
  })

  it('没有匹配的类型返回 -1', () => {
    const text = '\x1b]633;C\x07'
    expect(findOsc633(text, 'D')).toBe(-1)
  })

  it('不完整的序列（缺少 BEL）返回 -1', () => {
    const text = '\x1b]633;C'
    expect(findOsc633(text, 'C')).toBe(-1)
  })

  it('空文本返回 -1', () => {
    expect(findOsc633('', 'C')).toBe(-1)
  })

  it('633;A 序列（prompt start）', () => {
    const text = '\x1b]633;A\x07'
    const result = findOsc633(text, 'A')
    expect(result).not.toBe(-1)
    if (result === -1) return
    expect(result.param).toBe('')
  })

  it('多个 OSC 序列，找到指定类型', () => {
    const text = '\x1b]633;A\x07some text\x1b]633;C\x07output\x1b]633;D;0\x07'
    const resultC = findOsc633(text, 'C')
    expect(resultC).not.toBe(-1)
    if (resultC === -1) return
    expect(resultC.param).toBe('')

    const resultD = findOsc633(text, 'D')
    expect(resultD).not.toBe(-1)
    if (resultD === -1) return
    expect(resultD.param).toBe('0')
  })

  it('end 指向 BEL 之后的位置', () => {
    const text = '\x1b]633;C\x07rest'
    const result = findOsc633(text, 'C')
    expect(result).not.toBe(-1)
    if (result === -1) return
    expect(text.slice(result.end)).toBe('rest')
  })

  it('start 指向 ESC 的位置', () => {
    const text = 'prefix\x1b]633;D;42\x07suffix'
    const result = findOsc633(text, 'D')
    expect(result).not.toBe(-1)
    if (result === -1) return
    expect(text.slice(result.start, result.end)).toBe('\x1b]633;D;42\x07')
  })
})

// ─── stripOsc ────────────────────────────────────────────────────

describe('stripOsc', () => {
  it('移除单个 OSC 序列', () => {
    expect(stripOsc('before\x1b]633;C\x07after')).toBe('beforeafter')
  })

  it('移除多个 OSC 序列', () => {
    const text = '\x1b]633;A\x07prompt\x1b]633;C\x07output\x1b]633;D;0\x07'
    expect(stripOsc(text)).toBe('promptoutput')
  })

  it('不影响普通文本', () => {
    expect(stripOsc('hello world')).toBe('hello world')
  })

  it('移除带参数的 OSC 序列', () => {
    expect(stripOsc('\x1b]633;D;127\x07')).toBe('')
  })

  it('移除非 633 的 OSC 序列', () => {
    expect(stripOsc('\x1b]0;title\x07text')).toBe('text')
  })

  it('空文本返回空', () => {
    expect(stripOsc('')).toBe('')
  })

  it('保留 ANSI 颜色序列（非 OSC）', () => {
    // ANSI CSI 序列不是 OSC，不应被剥离
    expect(stripOsc('\x1b[32mgreen\x1b[0m')).toBe('\x1b[32mgreen\x1b[0m')
  })
})

// ─── 模拟命令执行的 OSC 633 数据流 ────────────────────────────────

describe('OSC 633 command lifecycle parsing', () => {
  it('完整命令生命周期：C → output → D', () => {
    const chunks = ['\x1b]633;C\x07', 'hello world\r\n', '\x1b]633;D;0\x07']
    const fullText = chunks.join('')

    // 找到 C
    const c = findOsc633(fullText, 'C')
    expect(c).not.toBe(-1)
    if (c === -1) return

    // C 之后的内容
    const afterC = fullText.slice(c.end)

    // 找到 D
    const d = findOsc633(afterC, 'D')
    expect(d).not.toBe(-1)
    if (d === -1) return

    // C 和 D 之间的可见输出
    const output = stripOsc(afterC.slice(0, d.start))
    expect(output).toBe('hello world\r\n')
    expect(d.param).toBe('0')
  })

  it('命令失败（非零退出码）', () => {
    const text = '\x1b]633;C\x07command not found\r\n\x1b]633;D;127\x07'

    const c = findOsc633(text, 'C')
    expect(c).not.toBe(-1)
    if (c === -1) return

    const afterC = text.slice(c.end)
    const d = findOsc633(afterC, 'D')
    expect(d).not.toBe(-1)
    if (d === -1) return

    expect(d.param).toBe('127')
    const output = stripOsc(afterC.slice(0, d.start))
    expect(output).toBe('command not found\r\n')
  })

  it('多行输出', () => {
    const text = '\x1b]633;C\x07line1\r\nline2\r\nline3\r\n\x1b]633;D;0\x07'

    const c = findOsc633(text, 'C')
    if (c === -1) return
    const afterC = text.slice(c.end)
    const d = findOsc633(afterC, 'D')
    if (d === -1) return

    const output = stripOsc(afterC.slice(0, d.start))
    expect(output).toBe('line1\r\nline2\r\nline3\r\n')
  })

  it('输出中包含其他 OSC 序列（如终端标题设置）', () => {
    const text = '\x1b]633;C\x07\x1b]0;user@host: ~\x07ls result\r\n\x1b]633;D;0\x07'

    const c = findOsc633(text, 'C')
    if (c === -1) return
    const afterC = text.slice(c.end)
    const d = findOsc633(afterC, 'D')
    if (d === -1) return

    const output = stripOsc(afterC.slice(0, d.start))
    expect(output).toBe('ls result\r\n')
  })

  it('空输出的命令', () => {
    const text = '\x1b]633;C\x07\x1b]633;D;0\x07'

    const c = findOsc633(text, 'C')
    if (c === -1) return
    const afterC = text.slice(c.end)
    const d = findOsc633(afterC, 'D')
    if (d === -1) return

    const output = stripOsc(afterC.slice(0, d.start))
    expect(output).toBe('')
  })

  it('增量数据到达（模拟分块）', () => {
    // 模拟数据分多次到达
    let buf = ''

    // Chunk 1: 只有 C 的开始部分
    buf += '\x1b]633;'
    expect(findOsc633(buf, 'C')).toBe(-1) // 不完整

    // Chunk 2: C 完成
    buf += 'C\x07'
    const c = findOsc633(buf, 'C')
    expect(c).not.toBe(-1)

    // Chunk 3: 部分输出
    if (c === -1) return
    buf = buf.slice(c.end)
    buf += 'partial '
    expect(findOsc633(buf, 'D')).toBe(-1) // 还没有 D

    // Chunk 4: 更多输出 + D 的开始
    buf += 'output\r\n\x1b]633;'
    expect(findOsc633(buf, 'D')).toBe(-1) // D 不完整

    // Chunk 5: D 完成
    buf += 'D;0\x07'
    const d = findOsc633(buf, 'D')
    expect(d).not.toBe(-1)
    if (d === -1) return

    const output = stripOsc(buf.slice(0, d.start))
    expect(output).toBe('partial output\r\n')
    expect(d.param).toBe('0')
  })
})
