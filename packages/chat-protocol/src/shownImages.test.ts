/**
 * 给用户看图（`show_image` 与带图提议，2026-11-01，docs/show-image-design.md）—— `shownImages.ts` 里两端共用的那一半：
 * 限额、快照文件名的形状、`shown:` 引用、从调用块 / 提议详情里取出要画的图（会话树里的形状不可信，一律宽松地认）。
 *
 *   SP-1 `isShownImageFile`：64 位小写十六进制 + png/jpg/gif/webp/svg 才认；大写、位数不对、别的扩展名、带路径分隔、
 *        尾随换行、不是字符串都不认
 *   SP-2 表一致：SHOWN_IMAGE_FORMATS 的每个键拼成文件名都认；MIME 表、限额、格式清单、工具名钉死
 *   SP-3 引用：`shownImageFileOfRef(shownImageRef(f)) === f`；普通路径、大小写不对的前缀、形状不对的名字、带 `/../`、
 *        空串 → undefined
 *   SP-4 `shownImageOf`：合法对象只拷认得的键；mimeType / source 缺或不是字符串、文件名不对、null / 数组 / 数字 →
 *        undefined；坏的 original 丢掉（不致命）；宽高缺一个两个都丢；0 / 负数 / NaN / Infinity / 字符串尺寸丢掉；
 *        坏 bytes → 0；空串 source 也认
 *   SP-5 `isSettledShowImageBlock`：show_image 且 result 是空串也算落定；result 缺、isError、别的工具、文本 / 思考块为假
 *   SP-6 `shownImagesOfBlock`：details 缺 / 类型不对 / images 不是数组 → []；按 details 顺序、说明取 args 同一下标；
 *        说明 trim、空白说明不带 caption 键、非字符串说明忽略；坏的 details.images[0] 跳过、images[1] 仍配 args[1]；
 *        args 缺 / 比 details 短 → 没有说明
 *   SP-7 `suggestionImagesOf`：undefined / 类型不是 suggest / images 不是数组 → []；长度不变；null 与坏项 → undefined；
 *        合法项清洗后交回
 */
import { describe, expect, it } from 'vitest'
import {
  SHOW_IMAGE_LIMITS,
  SHOW_IMAGE_TOOL_NAME,
  SHOWN_IMAGE_FORMAT_NAMES,
  SHOWN_IMAGE_FORMATS,
  isSettledShowImageBlock,
  isShownImageFile,
  shownImageFileOfRef,
  shownImageOf,
  shownImageRef,
  shownImagesOfBlock,
  suggestionImagesOf
} from './shownImages'
import type { AssistantBlock, AssistantToolBlock, ToolResultDetails } from './types/chatMessage'

// ─── 夹具 ───────────────────────────────────────────────

const HEX = '0123456789abcdef'.repeat(4)
const HEX_B = 'fedcba9876543210'.repeat(4)
const FILE = `${HEX}.png`
const FILE_B = `${HEX_B}.jpg`

/** 一张合法的快照记录 */
function image(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: FILE,
    source: '/home/u/chart.png',
    mimeType: 'image/png',
    width: 40,
    height: 24,
    bytes: 1234,
    ...overrides
  }
}

/** 一次 show_image 调用块 */
function showCall(
  details: unknown,
  args: Record<string, unknown> | undefined = { images: [{ path: 'a.png' }] },
  extra: Partial<AssistantToolBlock> = {}
): AssistantToolBlock {
  return {
    type: 'tool',
    toolCallId: 'call_0',
    toolName: SHOW_IMAGE_TOOL_NAME,
    ...(args ? { args } : {}),
    result: 'Shown 1 image to the user:',
    details: details as ToolResultDetails,
    ...extra
  }
}

// ─── SP-1 ───────────────────────────────────────────────

describe('SP-1 · isShownImageFile', () => {
  it.each(['png', 'jpg', 'gif', 'webp', 'svg'])('SP-1 64 位小写十六进制 + .%s → 认', (ext) => {
    expect(isShownImageFile(`${HEX}.${ext}`)).toBe(true)
  })

  it.each<[string, unknown]>([
    ['大写十六进制', `${HEX.toUpperCase()}.png`],
    ['63 位', `${HEX.slice(1)}.png`],
    ['65 位', `${HEX}0.png`],
    ['非十六进制字符', `${HEX.slice(1)}g.png`],
    ['.jpeg', `${HEX}.jpeg`],
    ['.PNG', `${HEX}.PNG`],
    ['.bmp', `${HEX}.bmp`],
    ['没有扩展名', HEX],
    ['./ 前缀', `./${FILE}`],
    ['../ 前缀', `../${FILE}`],
    ['./x', './x'],
    ['../x', '../x'],
    ['带 /', `a/${FILE}`],
    ['带 \\', `a\\${FILE}`],
    ['尾随换行', `${FILE}\n`],
    ['空串', ''],
    ['undefined', undefined],
    ['数字', 42],
    ['对象', { file: FILE }]
  ])('SP-1 %s → 不认', (_label, name) => {
    expect(isShownImageFile(name)).toBe(false)
  })
})

