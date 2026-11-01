/**
 * show_image 工具（tools/showImage.ts，2026-11-01，docs/show-image-design.md）与桌面 suggest 的带图注册（tools/suggest.ts）。
 *
 * 真 services/shownImages（快照落在临时 userData），toolContext / toolRegistry / i18n / electron 桩掉；安全上下文
 * 的入口一调就抛 —— 这个工具没有权限点（用户裁决），碰到它们就是回归。
 *
 *   TI-1 注册项：name show_image、group general、没有 platforms；标签 / 提示走 i18n 键；presentation 同
 *        BUILTIN_TOOL_PRESENTATIONS；describe() 交回描述与 schema；factory 造出 ShowImageTool
 *   TI-2 形状：replay safe；描述说出格式、「use read」、「Markdown images」；schema images 1..6、path 必填、caption 可选、
 *        caption 描述说 200
 *   TI-3 张数：[] / 缺 / 不是数组 → at least one image；7 张 → 7 images is too many + at most 6；6 张照常
 *   TI-4 每一项：path 缺 / 空 / 空白 / 数字、项不是对象 → images[i].path must be a non-empty string；caption 不是字符串 →
 *        images[i].caption must be a string；200 字照常、201 字 → is 201 characters…at most 200；任何一项不合法都不建
 *        快照目录（哪怕前面的项合法）
 *   TI-5 正常路径：相对路径 PNG + 工作目录外的绝对路径 PNG → 结果文字逐字；一张用单数；SVG 那行没有尺寸；details 与
 *        参数按下标对应；content 只有文本块（模型收不到图）
 *   TI-6 没有权限点：安全上下文与 requestUserInput 一次都没被调，工作目录外（假 HOME 里）的文件也一样
 *   TI-7 出错：images[1].path: no such file、不是能摆的图、超大小（带字节数）都成 isError，没有 details
 *   TI-8 路径首尾空白 trim 掉照常解析
 *   TS-1 桌面 suggest 注册：describe() 是带图的描述与 schema；factory(ctx) 的 parameters 也是带图的 schema
 *   TS-2 factory 的工具：相对工作目录的图快照进 shown/<ctx.sessionId>/，details.images 按下标对应；不存在的图 →
 *        isError 点名 suggestions[1].image: no such file；不碰安全上下文
 */
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  userData: '',
  workingDirectory: '',
  registered: [] as Array<Record<string, unknown>>,
  /** 安全上下文的入口：这两个工具一个都不该碰 */
  security: vi.fn(() => {
    throw new Error('security context must not be used by show_image / suggest images')
  })
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, isPackaged: false, getAppPath: () => '/' },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) }
}))
vi.mock('../../services/toolContext', () => ({
  resolveProjectConfig: () => ({
    workingDirectory: h.workingDirectory,
    referenceDirs: [],
    envVars: {}
  }),
  getDesktopSecurityContext: h.security,
  assertReadAllowed: h.security,
  assertWriteAllowed: h.security,
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: (meta: Record<string, unknown>) => {
    h.registered.push(meta)
  }
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import {
  SuggestParamsWithImagesSchema,
  SUGGEST_DESCRIPTION_WITH_IMAGES
} from '@shuvix/agent-runtime'
import { failureText, invokeTool, resultText } from '@shuvix/agent-runtime/tools/testing/invokeTool'
import type { ToolContext } from '../../services/toolContext'
import { SHOW_IMAGE_DESCRIPTION, ShowImageParamsSchema, ShowImageTool } from '../showImage'
import '../suggest'

// ─── 夹具 ───────────────────────────────────────────────

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'shuvix-show-image-')))
h.userData = join(root, 'userData')
h.workingDirectory = join(root, 'wd')
const WD = h.workingDirectory
/** 工作目录之外的「家目录」（TI-6 把 HOME 指过来） */
const HOME = join(root, 'home')

let seq = 0
const freshSid = (): string => `sess-si-${++seq}`

const requestUserInput = vi.fn()
const ctxFor = (sessionId: string): ToolContext =>
  ({ sessionId, requestUserInput }) as unknown as ToolContext

const shownDir = (sid: string): string => join(h.userData, 'shown', sid)
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

const A_PNG = pngHeader(40, 24)
const B_PNG = pngHeader(10, 10)
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"/>'

