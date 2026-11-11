/**
 * 文件库两端共用的纯函数（测试设计 docs/file-library-l1-tests.md §2，FL-*）。
 *
 * 链接的拆与拼决定了「哪段文字算库里的一件」：认宽了，长得像的地址会被当成库引用去读、去显示；
 * 认窄了，笔记里的链接解不出来，派生关联也跟着丢。文件名清洗决定了写进 Markdown 的链接要不要转义、
 * 在各平台能不能建出来。这些都是纯函数，没有替身，大部分写成表。
 */
import { describe, expect, it } from 'vitest'
import {
  extractLibraryItemIds,
  isLibraryImageName,
  libraryItemIdOfRef,
  libraryKindOf,
  libraryLink,
  libraryMarkdown,
  libraryRef,
  parseLibraryLink,
  pastedFileName,
  sanitizeLibraryFileName,
  timestampedFileName
} from './fileLibrary'

const ID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const ID2 = '0199d3a2-0000-7000-8000-000000000000'
const ID_UP = ID.toUpperCase()
const LINK = `shuvix://file/${ID}`

describe('parseLibraryLink', () => {
  it('FL-1 认的写法：id 统一成小写，文件名按百分号解码，坏的转义原样保留', () => {
    const bare = parseLibraryLink(LINK)
    expect(bare).toEqual({ itemId: ID })
    expect(bare).not.toHaveProperty('fileName')

    expect(parseLibraryLink(`${LINK}/a.png`)).toEqual({ itemId: ID, fileName: 'a.png' })

    const trailing = parseLibraryLink(`${LINK}/`)
    expect(trailing).toEqual({ itemId: ID })
    expect(trailing).not.toHaveProperty('fileName')

    expect(parseLibraryLink(`${LINK}/a%20b.png`)).toEqual({ itemId: ID, fileName: 'a b.png' })
    expect(parseLibraryLink(`${LINK}/%E5%9B%BE.png`)).toEqual({ itemId: ID, fileName: '图.png' })
    expect(() => parseLibraryLink(`${LINK}/a%zz.png`)).not.toThrow()
    expect(parseLibraryLink(`${LINK}/a%zz.png`)).toEqual({ itemId: ID, fileName: 'a%zz.png' })

    expect(parseLibraryLink(`SHUVIX://FILE/${ID_UP}/x.png`)).toEqual({
      itemId: ID,
      fileName: 'x.png'
    })
    expect(parseLibraryLink(`  \t${LINK}/a.png \n`)).toEqual({ itemId: ID, fileName: 'a.png' })
  })

  const g = ID.slice(0, -1) + 'g'
  it.each([
    ['空串', ''],
    ['只有前缀', 'shuvix://file/'],
    ['不是 id', 'shuvix://file/not-an-id'],
    ['36 个连字符', `shuvix://file/${'-'.repeat(36)}`],
    ['id 里含 g', `shuvix://file/${g}`],
    ['35 位', `shuvix://file/${ID.slice(0, 35)}`],
    ['id 后多一位', `shuvix://file/${ID}0`],
    ['两段文件名', `${LINK}/a/b.png`],
    ['带查询', `${LINK}?x=1`],
    ['文件名带查询', `${LINK}/a.png?x`],
    ['带片段', `${LINK}#f`],
    ['files 复数', `shuvix://files/${ID}`],
    ['会话链接', `shuvix://session/${ID}`],
    ['file: 协议', `file:///${ID}`],
    ['嵌在别的地址里', `https://e.x/${LINK}`],
    ['前面多一个字母', `x${LINK}`]
  ])('FL-2 不认：%s → null', (_label, url) => {
    expect(parseLibraryLink(url)).toBeNull()
  })
})