// ─── SP-2 ───────────────────────────────────────────────

describe('SP-2 · 表一致', () => {
  it('SP-2 SHOWN_IMAGE_FORMATS 的每个键拼成 `<hex>.<key>` 都认', () => {
    for (const key of Object.keys(SHOWN_IMAGE_FORMATS)) {
      expect(isShownImageFile(`${HEX}.${key}`), key).toBe(true)
    }
  })

  it('SP-2 MIME 表钉死', () => {
    expect(SHOWN_IMAGE_FORMATS).toStrictEqual({
      png: 'image/png',
      jpg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml'
    })
  })

  it('SP-2 限额 / 格式清单 / 工具名钉死', () => {
    expect(SHOW_IMAGE_LIMITS).toStrictEqual({ maxImages: 6, caption: 200, maxBytes: 20971520 })
    expect(SHOWN_IMAGE_FORMAT_NAMES).toBe('PNG, JPEG, GIF, WebP or SVG')
    expect(SHOW_IMAGE_TOOL_NAME).toBe('show_image')
  })
})

// ─── SP-3 ───────────────────────────────────────────────

describe('SP-3 · shown: 引用', () => {
  it('SP-3 拼了再拆回到原名', () => {
    for (const file of [FILE, FILE_B, `${HEX}.svg`]) {
      expect(shownImageRef(file)).toBe(`shown:${file}`)
      expect(shownImageFileOfRef(shownImageRef(file))).toBe(file)
    }
  })

  it.each<[string, string]>([
    ['普通路径', 'chart.png'],
    ['普通绝对路径', `/tmp/${FILE}`],
    ['前缀大小写不对', `Shown:${FILE}`],
    ['名字形状不对', 'shown:chart.png'],
    ['大写十六进制', `shown:${HEX.toUpperCase()}.png`],
    ['带 /../', `shown:${FILE}/../x`],
    ['名字前带 ../', `shown:../${FILE}`],
    ['只有前缀', 'shown:'],
    ['空串', '']
  ])('SP-3 %s → undefined', (_label, path) => {
    expect(shownImageFileOfRef(path)).toBeUndefined()
  })
})

// ─── SP-4 ───────────────────────────────────────────────