beforeEach(() => {
  mkdirSync(WD, { recursive: true })
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(WD, 'a.png'), A_PNG)
  writeFileSync(join(HOME, 'b.png'), B_PNG)
  writeFileSync(join(WD, 'fig.svg'), SVG)
  writeFileSync(join(WD, 'notes.txt'), 'not an image')
  h.security.mockClear()
  requestUserInput.mockClear()
})

afterEach(() => {
  expect(h.security, 'no security context call').not.toHaveBeenCalled()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const registration = (name: string): Record<string, unknown> => {
  const meta = h.registered.find((m) => m.name === name)
  if (!meta) throw new Error(`${name} not registered`)
  return meta
}

/** 调一次 show_image（参数不经 schema 校验，直达工具里的检查） */
async function show(
  images: unknown,
  sid = freshSid()
): Promise<Awaited<ReturnType<typeof invokeTool>>['result']> {
  return (await invokeTool(new ShowImageTool(ctxFor(sid)), { images } as never)).result
}

// ─── TI-1 / TI-2 ────────────────────────────────────────

describe('TI-1 · 注册项', () => {
  it('TI-1 name / group / 没有 platforms / 标签与提示 / presentation / describe / factory', () => {
    const meta = registration('show_image')
    expect(meta.group).toBe('general')
    expect(meta).not.toHaveProperty('platforms')
    expect((meta.getLabel as () => string)()).toBe('tool.showImageLabel')
    expect((meta.getHint as () => string)()).toBe('tool.showImageHint')
    expect(meta.presentation).toBe(BUILTIN_TOOL_PRESENTATIONS.show_image.presentation)
    expect((meta.describe as () => unknown)()).toStrictEqual({
      description: SHOW_IMAGE_DESCRIPTION,
      parameters: ShowImageParamsSchema
    })
    const describe1 = (meta.describe as () => { parameters: unknown })().parameters
    expect(describe1).toBe(ShowImageParamsSchema)
    const tool = (meta.factory as (ctx: ToolContext) => unknown)(ctxFor('s'))
    expect(tool).toBeInstanceOf(ShowImageTool)
  })
})

describe('TI-2 · 形状', () => {
  it('TI-2 replay safe；描述说出格式、要看图用 read、Markdown 图片不显示', () => {
    const tool = new ShowImageTool(ctxFor('s'))
    expect(tool.name).toBe('show_image')
    expect(tool.replay).toBe('safe')
    expect(tool.description).toBe(SHOW_IMAGE_DESCRIPTION)
    expect(tool.parameters).toBe(ShowImageParamsSchema)
    expect(SHOW_IMAGE_DESCRIPTION).toContain('PNG, JPEG, GIF, WebP or SVG')
    expect(SHOW_IMAGE_DESCRIPTION).toContain('use read')
    expect(SHOW_IMAGE_DESCRIPTION).toContain('Markdown images')
  })

  it('TI-2 schema：images 1..6，path 必填、caption 可选，caption 描述说 200', () => {
    const images = ShowImageParamsSchema.properties.images
    const bounds = images as unknown as { minItems?: number; maxItems?: number }
    expect(bounds.minItems).toBe(1)
    expect(bounds.maxItems).toBe(6)
    expect([...(images.items.required ?? [])]).toStrictEqual(['path'])
    expect(Object.keys(images.items.properties).sort()).toStrictEqual(['caption', 'path'])
    // description 是 JSON Schema 的选项，typebox 的类型上不带它：按普通对象读
    const caption = images.items.properties.caption as unknown as { description?: string }
    expect(caption.description).toContain('200')
  })
})

// ─── TI-3 / TI-4 ────────────────────────────────────────

describe('TI-3 · 张数', () => {
  it.each<[string, unknown]>([
    ['[]', []],
    ['缺', undefined],
    ['不是数组', { path: 'a.png' }]
  ])('TI-3 %s → at least one image', async (_label, images) => {
    expect(await failureText(show(images))).toContain('at least one image')
  })

  it('TI-3 7 张 → 7 images is too many / at most 6；6 张照常', async () => {
    const seven = Array.from({ length: 7 }, () => ({ path: 'a.png' }))
    const text = await failureText(show(seven))
    expect(text).toContain('7 images is too many')
    expect(text).toContain('at most 6')

    const result = await show(seven.slice(0, 6))
    expect(result.isError).not.toBe(true)
    expect(resultText(result)).toContain('Shown 6 images to the user:')
  })
})

describe('TI-4 · 每一项', () => {
  it.each<[string, unknown]>([
    ['path 缺', { caption: 'x' }],
    ['path 空串', { path: '' }],
    ['path 只有空白', { path: '  ' }],
    ['path 是数字', { path: 3 }],
    ['项是 null', null],
    ['项是字符串', 'a.png']
  ])('TI-4 %s → images[1].path must be a non-empty string', async (_label, item) => {
    expect(await failureText(show([{ path: 'a.png' }, item]))).toContain(
      'images[1].path must be a non-empty string'
    )
  })

  it('TI-4 caption 不是字符串 → images[0].caption must be a string', async () => {
    expect(await failureText(show([{ path: 'a.png', caption: 7 }]))).toContain(
      'images[0].caption must be a string'
    )
  })

  it('TI-4 caption 200 字照常，201 字 → is 201 characters; keep it to at most 200', async () => {
    const ok = await show([{ path: 'a.png', caption: 'c'.repeat(200) }])
    expect(ok.isError).not.toBe(true)
    expect(await failureText(show([{ path: 'a.png', caption: 'c'.repeat(201) }]))).toContain(
      'images[0].caption is 201 characters; keep it to at most 200'
    )
  })

  it('TI-4 任何一项不合法 → 不建快照目录（哪怕前面的项合法）', async () => {
    const sid = freshSid()
    await failureText(show([{ path: 'a.png' }, { path: 'a.png', caption: 5 }], sid))
    expect(existsSync(shownDir(sid))).toBe(false)
    const sid2 = freshSid()
    await failureText(show([{ path: 'a.png' }, { path: '' }], sid2))
    expect(existsSync(shownDir(sid2))).toBe(false)
  })
})

// ─── TI-5 / TI-6 ────────────────────────────────────────

describe('TI-5 · 正常路径', () => {
  it('TI-5 相对路径 + 工作目录外的绝对路径：结果文字逐字、details 按下标对应、content 只有文本', async () => {
    const sid = freshSid()
    const result = await show(
      [{ path: 'a.png', caption: 'Revenue' }, { path: join(HOME, 'b.png') }],
      sid
    )
    expect(result.isError).not.toBe(true)
    expect(resultText(result)).toBe(
      'Shown 2 images to the user:\n1. a.png (40×24)\n2. b.png (10×10)'
    )
    expect(result.content.every((block) => block.type === 'text')).toBe(true)
    expect(result.details).toStrictEqual({
      type: 'show_image',
      images: [
        {
          file: `${sha(A_PNG)}.png`,
          source: join(WD, 'a.png'),
          mimeType: 'image/png',
          width: 40,
          height: 24,
          bytes: A_PNG.length
        },
        {
          file: `${sha(B_PNG)}.png`,
          source: join(HOME, 'b.png'),
          mimeType: 'image/png',
          width: 10,
          height: 10,
          bytes: B_PNG.length
        }
      ]
    })
    expect(readdirSync(shownDir(sid)).sort()).toStrictEqual(
      [`${sha(A_PNG)}.png`, `${sha(B_PNG)}.png`].sort()
    )
    expect(readFileSync(join(shownDir(sid), `${sha(A_PNG)}.png`)).equals(A_PNG)).toBe(true)
  })

  it('TI-5 一张 → 单数；SVG 那行没有尺寸', async () => {
    const single = await show([{ path: 'a.png' }])
    expect(resultText(single)).toBe('Shown 1 image to the user:\n1. a.png (40×24)')

    const svg = await show([{ path: 'fig.svg' }])
    expect(resultText(svg)).toBe('Shown 1 image to the user:\n1. fig.svg')
    const details = svg.details as { images: Array<Record<string, unknown>> }
    expect(details.images[0].mimeType).toBe('image/svg+xml')
    expect(details.images[0]).not.toHaveProperty('width')
  })
})

describe('TI-6 · 没有权限点', () => {
  it('TI-6 工作目录外（假 HOME 里）的文件：安全上下文与 requestUserInput 一次都没被调', async () => {
    const saved = process.env.HOME
    process.env.HOME = HOME
    try {
      const result = await show([{ path: '~/b.png' }, { path: join(HOME, 'b.png') }])
      expect(result.isError).not.toBe(true)
    } finally {
      process.env.HOME = saved
    }
    expect(h.security).not.toHaveBeenCalled()
    expect(requestUserInput).not.toHaveBeenCalled()
  })
})

// ─── TI-7 / TI-8 ────────────────────────────────────────

describe('TI-7 · 出错', () => {
  it('TI-7 第二张不存在 → images[1].path: no such file；没有 details', async () => {
    const result = await show([{ path: 'a.png' }, { path: 'missing.png' }])
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain(`images[1].path: no such file: ${join(WD, 'missing.png')}`)
    expect(result.details).toBeUndefined()
  })

  it('TI-7 不是能摆的图 → isError', async () => {
    const result = await show([{ path: 'notes.txt' }])
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain(
      `images[0].path: ${join(WD, 'notes.txt')} is not a PNG, JPEG, GIF, WebP or SVG image`
    )
    expect(result.details).toBeUndefined()
  })

  it('TI-7 超大小 → isError，带两个字节数', async () => {
    const huge = join(WD, 'huge.png')
    writeFileSync(huge, '')
    truncateSync(huge, 20971521)
    const result = await show([{ path: 'huge.png' }])
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain(
      `images[0].path: ${huge} is 20.0MB (20971521 bytes); the limit is 20.0MB (20971520 bytes)`
    )
    expect(result.details).toBeUndefined()
  })
})

describe('TI-8 · 路径 trim', () => {
  it("TI-8 '  a.png  ' 照常解析", async () => {
    const result = await show([{ path: '  a.png  ' }])
    expect(result.isError).not.toBe(true)
    expect(resultText(result)).toBe('Shown 1 image to the user:\n1. a.png (40×24)')
  })
})

// ─── TS-1 / TS-2 ────────────────────────────────────────

describe('TS · 桌面 suggest 的带图注册', () => {
  it('TS-1 describe() 是带图的描述与 schema；factory 造出的工具也是', () => {
    const meta = registration('suggest')
    expect((meta.describe as () => unknown)()).toStrictEqual({
      description: SUGGEST_DESCRIPTION_WITH_IMAGES,
      parameters: SuggestParamsWithImagesSchema
    })
    const tool = (meta.factory as (ctx: ToolContext) => { parameters: unknown })(ctxFor('s'))
    expect(tool.parameters).toBe(SuggestParamsWithImagesSchema)
  })

  it('TS-2 相对工作目录的图 → 快照进 shown/<ctx.sessionId>/，details.images 按下标对应', async () => {
    const sid = freshSid()
    const tool = (registration('suggest').factory as (ctx: ToolContext) => never)(ctxFor(sid))
    const { result } = await invokeTool(tool, {
      suggestions: [
        { title: 'Layout A', message: 'Go with A', image: 'a.png' },
        { title: 'Plain', message: 'No picture' }
      ]
    } as never)
    expect(result.isError).not.toBe(true)
    const details = result.details as {
      type: string
      images: Array<Record<string, unknown> | null>
    }
    expect(details.type).toBe('suggest')
    expect(details.images).toHaveLength(2)
    expect(details.images[0]).toMatchObject({
      file: `${sha(A_PNG)}.png`,
      source: join(WD, 'a.png')
    })
    expect(details.images[1]).toBeNull()
    expect(existsSync(join(shownDir(sid), `${sha(A_PNG)}.png`))).toBe(true)
    expect(resultText(result)).toContain('1. Layout A (with image)\n2. Plain\n')
  })

  it('TS-2 不存在的图 → isError 点名 suggestions[1].image: no such file', async () => {
    const tool = (registration('suggest').factory as (ctx: ToolContext) => never)(
      ctxFor(freshSid())
    )
    const text = await failureText(
      invokeTool(tool, {
        suggestions: [
          { title: 'A', message: 'a', image: 'a.png' },
          { title: 'B', message: 'b', image: 'nope.png' }
        ]
      } as never).then((r) => r.result)
    )
    expect(text).toContain('suggestions[1].image: no such file')
    expect(requestUserInput).not.toHaveBeenCalled()
  })
})
