import { describe, it, expect } from 'vitest'
import { splitTextForTts } from '../splitText'

describe('splitTextForTts', () => {
  it('空文本返回空数组', () => {
    expect(splitTextForTts('')).toEqual([])
    expect(splitTextForTts('   ')).toEqual([])
    expect(splitTextForTts('\n\n\n')).toEqual([])
  })

  it('短文本不分割', () => {
    const text = '你好世界'
    expect(splitTextForTts(text)).toEqual([text])
  })

  it('单行长文本不分割', () => {
    const text = 'a'.repeat(200)
    expect(splitTextForTts(text)).toEqual([text])
  })

  it('按换行符分割', () => {
    const text = 'a'.repeat(100) + '\n' + 'b'.repeat(100)
    const chunks = splitTextForTts(text)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toBe('a'.repeat(100))
    expect(chunks[1]).toBe('b'.repeat(100))
  })

  it('过滤空行', () => {
    const text = '第一段\n\n\n第二段'
    const chunks = splitTextForTts(text, 1)
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true)
  })

  it('短行合并到 minLength', () => {
    const text = '短\n行\n合\n并\n测试这是一段足够长的文字用来测试合并逻辑是否正确运行'
    const chunks = splitTextForTts(text, 80)
    // 短行应该被合并为一个 chunk
    expect(chunks.length).toBeLessThanOrEqual(2)
    expect(chunks.join('\n')).toContain('短')
    expect(chunks.join('\n')).toContain('测试')
  })

  it('自定义 minLength', () => {
    const text = '第一行\n第二行\n第三行'
    // 很小的 minLength → 每行独立
    const chunks = splitTextForTts(text, 1)
    expect(chunks.length).toBe(3)
  })

  it('末尾短行追加到最后一个 chunk', () => {
    const text = 'a'.repeat(100) + '\n' + 'b'
    const chunks = splitTextForTts(text, 80)
    // 'b' 太短，应追加到前一个 chunk
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('a')
    expect(chunks[0]).toContain('b')
  })

  it('真实多段落文本', () => {
    const text = [
      '这是第一段，包含了足够多的文字，用来测试分割功能是否能正确地将长文本按段落切分。',
      '第二段也有相当的长度，确保每个段落都能独立成为一个语音片段进行合成和播放。',
      '第三段同样如此。'
    ].join('\n')
    const chunks = splitTextForTts(text, 40)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
  })
})
