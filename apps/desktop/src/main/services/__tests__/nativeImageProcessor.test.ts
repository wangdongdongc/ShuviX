/**
 * createElectronImageProcessor（services/nativeImageProcessor.ts）：基于 Electron nativeImage 的图片适配。
 *
 *   I-01 4 种受支持内联格式（PNG/JPEG/GIF/WebP）合规时原样透传，不重编码
 *   I-02 精确边界（origW === maxWidth, origH === maxHeight, base64Length === maxBytes）仍走透传
 *   I-03 非零偏移 Uint8Array subarray 精确切片
 *   I-04 超宽高按比例缩放（仅超宽 / 仅超高 / 双超 / 极端长宽比下限 1px），非 JPEG 优先 toPNG()
 *   I-05 JPEG 超宽高直接 resize + toJPEG(85)，不调 toPNG()，无 convertedFrom
 *   I-06 非内联格式（image/bmp）合规时仍强制转换（优先 PNG，超限或空 Buffer 回退 JPEG）
 *   I-07 PNG 超 maxBytes 回退 JPEG 质量梯度 [85, 75, 65, 50, 35]，命中即停
 *   I-08 scale=1 全质量仍超限时叠加降采样 [0.75, 0.5, 0.35, 0.25]，resized 反映最终尺寸
 *   I-09 toPNG() / 某档 toJPEG(q) 返回空 Buffer 时跳过继续下一档
 *   I-10 损坏/空图（isEmpty()）或非正尺寸（width <= 0 || height <= 0）返回 undefined
 *   I-11 最小缩放 + 最低质量仍超限 → 返回 undefined
 *   I-12 非正 / 非有限 limits（maxWidth / maxHeight / maxBytes）→ 返回 undefined
 *   I-13 底层 API（createFromBuffer / resize / toPNG / toJPEG）抛错 → 兜底返回 undefined
 */
import { describe, expect, it, vi } from 'vitest'
import type { ImageLimits } from '@earendil-works/pi-durable/tools'

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn()
  }
}))

import {
  createElectronImageProcessor,
  type NativeImageLike,
  type NativeImageModuleLike
} from '../nativeImageProcessor'

interface FakeImageOptions {
  empty?: boolean
  width?: number
  height?: number
  toPNG?: (size: { width: number; height: number }) => Buffer
  toJPEG?: (quality: number, size: { width: number; height: number }) => Buffer
  onResize?: (
    options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' },
    child: FakeImageHandle
  ) => void
  resizeThrows?: Error
}

interface FakeImageHandle {
  readonly image: NativeImageLike
  readonly resizeCalls: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }[]
  readonly toPNGCalls: number
  readonly toJPEGCalls: number[]
  readonly children: FakeImageHandle[]
}

function makeFakeImage(options: FakeImageOptions = {}): FakeImageHandle {
  const width = options.width ?? 100
  const height = options.height ?? 100
  const resizeCalls: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }[] =
    []
  let toPNGCalls = 0
  const toJPEGCalls: number[] = []
  const children: FakeImageHandle[] = []

  const image: NativeImageLike = {
    isEmpty: () => options.empty ?? false,
    getSize: () => ({ width, height }),
    resize: (resizeOpts) => {
      resizeCalls.push(resizeOpts)
      if (options.resizeThrows !== undefined) throw options.resizeThrows
      const child = makeFakeImage({
        ...options,
        width: resizeOpts.width ?? width,
        height: resizeOpts.height ?? height
      })
      children.push(child)
      options.onResize?.(resizeOpts, child)
      return child.image
    },
    toPNG: () => {
      toPNGCalls++
      return options.toPNG ? options.toPNG({ width, height }) : Buffer.from('png-encoded')
    },
    toJPEG: (quality) => {
      toJPEGCalls.push(quality)
      return options.toJPEG
        ? options.toJPEG(quality, { width, height })
        : Buffer.from(`jpg-${quality}`)
    }
  }

  return {
    image,
    resizeCalls,
    get toPNGCalls() {
      return toPNGCalls
    },
    toJPEGCalls,
    children
  }
}

function makeApi(factory: (buffer: Buffer) => NativeImageLike): {
  api: NativeImageModuleLike
  buffers: Buffer[]
} {
  const buffers: Buffer[] = []
  return {
    api: {
      createFromBuffer: (buffer) => {
        buffers.push(buffer)
        return factory(buffer)
      }
    },
    buffers
  }
}

