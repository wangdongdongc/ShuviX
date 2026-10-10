/**
 * 图导出的纯逻辑半（figureExportPure.ts）—— node 环境，不碰 DOM。
 *
 * 这一半决定的是「导出来的文件在 ShuviX 之外长什么样」里**不需要浏览器**就能定的那几件：
 *
 *   - **颜色写成 SVG 1.1 的形状**（PU-1…4）：Chromium 的计算值是 `rgb()` / `rgba()` /
 *     `color(srgb … / a)`（color-mix 的结果）—— 解析成 `#rrggbb` + 不透明度，PowerPoint /
 *     Illustrator 才认；认不出的格式回 null，交给画布兜底（那一支在 DOM 测试里）。
 *   - **`url()` 只留片段**（PU-5）：计算值里的文档地址出了 ShuviX 就指向一个不存在的文件。
 *   - **文件名**（PU-6）：非法字符、隐藏文件、码点截断、Windows 设备名。
 *   - **位图尺寸上限**（PU-7）：4000 万像素 / 单边 16384，**严格**不越。
 *   - **mermaid 标题**（PU-8）：当文件名用，流程图里一个叫 title 的节点不是标题。
 *   - **面板偏好**（PU-9…11）：缺省「当前主题 + 填充 + PNG 2x」，存储里读回来的东西逐字段校验。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FIGURE_PREFS,
  FIGURE_EXTENSION,
  MAX_RASTER_PIXELS,
  MAX_RASTER_SIDE,
  effectiveBackground,
  effectiveScale,
  figureFileBase,
  formatOpacity,
  fragmentUrlOf,
  mermaidTitleOf,
  normalizeFigurePrefs,
  parseCssColor,
  rasterSize,
  type FigureExportPrefs
} from '../figureExportPure'

/** `#rrggbb` 各分量 */
const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