describe('SP-4 · shownImageOf', () => {
  it('SP-4 合法对象：只拷认得的键，交回新对象', () => {
    const raw = image({ original: `${HEX_B}.png`, extra: 'x', path: '/etc/passwd' })
    const out = shownImageOf(raw)
    expect(out).toStrictEqual({
      file: FILE,
      original: `${HEX_B}.png`,
      source: '/home/u/chart.png',
      mimeType: 'image/png',
      width: 40,
      height: 24,
      bytes: 1234
    })
    expect(out).not.toBe(raw)
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['数组', [image()]],
    ['数字', 7],
    ['字符串', FILE],
    ['mimeType 缺', image({ mimeType: undefined })],
    ['mimeType 是数字', image({ mimeType: 1 })],
    ['source 缺', image({ source: undefined })],
    ['source 是 null', image({ source: null })],
    ['file 形状不对', image({ file: 'chart.png' })],
    ['file 缺', image({ file: undefined })],
    ['file 带路径', image({ file: `../${FILE}` })]
  ])('SP-4 %s → undefined', (_label, raw) => {
    expect(shownImageOf(raw)).toBeUndefined()
  })

  it.each<[string, unknown]>([
    ['形状不对', 'orig.png'],
    ['数字', 5],
    ['带路径', `a/${HEX_B}.png`]
  ])('SP-4 坏的 original（%s）丢掉，这条照留', (_label, original) => {
    const out = shownImageOf(image({ original }))
    expect(out).toBeDefined()
    expect(out).not.toHaveProperty('original')
    expect(out?.file).toBe(FILE)
  })

  it('SP-4 宽高缺一个 → 两个都丢', () => {
    const noHeight = shownImageOf(image({ height: undefined }))
    expect(noHeight).not.toHaveProperty('width')
    expect(noHeight).not.toHaveProperty('height')
    const noWidth = shownImageOf(image({ width: undefined }))
    expect(noWidth).not.toHaveProperty('width')
    expect(noWidth).not.toHaveProperty('height')
  })

  it.each<[string, unknown]>([
    ['0', 0],
    ['负数', -3],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['字符串', '40']
  ])('SP-4 宽为 %s → 宽高都丢', (_label, width) => {
    const out = shownImageOf(image({ width }))
    expect(out).toBeDefined()
    expect(out).not.toHaveProperty('width')
    expect(out).not.toHaveProperty('height')
  })

  it.each<[string, unknown]>([
    ['缺', undefined],
    ['0', 0],
    ['负数', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['字符串', '1234']
  ])('SP-4 bytes %s → 0', (_label, bytes) => {
    expect(shownImageOf(image({ bytes }))?.bytes).toBe(0)
  })

  it('SP-4 空串 source 也认', () => {
    expect(shownImageOf(image({ source: '' }))?.source).toBe('')
  })
})

// ─── SP-5 ───────────────────────────────────────────────

describe('SP-5 · isSettledShowImageBlock', () => {
  it('SP-5 show_image 调用、result 是空串 → 落定', () => {
    expect(isSettledShowImageBlock(showCall(undefined, undefined, { result: '' }))).toBe(true)
    expect(isSettledShowImageBlock(showCall(undefined))).toBe(true)
  })

  it.each<[string, AssistantBlock]>([
    ['result 缺（还在执行）', showCall(undefined, undefined, { result: undefined })],
    ['isError', showCall(undefined, undefined, { result: 'boom', isError: true })],
    ['别的工具', showCall(undefined, undefined, { toolName: 'read' })],
    ['文本块', { type: 'text', text: 'show_image' }],
    ['思考块', { type: 'thinking', text: 'show_image' }]
  ])('SP-5 %s → false', (_label, block) => {
    expect(isSettledShowImageBlock(block)).toBe(false)
  })
})

// ─── SP-6 ───────────────────────────────────────────────

describe('SP-6 · shownImagesOfBlock', () => {
  it.each<[string, unknown]>([
    ['details 缺', undefined],
    ['details 类型不是 show_image', { type: 'suggest', images: [image()] }],
    ['images 不是数组', { type: 'show_image', images: image() }],
    ['images 缺', { type: 'show_image' }]
  ])('SP-6 %s → []', (_label, details) => {
    expect(shownImagesOfBlock(showCall(details))).toStrictEqual([])
  })

  it('SP-6 按 details 顺序，说明取 args 同一下标（trim）', () => {
    const block = showCall(
      { type: 'show_image', images: [image(), image({ file: FILE_B, mimeType: 'image/jpeg' })] },
      {
        images: [
          { path: 'a.png', caption: '  Revenue  ' },
          { path: 'b.jpg', caption: 'After' }
        ]
      }
    )
    const items = shownImagesOfBlock(block)
    expect(items.map((i) => i.image.file)).toStrictEqual([FILE, FILE_B])
    expect(items.map((i) => i.caption)).toStrictEqual(['Revenue', 'After'])
  })

  it.each<[string, unknown]>([
    ['空白说明', '   '],
    ['空串说明', ''],
    ['数字说明', 3],
    ['对象说明', { text: 'x' }]
  ])('SP-6 %s → 这一项没有 caption 键', (_label, caption) => {
    const [item] = shownImagesOfBlock(
      showCall({ type: 'show_image', images: [image()] }, { images: [{ path: 'a.png', caption }] })
    )
    expect(item.image.file).toBe(FILE)
    expect(item).not.toHaveProperty('caption')
  })

  it('SP-6 坏的 details.images[0] 跳过，images[1] 仍配 args[1] 的说明（按下标对齐）', () => {
    const block = showCall(
      { type: 'show_image', images: [{ file: 'bad' }, image({ file: FILE_B })] },
      {
        images: [
          { path: 'a.png', caption: 'First' },
          { path: 'b.png', caption: 'Second' }
        ]
      }
    )
    const items = shownImagesOfBlock(block)
    expect(items).toHaveLength(1)
    expect(items[0].image.file).toBe(FILE_B)
    expect(items[0].caption).toBe('Second')
  })

  it('SP-6 args 缺 / args.images 不是数组 / 比 details 短 → 没有说明', () => {
    const details = { type: 'show_image', images: [image(), image({ file: FILE_B })] }
    for (const args of [undefined, { images: 'x' }, {}]) {
      const items = shownImagesOfBlock(showCall(details, args))
      expect(items, JSON.stringify(args)).toHaveLength(2)
      for (const item of items) expect(item).not.toHaveProperty('caption')
    }
    const short = shownImagesOfBlock(showCall(details, { images: [{ path: 'a', caption: 'One' }] }))
    expect(short.map((i) => i.caption)).toStrictEqual(['One', undefined])
    expect(short[1]).not.toHaveProperty('caption')
  })
})

// ─── SP-7 ───────────────────────────────────────────────

describe('SP-7 · suggestionImagesOf', () => {
  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['类型是 show_image', { type: 'show_image', images: [image()] }],
    ['images 不是数组', { type: 'suggest', images: image() }],
    ['images 缺', { type: 'suggest' }]
  ])('SP-7 %s → []', (_label, details) => {
    expect(suggestionImagesOf(details as ToolResultDetails | undefined)).toStrictEqual([])
  })

  it('SP-7 长度不变；null 与坏项 → undefined；合法项清洗后交回', () => {
    const details = {
      type: 'suggest',
      images: [image({ extra: 1 }), null, { file: 'x.png' }, image({ file: FILE_B })]
    } as unknown as ToolResultDetails
    const out = suggestionImagesOf(details)
    expect(out).toHaveLength(4)
    expect(out[0]).toStrictEqual({
      file: FILE,
      source: '/home/u/chart.png',
      mimeType: 'image/png',
      width: 40,
      height: 24,
      bytes: 1234
    })
    expect(out[1]).toBeUndefined()
    expect(out[2]).toBeUndefined()
    expect(out[3]?.file).toBe(FILE_B)
  })
})