describe('libraryLink', () => {
  it('FL-3 拼链接：没有文件名或文件名全是空白时不带文件名段；带文件名时能解回原名', () => {
    expect(libraryLink(ID)).toBe(LINK)
    expect(libraryLink(ID, '  ')).toBe(LINK)
    expect(libraryLink(ID, '')).toBe(LINK)

    const link = libraryLink(ID, 'a b(1).png')
    expect(link.startsWith(`${LINK}/a%20b`)).toBe(true)
    expect(parseLibraryLink(link)).toEqual({ itemId: ID, fileName: 'a b(1).png' })
  })

  // 疑似缺陷：fileLibrary.ts:83-87 encodeLinkName 的注释说「保留字母、数字、`-_.~`，其余按 UTF-8 百分号转义」，
  // 但它用的 encodeURIComponent 不转义 `( ) ! * '`。未配对的 `)` 写进 Markdown 链接会把链接截断。
  it('FL-3 括号也百分号转义：a b(1).png → a%20b%281%29.png', () => {
    expect(libraryLink(ID, 'a b(1).png')).toBe(`${LINK}/a%20b%281%29.png`)
  })

  it('FL-3 清洗过的名字写进链接不用转义，往返得到清洗后的名字', () => {
    const corpus = [
      '屏幕截图 2026-11-10 15.30.12.png',
      'cafe\u0301.png',
      'a  b c.pdf',
      'report (final) [v2].docx',
      'smile 😀 face.jpg',
      'C:\\Users\\x\\My File.txt',
      '/Users/x/Desktop/图 片.png',
      'Ünïcödé — ñame.md'
    ]
    for (const raw of corpus) {
      const clean = sanitizeLibraryFileName(raw)
      const link = libraryLink(ID, clean)
      expect(link, raw).not.toContain('%')
      expect(parseLibraryLink(link), raw).toEqual({ itemId: ID, fileName: clean })
    }
  })
})

describe('library: 引用', () => {
  it('FL-4 libraryRef 与 libraryItemIdOfRef：前缀区分大小写，id 不分', () => {
    expect(libraryRef(ID)).toBe(`library:${ID}`)
    expect(libraryItemIdOfRef(`library:${ID}`)).toBe(ID)
    expect(libraryItemIdOfRef(`library:${ID_UP}`)).toBe(ID)
    for (const bad of [
      'library:',
      'library:x',
      `shown:${ID}`,
      `LIBRARY:${ID}`,
      ` library:${ID}`,
      `library:${ID}/a.png`
    ]) {
      expect(libraryItemIdOfRef(bad), bad).toBeUndefined()
    }
  })
})

describe('extractLibraryItemIds', () => {
  it('FL-5 按首次出现排序、不分大小写去重；粘连的、形状不对的不算；围栏里的算（纯文本扫描）', () => {
    const text = [
      `# Note`,
      `![](shuvix://file/${ID}/a.png) and [b](shuvix://file/${ID2}/b.pdf)`,
      `again ${LINK}/a.png`,
      `upper SHUVIX://FILE/${ID_UP}`,
      `glued shuvix://file/${ID}a`,
      `glued2 shuvix://file/${ID2}-`,
      `bad shuvix://file/${'-'.repeat(36)}`,
      `bad shuvix://file/not-an-id`
    ].join('\n')
    expect(extractLibraryItemIds(text)).toEqual([ID, ID2])

    // 只有粘连的写法：一个都不算
    expect(extractLibraryItemIds(`x shuvix://file/${ID}a y shuvix://file/${ID}-`)).toEqual([])

    // 围栏代码块里的照样算：这是现状，钉住
    const fenced = '```md\n![](shuvix://file/' + ID2 + '/a.png)\n```\n'
    expect(extractLibraryItemIds(fenced)).toEqual([ID2])

    expect(extractLibraryItemIds('')).toEqual([])
  })
})