/** 两个 hex 每个分量相差不超过 1 */
const expectHexNear = (actual: string | undefined, expected: string): void => {
  expect(actual, `${actual} vs ${expected}`).toMatch(/^#[0-9a-f]{6}$/)
  const a = channels(actual!)
  const e = channels(expected)
  a.forEach((v, i) => expect(Math.abs(v - e[i]), `${actual} vs ${expected}`).toBeLessThanOrEqual(1))
}

/** 字符串里有没有落单的代理项（被劈开的 emoji） */
const hasLoneSurrogate = (s: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

describe('parseCssColor —— 计算值 → #rrggbb + alpha', () => {
  it('PU-1 Chromium 吐得出来的几种格式都认', () => {
    expect(parseCssColor('rgb(42, 120, 214)')).toEqual({ hex: '#2a78d6', alpha: 1 })
    expect(parseCssColor('rgb(42 120 214)')).toEqual({ hex: '#2a78d6', alpha: 1 })
    expect(parseCssColor('rgba(42, 120, 214, 0.14)')).toEqual({ hex: '#2a78d6', alpha: 0.14 })
    expect(parseCssColor('rgb(42 120 214 / 50%)')).toEqual({ hex: '#2a78d6', alpha: 0.5 })
    expect(parseCssColor('rgb(100% 0% 50%)')).toEqual({ hex: '#ff0080', alpha: 1 })

    // color-mix() 的计算值：color(srgb r g b / a)，分量是 0…1 的小数
    const mixed = parseCssColor('color(srgb 0.165 0.471 0.839 / 0.14)')
    expectHexNear(mixed?.hex, '#2a78d6')
    expect(mixed?.alpha).toBe(0.14)
    expect(parseCssColor('color(srgb 50% 0% 100%)')).toEqual({ hex: '#8000ff', alpha: 1 })

    expect(parseCssColor('#abc')).toEqual({ hex: '#aabbcc', alpha: 1 })
    const short4 = parseCssColor('#abcd')
    expect(short4?.hex).toBe('#aabbcc')
    expect(short4?.alpha).toBeCloseTo(0xdd / 255, 10)
    expect(parseCssColor('#AABBCC')).toEqual({ hex: '#aabbcc', alpha: 1 })
    expect(parseCssColor('#aabbcc')).toEqual({ hex: '#aabbcc', alpha: 1 })
    const long8 = parseCssColor('#aabbcc80')
    expect(long8?.hex).toBe('#aabbcc')
    expect(long8?.alpha).toBeCloseTo(0.502, 3)

    expect(parseCssColor('transparent')).toEqual({ hex: '#000000', alpha: 0 })
    // 前后空白、大写函数名
    expect(parseCssColor('  RGB(42, 120, 214)  ')).toEqual({ hex: '#2a78d6', alpha: 1 })
    expect(parseCssColor('\tTRANSPARENT\n')).toEqual({ hex: '#000000', alpha: 0 })
    expect(parseCssColor(' COLOR(SRGB 1 1 1) ')).toEqual({ hex: '#ffffff', alpha: 1 })
  })

  it.each([
    'oklch(0.6 0.1 250)',
    'lab(52% 40 59)',
    'red',
    '#abcde',
    'rgb(1, 2)',
    'color(srgb 1 2)',
    'color(display-p3 1 0 0)',
    'rgb(a, b, c)',
    ''
  ])('PU-2 认不出的格式回 null（交给画布兜底）：%j', (value) => {
    expect(parseCssColor(value)).toBeNull()
  })

  it('PU-3 越界的分量与 alpha 被夹回范围内', () => {
    expect(parseCssColor('rgb(300, -5, 0)')?.hex).toBe('#ff0000')
    expect(parseCssColor('rgb(0 -5 300)')?.hex).toBe('#0000ff')
    expect(parseCssColor('rgba(1, 2, 3, 1.5)')?.alpha).toBe(1)
    expect(parseCssColor('rgb(1 2 3 / -20%)')?.alpha).toBe(0)
    expect(parseCssColor('color(srgb 2 -1 0.5 / 3)')).toEqual({ hex: '#ff0080', alpha: 1 })
  })
})

describe('formatOpacity —— 不透明度写成短数字', () => {
  it.each([
    [0.13999999999999999, '0.14'],
    [1, '1'],
    [0, '0'],
    [1.7, '1'],
    [-1, '0'],
    [0.0004, '0'],
    [0.07, '0.07'],
    [Number.NaN, '1'],
    [Number.POSITIVE_INFINITY, '1']
  ])('PU-4 %s → %s', (input, expected) => {
    expect(formatOpacity(input)).toBe(expected)
  })
})

describe('fragmentUrlOf —— url() 只留片段', () => {
  it.each([
    ['url("#a")', 'url(#a)'],
    ['url(#a)', 'url(#a)'],
    ["url('#a')", 'url(#a)'],
    ['url("file:///x/index.html#s1-grad")', 'url(#s1-grad)'],
    ['url(http://h/p#id)', 'url(#id)'],
    ['  url( "#pad" )  ', 'url(#pad)']
  ])('PU-5 %s → %s', (input, expected) => {
    expect(fragmentUrlOf(input)).toBe(expected)
  })

  it.each(['url(x.png)', 'url("#")', 'none', 'rgb(0,0,0)', ''])(
    'PU-5 不是片段引用回 null：%j',
    (input) => {
      expect(fragmentUrlOf(input)).toBeNull()
    }
  )
})

describe('figureFileBase —— 文件名主干', () => {
  it.each([null, undefined, '', '   ', '...', '. .', '///'])(
    'PU-6 空的 / 清洗后空了 → fallback：%j',
    (name) => {
      expect(figureFileBase(name, 'figure')).toBe('figure')
    }
  )

  it('PU-6 清洗规则', () => {
    expect(figureFileBase('  My  Figure ', 'f')).toBe('My Figure')
    expect(figureFileBase('a/b:c*?"<>|', 'f')).toBe('a b c')
    expect(figureFileBase('x\ny\tz', 'f')).toBe('x y z')
    // 点开头 = 隐藏文件；点结尾在 Windows 上会被吞
    expect(figureFileBase('...hidden', 'f')).toBe('hidden')
    expect(figureFileBase('name.', 'f')).toBe('name')
    // 中日韩原样留着
    expect(figureFileBase('流程图 · 发布计划', 'f')).toBe('流程图 · 发布计划')
  })

  it('PU-6 长名字按码点截到 80 以内，末尾不留空白', () => {
    const long = `${'a'.repeat(79)} ${'b'.repeat(20)}`
    const out = figureFileBase(long, 'f')
    expect(Array.from(out).length).toBeLessThanOrEqual(80)
    expect(out).toBe('a'.repeat(79))
    expect(out).not.toMatch(/\s$/)

    expect(Array.from(figureFileBase('x'.repeat(100), 'f'))).toHaveLength(80)
  })

  it('PU-6 一长串 emoji：截断不劈开代理对', () => {
    const emoji = '📊'.repeat(100)
    const out = figureFileBase(emoji, 'f')
    expect(Array.from(out)).toHaveLength(80)
    expect(hasLoneSurrogate(out)).toBe(false)
    // 50 个也是原样（不到上限）
    expect(figureFileBase('🎯'.repeat(50), 'f')).toBe('🎯'.repeat(50))
  })

  it.each([
    ['CON', 'CON_'],
    ['con', 'con_'],
    ['Nul', 'Nul_'],
    ['PRN', 'PRN_'],
    ['aux', 'aux_'],
    ['COM1', 'COM1_'],
    ['lpt9', 'lpt9_'],
    ['NUL', 'NUL_']
  ])('PU-6 Windows 保留设备名补一个下划线：%s → %s', (name, expected) => {
    expect(figureFileBase(name, 'f')).toBe(expected)
  })

  it('PU-6 只是以设备名开头的不算', () => {
    expect(figureFileBase('CONSOLE', 'f')).toBe('CONSOLE')
    expect(figureFileBase('con flow', 'f')).toBe('con flow')
  })
})

describe('effectiveScale / rasterSize —— 位图尺寸上限', () => {
  it('PU-7 放得下就照用要求的倍率', () => {
    expect(effectiveScale(320, 200, 2)).toBe(2)
    expect(effectiveScale(320, 200, 3)).toBe(3)
  })

  it.each([
    [0, 200, 2],
    [320, 0, 2],
    [320, 200, 0],
    [-1, 200, 2],
    [320, -1, 2],
    [320, 200, -2],
    [Number.NaN, 200, 2],
    [320, Number.NaN, 2],
    [320, 200, Number.NaN]
  ])('PU-7 宽高或倍率不是正数 → 0：(%s, %s, %s)', (w, h, s) => {
    expect(effectiveScale(w, h, s)).toBe(0)
  })

  it('PU-7 单边封顶 / 面积封顶', () => {
    expect(effectiveScale(20000, 10, 3)).toBeCloseTo(MAX_RASTER_SIDE / 20000, 12)
    expect(effectiveScale(10000, 10000, 3)).toBeCloseTo(Math.sqrt(0.4), 12)
  })

  it('PU-7 rasterSize 至少 1×1', () => {
    expect(rasterSize(0.2, 0.2, 1)).toEqual({ width: 1, height: 1 })
  })

  it('PU-7 10000×10000 按实际倍率：四舍五入会越界（6325² > 4000 万），落回向下取整', () => {
    const s = effectiveScale(10000, 10000, 3)
    expect(rasterSize(10000, 10000, s)).toEqual({ width: 6324, height: 6324 })
  })

  it('PU-7 一圈尺寸：实际像素严格不超 4000 万、单边严格不超 16384', () => {
    const sizes: Array<[number, number]> = [
      [320, 200],
      [10000, 10000],
      [20000, 10],
      [10, 20000],
      [12000, 12000],
      [9999, 7777],
      [4096.5, 3000.25],
      [16384, 2441.4],
      [7071.07, 7071.07],
      [3333.3, 4000],
      [1, 60000],
      [6324.9, 6324.9]
    ]
    for (const [w, h] of sizes) {
      for (const requested of [1, 2, 3]) {
        const s = effectiveScale(w, h, requested)
        expect(s, `${w}×${h}@${requested}`).toBeGreaterThan(0)
        expect(s).toBeLessThanOrEqual(requested)
        const px = rasterSize(w, h, s)
        expect(px.width * px.height, `${w}×${h}@${requested}`).toBeLessThanOrEqual(
          MAX_RASTER_PIXELS
        )
        expect(Math.max(px.width, px.height), `${w}×${h}@${requested}`).toBeLessThanOrEqual(
          MAX_RASTER_SIDE
        )
      }
    }
  })
})

describe('mermaidTitleOf —— 源码里写的标题', () => {
  it.each([
    ['---\ntitle: Flow\n---\ngraph LR\n  a --> b', 'Flow'],
    ['---\ntitle: "My Flow"\n---\ngraph LR\n  a --> b', 'My Flow'],
    ["---\ntitle: 'Quoted'\n---\ngraph LR\n  a --> b", 'Quoted'],
    ['gantt\n  title Release plan\n  section A\n  task :a1, 2024-01-01, 3d', 'Release plan'],
    ['Title: X\ngraph LR\n  a --> b', 'X']
  ])('PU-8 %j → %j', (code, expected) => {
    expect(mermaidTitleOf(code)).toBe(expected)
  })

  it.each([
    'graph LR\n  a --> b',
    'title:',
    'title:   ',
    'titleNode --> x',
    'graph TD\n  title --> b',
    'graph TD\n  title ==> b',
    'graph TD\n  title -.-> b'
  ])('PU-8 没有标题 → null：%j', (code) => {
    expect(mermaidTitleOf(code)).toBeNull()
  })

  // 回归：`\s` 曾跨过换行，空标题吃掉了下一行的 `---` 当标题；不带冒号的 `title` 同理
  it('PU-8 `title:` 留空、或 `title` 独占一行 → null（不把下一行当标题）', () => {
    expect(mermaidTitleOf('---\ntitle:\n---\ngraph TD\n  a --> b')).toBeNull()
    expect(mermaidTitleOf('gantt\n  title\n  foo')).toBeNull()
  })
})

describe('面板偏好', () => {
  it('PU-9 缺省：PNG / 当前主题 / 填充 / 2x', () => {
    expect(DEFAULT_FIGURE_PREFS).toEqual({
      format: 'png',
      scheme: 'current',
      background: true,
      scale: 2
    })
  })

  it.each([null, undefined, 42, 'png', [], ['svg'], true])(
    'PU-10 不是对象 → 整份缺省：%j',
    (raw) => {
      expect(normalizeFigurePrefs(raw)).toEqual(DEFAULT_FIGURE_PREFS)
    }
  )

  it('PU-10 合法的原样回来', () => {
    const all: FigureExportPrefs[] = []
    for (const format of ['svg', 'png', 'jpg'] as const)
      for (const scheme of ['current', 'light', 'dark'] as const)
        for (const background of [true, false])
          for (const scale of [1, 2, 3] as const) all.push({ format, scheme, background, scale })
    for (const prefs of all) expect(normalizeFigurePrefs({ ...prefs })).toEqual(prefs)
  })

  it('PU-10 坏字段各自落回缺省，好字段不受牵连；多余的键丢掉', () => {
    const good: FigureExportPrefs = { format: 'svg', scheme: 'dark', background: false, scale: 3 }
    expect(normalizeFigurePrefs({ ...good, format: 'gif' })).toEqual({ ...good, format: 'png' })
    expect(normalizeFigurePrefs({ ...good, scheme: 'auto' })).toEqual({
      ...good,
      scheme: 'current'
    })
    for (const scale of [4, '2', 2.5, 0]) {
      expect(normalizeFigurePrefs({ ...good, scale }), String(scale)).toEqual({ ...good, scale: 2 })
    }
    expect(normalizeFigurePrefs({ ...good, background: 'true' })).toEqual({
      ...good,
      background: true
    })
    const extra = normalizeFigurePrefs({ ...good, theme: 'nord', __proto__x: 1 })
    expect(Object.keys(extra).sort()).toEqual(['background', 'format', 'scale', 'scheme'])
    expect(extra).toEqual(good)
  })

  it('PU-11 JPG 一定带底色；PNG / SVG 照存的来', () => {
    expect(effectiveBackground({ ...DEFAULT_FIGURE_PREFS, format: 'jpg', background: false })).toBe(
      true
    )
    expect(effectiveBackground({ ...DEFAULT_FIGURE_PREFS, format: 'jpg', background: true })).toBe(
      true
    )
    for (const format of ['png', 'svg'] as const) {
      for (const background of [true, false]) {
        expect(effectiveBackground({ ...DEFAULT_FIGURE_PREFS, format, background })).toBe(
          background
        )
      }
    }
  })

  it('PU-12 扩展名表', () => {
    expect(FIGURE_EXTENSION).toEqual({ svg: 'svg', png: 'png', jpg: 'jpg' })
  })
})
