/**
 * ```artifact 引用围栏的两个纯判定（CodeBlock 导出）—— 正文里指名一件会话 Artifact，
 * 渲染它**当前**的内容。这是「对话只持有引用」的落点：转写里留下的是一行名字，不是几 KB 源码。
 *
 *  - `artifactRefName`：围栏体 → 名字。**只取第一行**（围栏里只该有一个名字，多出来的行是模型
 *    把说明写进了围栏），trim，空体不渲染引用（流式期间围栏刚开、名字还没写出来时也走这条，
 *    否则会先闪一张「找不到」卡）。语言串大小写敏感，与 ```svg 那档一致。
 *  - `artifactRefIsSvg`：取到的内容要不要按 SVG 内联。以 `<?xml …?>` 声明开头的 SVG 会落到
 *    `<pre>` 文本分支 —— **钉住现状**，别让人以为带 XML 声明的图也会被画出来。
 *
 * 组件本身要 DOM（useEffect + 宿主通道 + dangerouslySetInnerHTML），判定不要 —— 所以两个判定
 * 单独导出再单测，理由与 svgFenceIsRenderable 已经这么做过的一样。仓里没有 @testing-library，
 * 这一轮刻意不做组件测试。mermaid 的 mock 留着，但理由已经不是「起不来」：它如今在 MermaidBlock
 * 里逐次渲染时才 initialize()（CodeBlock 经 MermaidBlock 引入它），mermaid 11.16 在 node 下也能
 * import —— 顶掉是为了不让一个纯函数单测为了两个判定去加载一整个重型渲染库。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: () => {} } }))

import { artifactRefIsSvg, artifactRefName } from '../CodeBlock'

/** 与 CodeBlock 的 `lang === 'artifact'` 分发同一个字面量 */
const LANG = 'artifact'

describe('artifactRefName —— 围栏体 → 名字', () => {
  it('CR-1 单行名字原样取出', () => {
    expect(artifactRefName(LANG, 'bar-chart-by-tier.svg')).toBe('bar-chart-by-tier.svg')
    // 模型也可能写标题而不是文件名（宿主两种都解析得到）
    expect(artifactRefName(LANG, 'Requests by tier')).toBe('Requests by tier')
  })

  it('CR-2 多行只取第一行（后面的说明不进名字）', () => {
    expect(artifactRefName(LANG, 'chart.svg\n这是各档请求量的图')).toBe('chart.svg')
    expect(artifactRefName(LANG, 'chart.svg\n\nchart-2.svg')).toBe('chart.svg')
  })

  it('CR-3 前后空白与 CRLF 都 trim 掉', () => {
    expect(artifactRefName(LANG, '  chart.svg  ')).toBe('chart.svg')
    expect(artifactRefName(LANG, '\n\n  chart.svg\n')).toBe('chart.svg')
    // 围栏体带 \r 时，名字末尾的 \r 必须也被吃掉（否则查不到这件）
    expect(artifactRefName(LANG, 'chart.svg\r\n说明')).toBe('chart.svg')
  })

  it('CR-4 空体 ⇒ null（不渲染引用，落回普通代码块）', () => {
    for (const body of ['', '   ', '\n', '\r\n', ' \t\n \t']) {
      expect(artifactRefName(LANG, body)).toBeNull()
    }
  })

  it('CR-5 语言串不是小写 `artifact` ⇒ null（大小写敏感，与 ```svg 那档一致）', () => {
    for (const lang of ['ARTIFACT', 'Artifact', 'artifacts', 'svg', 'mermaid', '']) {
      expect(artifactRefName(lang, 'chart.svg'), lang).toBeNull()
    }
  })
})

describe('artifactRefIsSvg —— 内联 SVG 还是 <pre> 源码', () => {
  it('CR-6 第一个非空白字符就是 `<svg` ⇒ 内联（前导空白 / 换行不妨碍）', () => {
    expect(artifactRefIsSvg('<svg viewBox="0 0 4 4"><rect/></svg>')).toBe(true)
    expect(artifactRefIsSvg('\n  <svg/>')).toBe(true)
    // 标签名大小写不敏感（净化那一侧同样不区分）
    expect(artifactRefIsSvg('<SVG/>')).toBe(true)
  })

  it('CR-7 `<?xml` 声明开头的 SVG 落到 `<pre>` 文本分支（钉住现状）', () => {
    const declared = '<?xml version="1.0" encoding="UTF-8"?>\n<svg viewBox="0 0 4 4"><rect/></svg>'
    expect(artifactRefIsSvg(declared)).toBe(false)
    // DOCTYPE、注释开头同理
    expect(artifactRefIsSvg('<!DOCTYPE svg>\n<svg/>')).toBe(false)
    expect(artifactRefIsSvg('<!-- drawn by the agent -->\n<svg/>')).toBe(false)
  })

  it('CR-8 非 SVG 内容一律走文本分支（markdown / csv / json / 空串）', () => {
    expect(artifactRefIsSvg('# Draft\n\nbody')).toBe(false)
    expect(artifactRefIsSvg('a,b\n1,2')).toBe(false)
    expect(artifactRefIsSvg('{"a":1}')).toBe(false)
    expect(artifactRefIsSvg('')).toBe(false)
    // `<svgx>` 不是 svg（\b 挡住前缀撞名）
    expect(artifactRefIsSvg('<svgx/>')).toBe(false)
  })
})