const DEFAULT_LIMITS: ImageLimits = { maxWidth: 2000, maxHeight: 2000, maxBytes: 1024 * 1024 }

describe('createElectronImageProcessor', () => {
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])(
    'I-01 %s within limits passes through unchanged without re-encoding',
    async (mimeType) => {
      const fake = makeFakeImage({ width: 800, height: 600 })
      const { api } = makeApi(() => fake.image)
      const processor = createElectronImageProcessor(api)
      const bytes = new Uint8Array([1, 2, 3, 4, 5, 6])

      const result = await processor.prepare(bytes, mimeType, DEFAULT_LIMITS)

      expect(result).toEqual({
        data: Buffer.from(bytes).toString('base64'),
        mimeType
      })
      expect(result?.resized).toBeUndefined()
      expect(result?.convertedFrom).toBeUndefined()
      expect(fake.resizeCalls).toHaveLength(0)
      expect(fake.toPNGCalls).toBe(0)
      expect(fake.toJPEGCalls).toHaveLength(0)
    }
  )

  it('I-02 exact boundary (origW === maxWidth, origH === maxHeight, base64Length === maxBytes) still passes through', async () => {
    const fake = makeFakeImage({ width: 2000, height: 1500 })
    const { api } = makeApi(() => fake.image)
    const processor = createElectronImageProcessor(api)
    // 9 bytes → base64Length = ceil(9/3)*4 = 12
    const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90])
    const limits: ImageLimits = { maxWidth: 2000, maxHeight: 1500, maxBytes: 12 }

    const result = await processor.prepare(bytes, 'image/png', limits)

    expect(result).toEqual({
      data: Buffer.from(bytes).toString('base64'),
      mimeType: 'image/png'
    })
    expect(fake.resizeCalls).toHaveLength(0)
    expect(fake.toPNGCalls).toBe(0)
    expect(fake.toJPEGCalls).toHaveLength(0)
  })

  it('I-03 non-zero byteOffset Uint8Array subarray slices exact bytes', async () => {
    const fake = makeFakeImage({ width: 100, height: 100 })
    const { api, buffers } = makeApi(() => fake.image)
    const processor = createElectronImageProcessor(api)
    const backing = new Uint8Array([0xff, 0xee, 0x11, 0x22, 0x33, 0x44, 0xaa, 0xbb])
    const slice = backing.subarray(2, 6) // [0x11, 0x22, 0x33, 0x44]

    const result = await processor.prepare(slice, 'image/png', DEFAULT_LIMITS)

    expect(buffers).toHaveLength(1)
    expect(Array.from(buffers[0]!)).toEqual([0x11, 0x22, 0x33, 0x44])
    expect(result).toEqual({
      data: Buffer.from([0x11, 0x22, 0x33, 0x44]).toString('base64'),
      mimeType: 'image/png'
    })
  })

  it.each([
    {
      label: 'width-only overflow',
      origW: 4000,
      origH: 1000,
      maxW: 2000,
      maxH: 2000,
      expectedW: 2000,
      expectedH: 500,
      mimeType: 'image/png',
      expectedConvertedFrom: undefined
    },
    {
      label: 'height-only overflow',
      origW: 1000,
      origH: 4000,
      maxW: 2000,
      maxH: 2000,
      expectedW: 500,
      expectedH: 2000,
      mimeType: 'image/png',
      expectedConvertedFrom: undefined
    },
    {
      label: 'both dimensions overflow',
      origW: 4000,
      origH: 3000,
      maxW: 2000,
      maxH: 1000,
      expectedW: 1333,
      expectedH: 1000,
      mimeType: 'image/webp',
      expectedConvertedFrom: 'image/webp'
    },
    {
      label: 'extreme aspect ratio clamps min dimension to 1px',
      origW: 10000,
      origH: 2,
      maxW: 100,
      maxH: 100,
      expectedW: 100,
      expectedH: 1,
      mimeType: 'image/png',
      expectedConvertedFrom: undefined
    }
  ])(
    'I-04 oversized non-JPEG ($label) scales proportionally and prefers toPNG()',
    async ({ origW, origH, maxW, maxH, expectedW, expectedH, mimeType, expectedConvertedFrom }) => {
      const encoded = Buffer.from('small-png')
      const fake = makeFakeImage({
        width: origW,
        height: origH,
        toPNG: () => encoded
      })
      const { api } = makeApi(() => fake.image)
      const processor = createElectronImageProcessor(api)

      const result = await processor.prepare(new Uint8Array([1, 2, 3]), mimeType, {
        maxWidth: maxW,
        maxHeight: maxH,
        maxBytes: 1024
      })

      expect(fake.resizeCalls).toEqual([{ width: expectedW, height: expectedH, quality: 'good' }])
      expect(fake.children[0]!.toPNGCalls).toBe(1)
      expect(fake.children[0]!.toJPEGCalls).toHaveLength(0)
      expect(result).toEqual({
        data: encoded.toString('base64'),
        mimeType: 'image/png',
        resized: {
          from: { width: origW, height: origH },
          to: { width: expectedW, height: expectedH }
        },
        ...(expectedConvertedFrom === undefined ? {} : { convertedFrom: expectedConvertedFrom })
      })
    }
  )

  it('I-05 oversized JPEG resizes and encodes directly with toJPEG(85), skipping toPNG() and without convertedFrom', async () => {
    const encoded = Buffer.from('resized-jpeg')
    const fake = makeFakeImage({
      width: 4000,
      height: 2000,
      toJPEG: () => encoded
    })
    const { api } = makeApi(() => fake.image)
    const processor = createElectronImageProcessor(api)

    const result = await processor.prepare(new Uint8Array([1, 2, 3]), 'image/jpeg', {
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 1024
    })

    expect(fake.resizeCalls).toEqual([{ width: 2000, height: 1000, quality: 'good' }])
    expect(fake.children[0]!.toPNGCalls).toBe(0)
    expect(fake.children[0]!.toJPEGCalls).toEqual([85])
    expect(result).toEqual({
      data: encoded.toString('base64'),
      mimeType: 'image/jpeg',
      resized: {
        from: { width: 4000, height: 2000 },
        to: { width: 2000, height: 1000 }
      }
    })
    expect(result?.convertedFrom).toBeUndefined()
  })

  it('I-06 non-inline image/bmp within limits still converts (PNG first, JPEG fallback on oversize or empty PNG)', async () => {
    // 优先 PNG
    const pngBytes = Buffer.from('bmp-as-png')
    const fakePng = makeFakeImage({ width: 200, height: 150, toPNG: () => pngBytes })
    const processorPng = createElectronImageProcessor(makeApi(() => fakePng.image).api)
    const resPng = await processorPng.prepare(new Uint8Array([1, 2, 3]), 'image/bmp', {
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 1024
    })
    expect(fakePng.resizeCalls).toHaveLength(0)
    expect(fakePng.toPNGCalls).toBe(1)
    expect(fakePng.toJPEGCalls).toHaveLength(0)
    expect(resPng).toEqual({
      data: pngBytes.toString('base64'),
      mimeType: 'image/png',
      convertedFrom: 'image/bmp'
    })
    expect(resPng?.resized).toBeUndefined()

    // PNG 超限时回退 JPEG
    const jpgBytes = Buffer.from('bmp-jpg')
    const fakeFallback = makeFakeImage({
      width: 200,
      height: 150,
      toPNG: () => Buffer.alloc(100), // base64 = 136 > 20
      toJPEG: () => jpgBytes // base64 = 12 <= 20
    })
    const processorJpg = createElectronImageProcessor(makeApi(() => fakeFallback.image).api)
    const resJpg = await processorJpg.prepare(new Uint8Array([1, 2, 3]), 'image/bmp', {
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 20
    })
    expect(fakeFallback.toPNGCalls).toBe(1)
    expect(fakeFallback.toJPEGCalls).toEqual([85])
    expect(resJpg).toEqual({
      data: jpgBytes.toString('base64'),
      mimeType: 'image/jpeg',
      convertedFrom: 'image/bmp'
    })

    // PNG 返回空 Buffer 时回退 JPEG
    const fakeEmptyPng = makeFakeImage({
      width: 200,
      height: 150,
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => jpgBytes
    })
    const processorEmptyPng = createElectronImageProcessor(makeApi(() => fakeEmptyPng.image).api)
    const resEmptyPng = await processorEmptyPng.prepare(new Uint8Array([1, 2, 3]), 'image/bmp', {
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 20
    })
    expect(fakeEmptyPng.toPNGCalls).toBe(1)
    expect(fakeEmptyPng.toJPEGCalls).toEqual([85])
    expect(resEmptyPng).toEqual({
      data: jpgBytes.toString('base64'),
      mimeType: 'image/jpeg',
      convertedFrom: 'image/bmp'
    })
  })

  it('I-07 PNG exceeding maxBytes falls back to JPEG quality ladder [85, 75, 65, 50, 35] and stops on first hit', async () => {
    const hitBytes = Buffer.from('q65-ok') // base64 = 8 <= 16
    const fake = makeFakeImage({
      width: 800,
      height: 600,
      toPNG: () => Buffer.alloc(60), // base64 = 80 > 16
      toJPEG: (q) => (q <= 65 ? hitBytes : Buffer.alloc(30)) // base64 = 40 > 16 for 85/75
    })
    const { api } = makeApi(() => fake.image)
    const processor = createElectronImageProcessor(api)

    const result = await processor.prepare(new Uint8Array(40), 'image/png', {
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 16
    })

    expect(fake.resizeCalls).toHaveLength(0)
    expect(fake.toPNGCalls).toBe(1)
    expect(fake.toJPEGCalls).toEqual([85, 75, 65])
    expect(result).toEqual({
      data: hitBytes.toString('base64'),
      mimeType: 'image/jpeg',
      convertedFrom: 'image/png'
    })
    expect(result?.resized).toBeUndefined()
  })

  it('I-08 when scale=1 exceeds maxBytes at all qualities, steps through [0.75, 0.5, 0.35, 0.25] and reports final resized dimensions', async () => {
    const hitBytes = Buffer.from('half-q75') // base64 = 12 <= 16
    const attempts: string[] = []
    const fake = makeFakeImage({
      width: 1000,
      height: 800,
      toPNG: () => Buffer.alloc(60),
      toJPEG: (q, size) => {
        attempts.push(`${size.width}x${size.height}@${q}`)
        if (size.width <= 500 && q <= 75) return hitBytes
        return Buffer.alloc(30) // base64 = 40 > 16
      }
    })
    const { api } = makeApi(() => fake.image)
    const processor = createElectronImageProcessor(api)

    const result = await processor.prepare(new Uint8Array(40), 'image/png', {
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 16
    })

    expect(fake.resizeCalls).toEqual([
      { width: 750, height: 600, quality: 'good' },
      { width: 500, height: 400, quality: 'good' }
    ])
    expect(attempts).toEqual([
      '1000x800@85',
      '1000x800@75',
      '1000x800@65',
      '1000x800@50',
      '1000x800@35',
      '750x600@85',
      '750x600@75',
      '750x600@65',
      '750x600@50',
      '750x600@35',
      '500x400@85',
      '500x400@75'
    ])
    expect(result).toEqual({
      data: hitBytes.toString('base64'),
      mimeType: 'image/jpeg',
      convertedFrom: 'image/png',
      resized: {
        from: { width: 1000, height: 800 },
        to: { width: 500, height: 400 }
      }
    })
  })

  it('I-09 empty Buffer from toPNG() or a toJPEG(q) tier is skipped in favor of subsequent tiers', async () => {
    const okBytes = Buffer.from('q65')
    const fake = makeFakeImage({
      width: 500,
      height: 500,
      toPNG: () => Buffer.alloc(0),
      toJPEG: (q) => (q === 85 || q === 75 ? Buffer.alloc(0) : okBytes)
    })
    const { api } = makeApi(() => fake.image)
    const processor = createElectronImageProcessor(api)

    const result = await processor.prepare(new Uint8Array(40), 'image/png', {
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 16
    })

    expect(fake.toPNGCalls).toBe(1)
    expect(fake.toJPEGCalls).toEqual([85, 75, 65])
    expect(result).toEqual({
      data: okBytes.toString('base64'),
      mimeType: 'image/jpeg',
      convertedFrom: 'image/png'
    })
  })

  it('I-10 corrupt/empty image or non-positive dimensions return undefined', async () => {
    const emptyImg = makeFakeImage({ empty: true, width: 100, height: 100 })
    const pEmpty = createElectronImageProcessor(makeApi(() => emptyImg.image).api)
    expect(
      await pEmpty.prepare(new Uint8Array([1, 2, 3]), 'image/png', DEFAULT_LIMITS)
    ).toBeUndefined()

    for (const [width, height] of [
      [0, 100],
      [100, 0],
      [-10, 100],
      [100, -10]
    ] as const) {
      const badSize = makeFakeImage({ width, height })
      const proc = createElectronImageProcessor(makeApi(() => badSize.image).api)
      expect(
        await proc.prepare(new Uint8Array([1, 2, 3]), 'image/png', DEFAULT_LIMITS)
      ).toBeUndefined()
    }
  })

  it('I-11 returns undefined when even minimum scale (0.25) and lowest quality (35) exceed maxBytes', async () => {
    const fake = makeFakeImage({
      width: 1000,
      height: 1000,
      toPNG: () => Buffer.alloc(100),
      toJPEG: () => Buffer.alloc(100) // base64 = 136 > 16
    })
    const { api } = makeApi(() => fake.image)
    const processor = createElectronImageProcessor(api)

    const result = await processor.prepare(new Uint8Array(40), 'image/png', {
      maxWidth: 2000,
      maxHeight: 2000,
      maxBytes: 16
    })

    expect(result).toBeUndefined()
    // 尝试了 0.75, 0.5, 0.35, 0.25 全部 4 档额外降采样
    expect(fake.resizeCalls).toEqual([
      { width: 750, height: 750, quality: 'good' },
      { width: 500, height: 500, quality: 'good' },
      { width: 350, height: 350, quality: 'good' },
      { width: 250, height: 250, quality: 'good' }
    ])
  })

  it.each<ImageLimits>([
    { maxWidth: 0, maxHeight: 2000, maxBytes: 1024 },
    { maxWidth: -1, maxHeight: 2000, maxBytes: 1024 },
    { maxWidth: Number.NaN, maxHeight: 2000, maxBytes: 1024 },
    { maxWidth: Number.POSITIVE_INFINITY, maxHeight: 2000, maxBytes: 1024 },
    { maxWidth: 2000, maxHeight: 0, maxBytes: 1024 },
    { maxWidth: 2000, maxHeight: -10, maxBytes: 1024 },
    { maxWidth: 2000, maxHeight: Number.NaN, maxBytes: 1024 },
    { maxWidth: 2000, maxHeight: Number.NEGATIVE_INFINITY, maxBytes: 1024 },
    { maxWidth: 2000, maxHeight: 2000, maxBytes: 0 },
    { maxWidth: 2000, maxHeight: 2000, maxBytes: -5 },
    { maxWidth: 2000, maxHeight: 2000, maxBytes: Number.NaN },
    { maxWidth: 2000, maxHeight: 2000, maxBytes: Number.POSITIVE_INFINITY }
  ])(
    'I-12 non-positive or non-finite limits (%o) return undefined without decoding',
    async (limits) => {
      const createFromBuffer = vi.fn()
      const processor = createElectronImageProcessor({ createFromBuffer })
      expect(
        await processor.prepare(new Uint8Array([1, 2, 3]), 'image/png', limits)
      ).toBeUndefined()
      expect(createFromBuffer).not.toHaveBeenCalled()
    }
  )

  it('I-13 underlying nativeImage errors (createFromBuffer / resize / toPNG / toJPEG) degrade to undefined', async () => {
    const pCreate = createElectronImageProcessor({
      createFromBuffer: () => {
        throw new Error('corrupt stream')
      }
    })
    expect(
      await pCreate.prepare(new Uint8Array([1, 2, 3]), 'image/png', DEFAULT_LIMITS)
    ).toBeUndefined()

    const resizeErr = makeFakeImage({
      width: 4000,
      height: 4000,
      resizeThrows: new Error('resize OOM')
    })
    const pResize = createElectronImageProcessor(makeApi(() => resizeErr.image).api)
    expect(
      await pResize.prepare(new Uint8Array([1, 2, 3]), 'image/png', DEFAULT_LIMITS)
    ).toBeUndefined()

    const pngErr = makeFakeImage({
      width: 4000,
      height: 4000,
      toPNG: () => {
        throw new Error('png encode failed')
      }
    })
    const pPng = createElectronImageProcessor(makeApi(() => pngErr.image).api)
    expect(
      await pPng.prepare(new Uint8Array([1, 2, 3]), 'image/png', DEFAULT_LIMITS)
    ).toBeUndefined()

    const jpgErr = makeFakeImage({
      width: 4000,
      height: 4000,
      toJPEG: () => {
        throw new Error('jpeg encode failed')
      }
    })
    const pJpg = createElectronImageProcessor(makeApi(() => jpgErr.image).api)
    expect(
      await pJpg.prepare(new Uint8Array([1, 2, 3]), 'image/jpeg', DEFAULT_LIMITS)
    ).toBeUndefined()
  })
})