describe('类型判定', () => {
  it('FL-6 isLibraryImageName：认那张扩展名表，任意大小写', () => {
    for (const ok of [
      'a.png',
      'a.jpg',
      'a.jpeg',
      'a.gif',
      'a.webp',
      'a.svg',
      'a.bmp',
      'a.avif',
      'a.ico',
      'A.PNG',
      'b.JpEg'
    ]) {
      expect(isLibraryImageName(ok), ok).toBe(true)
    }
    for (const no of ['a.heic', 'a.tiff', 'a.pdf', 'png', 'a.png.txt', '']) {
      expect(isLibraryImageName(no), no).toBe(false)
    }
  })

  it.each([
    ['image/png', 'x.bin', 'image'],
    ['video/mp4', 'x', 'video'],
    ['audio/mpeg', 'x', 'audio'],
    ['application/pdf', 'x', 'pdf'],
    ['application/zip', 'x', 'archive'],
    ['application/x-7z-compressed', 'x', 'archive'],
    ['text/plain', 'x', 'document'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x', 'document'],
    ['application/json', 'x', 'document'],
    ['image/png; charset=x', 'x', 'image'],
    ['IMAGE/PNG', 'x', 'image'],
    ['application/octet-stream', 'x.MP4', 'video'],
    ['application/octet-stream', 'a.tgz', 'archive'],
    ['', 'k.key', 'document'],
    ['', 'a.mp3', 'audio'],
    ['application/octet-stream', 'a.unknownext', 'other'],
    ['', 'noext', 'other'],
    ['application/pdf', 'a.png', 'pdf']
  ] as const)('FL-6 libraryKindOf(%j, %j) → %s', (mime, name, kind) => {
    expect(libraryKindOf(mime, name)).toBe(kind)
  })
})

describe('sanitizeLibraryFileName', () => {
  const SAFE = /^[\p{L}\p{N}\p{M}._-]+$/u

  it.each([
    ['a b.png', 'a-b.png'],
    ['a  &  b.png', 'a-b.png'],
    ['屏幕截图 2026-11-10 15.30.12.png', '屏幕截图-2026-11-10-15.30.12.png'],
    ['/Users/x/a.png', 'a.png'],
    ['C:\\x\\a.png', 'a.png'],
    ['.hidden.png', 'hidden.png'],
    ['...', 'file'],
    ['', 'file'],
    ['con.txt', 'con_.txt'],
    ['LPT1', 'LPT1_'],
    ['console.txt', 'console.txt'],
    ['-a-.png', 'a.png'],
    ['archive.tar.gz', 'archive.tar.gz'],
    ['x.verylongextension', 'x.verylongextension']
  ])('FL-7 %j → %j', (raw, want) => {
    expect(sanitizeLibraryFileName(raw)).toBe(want)
  })

  it('FL-7 NFD 与 NFC 输出逐码点相同', () => {
    const nfd = 'cafe\u0301.png'
    const nfc = 'caf\u00e9.png'
    expect(nfd).not.toBe(nfc)
    expect(sanitizeLibraryFileName(nfd)).toBe(sanitizeLibraryFileName(nfc))
    expect(sanitizeLibraryFileName(nfd)).toBe(nfc)
  })

  it('FL-7 超长名字：UTF-8 不超过 120 字节，保留扩展名，不截断半个字符', () => {
    const out = sanitizeLibraryFileName('图'.repeat(200) + '.png')
    const bytes = new TextEncoder().encode(out)
    expect(bytes.length).toBeLessThanOrEqual(120)
    expect(out.endsWith('.png')).toBe(true)
    const stem = out.slice(0, -'.png'.length)
    expect(stem.length).toBeGreaterThan(0)
    expect(Array.from(stem).every((ch) => ch === '图')).toBe(true)
    // 往返解码不出替换字符：没有被截断的多字节序列
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(out)
  })

  it('FL-7 所有输出只含字母数字和 ._-，不以 . 或 - 开头', () => {
    const corpus = [
      'a b.png',
      'a  &  b.png',
      'cafe\u0301.png',
      '屏幕截图 2026-11-10 15.30.12.png',
      '/Users/x/a.png',
      'C:\\x\\a.png',
      '.hidden.png',
      '...',
      '',
      'con.txt',
      'LPT1',
      '-a-.png',
      'archive.tar.gz',
      'x.verylongextension',
      '图'.repeat(200) + '.png',
      'smile 😀.jpg',
      '<script>alert(1)</script>.html',
      '  -._weird name_.-  ',
      'a\u0000b\u202e.png',
      '%2e%2e%2fetc.md',
      '../../etc/passwd'
    ]
    for (const raw of corpus) {
      const out = sanitizeLibraryFileName(raw)
      expect(out, raw).toMatch(SAFE)
      expect(out.startsWith('.') || out.startsWith('-'), raw).toBe(false)
    }
  })
})

describe('没有原名的文件名', () => {
  const NOW = new Date(2026, 10, 10, 15, 30, 12)

  it('FL-8 pastedFileName / timestampedFileName：本地时间、补零、扩展名只有一个点', () => {
    expect(pastedFileName(NOW, 'png')).toBe('pasted-20261110-153012.png')
    expect(pastedFileName(NOW, '.jpg')).toBe('pasted-20261110-153012.jpg')
    expect(pastedFileName(new Date(2026, 0, 2, 3, 4, 5), 'png')).toBe('pasted-20260102-030405.png')
    expect(timestampedFileName('image', NOW, 'png')).toBe('image-20261110-153012.png')
    expect(timestampedFileName('image', NOW, '.jpeg')).toBe('image-20261110-153012.jpeg')
  })
})

describe('libraryMarkdown', () => {
  it('FL-9 图片：alt 取原名去扩展名与方括号；粘贴的位图 alt 留空', () => {
    const fileName = 'Screen-1.png'
    const link = libraryLink(ID, fileName)
    expect(
      libraryMarkdown({ itemId: ID, fileName, originalName: 'Screen [1].png', image: true })
    ).toBe(`![Screen 1](${link})`)

    const pasted = 'pasted-20261110-153012.png'
    expect(libraryMarkdown({ itemId: ID, fileName: pasted, image: true })).toBe(
      `![](${libraryLink(ID, pasted)})`
    )
    expect(libraryMarkdown({ itemId: ID, fileName: pasted, originalName: '', image: true })).toBe(
      `![](${libraryLink(ID, pasted)})`
    )
  })

  it('FL-9 非图片：原名作文字，方括号与反斜杠转义，换行与制表符压成一个空格', () => {
    const fileName = 'report-v2.pdf'
    const link = libraryLink(ID, fileName)
    expect(
      libraryMarkdown({ itemId: ID, fileName, originalName: 'report [v2].pdf', image: false })
    ).toBe(`[report \\[v2\\].pdf](${link})`)

    expect(
      libraryMarkdown({ itemId: ID, fileName, originalName: 'a\n\tb\\c.pdf', image: false })
    ).toBe(`[a b\\\\c.pdf](${link})`)

    expect(
      libraryMarkdown({
        itemId: ID,
        fileName: 'x.png',
        originalName: 'two\nlines.png',
        image: true
      })
    ).toBe(`![two lines](${libraryLink(ID, 'x.png')})`)

    expect(libraryMarkdown({ itemId: ID, fileName, image: false })).toBe(`[${fileName}](${link})`)
    expect(libraryMarkdown({ itemId: ID, fileName, originalName: '', image: false })).toBe(
      `[${fileName}](${link})`
    )
  })

  it('FL-9 链接部分恒等于 libraryLink(itemId, fileName)', () => {
    const cases = [
      { itemId: ID, fileName: 'a.png', originalName: 'A (1).png', image: true },
      { itemId: ID2, fileName: '图.pdf', originalName: '图 [x].pdf', image: false },
      { itemId: ID, fileName: 'n.md', image: false },
      { itemId: ID2, fileName: 'p.png', originalName: '', image: true }
    ]
    for (const c of cases) {
      const md = libraryMarkdown(c)
      const m = /\]\(([^)]*)\)$/.exec(md)
      expect(m, md).not.toBeNull()
      expect(m![1]).toBe(libraryLink(c.itemId, c.fileName))
    }
  })
})
