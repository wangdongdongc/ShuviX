/**
 * readDecodedTextLines 的流式解码边界：createReadStream 只给可控 chunk，
 * 验证多字节字符跨 chunk 时不丢字、不乱码，CRLF 也不被拆成两行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'

const createReadStream = vi.hoisted(() => vi.fn())
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, createReadStream }
})

import { readDecodedTextLines } from '../nodeFileSystemPort'

function mockByteStream(bytes: Buffer, chunkSize = 1): void {
  const chunks = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) =>
    bytes.subarray(index * chunkSize, (index + 1) * chunkSize)
  )
  createReadStream.mockImplementation(() => Readable.from(chunks))
}

async function collectLines(bytes: Buffer, encoding: string, chunkSize = 1): Promise<string[]> {
  mockByteStream(bytes, chunkSize)
  const lines: string[] = []
  for await (const line of readDecodedTextLines('mock.out', encoding)) lines.push(line)
  return lines
}

describe('readDecodedTextLines - chunk 边界', () => {
  beforeEach(() => {
    createReadStream.mockReset()
  })

  it.each([
    {
      encoding: 'UTF-8',
      // "A中😀\r\nB𠀋\rC\n"：中文三字节、emoji/CJK 扩展字符四字节
      hex: '41e4b8adf09f98800d0a42f0a0808b0d430a',
      lines: ['A中😀', 'B𠀋', 'C']
    },
    {
      encoding: 'UTF-16LE',
      // 含 😀 与 𠀋 两对 surrogate，且所有双字节单元均被 chunk 切开
      hex: '41002d4e3dd800de0d000a00420040d80bdc0d0043000a00',
      lines: ['A中😀', 'B𠀋', 'C']
    },
    {
      encoding: 'UTF-16BE',
      hex: '00414e2dd83dde00000d000a0042d840dc0b000d0043000a',
      lines: ['A中😀', 'B𠀋', 'C']
    },
    {
      encoding: 'GBK',
      // "A中文\r\nB好\rC\n"
      hex: '41d6d0cec40d0a42bac30d430a',
      lines: ['A中文', 'B好', 'C']
    },
    {
      encoding: 'GB18030',
      // "A汉𠀋\r\nB字\rC\n"；95 32 83 37 是 U+2000B 的四字节序列
      hex: '41baba953283370d0a42d7d60d430a',
      lines: ['A汉𠀋', 'B字', 'C']
    },
    {
      encoding: 'Shift_JIS',
      // "A日本語\r\nB漢字\rC\n"
      hex: '4193fa967b8cea0d0a428abf8e9a0d430a',
      lines: ['A日本語', 'B漢字', 'C']
    }
  ])(
    'NFP-DEC-01 $encoding 以 1 字节 chunk 输入仍精确还原文本与 CRLF/CR 分行',
    async ({ encoding, hex, lines }) => {
      expect(await collectLines(Buffer.from(hex, 'hex'), encoding)).toEqual(lines)
      expect(createReadStream).toHaveBeenCalledWith('mock.out')
    }
  )

  it.each([1, 2, 3, 4, 7, 64])(
    'NFP-DEC-02 非法 UTF-8 在 chunkSize=%i 时输出一致',
    async (chunkSize) => {
      // 合法 emoji / 中文之间夹一个 0xFF；各 chunk 大小都必须留下同一个 U+FFFD
      const bytes = Buffer.from('41f09f988042ff43e4b8ad44', 'hex')

      expect(await collectLines(bytes, 'UTF-8', chunkSize)).toEqual(['A😀B�C中D'])
    }
  )
})
