/**
 * ```artifact 引用围栏的两个纯函数（artifactFence.ts）—— 渲染端（CodeBlock）与宿主钉版本（桌面
 * services/artifacts/pins.ts）读同一份取名规则，钉下的名字才查得到。
 *
 *   AF-1 artifactRefName：只认小写 `artifact`；取 trim 后的第一行；空体 → null
 *   AF-2 artifactFenceNames：按出现顺序、去重；标题与文件名都照写下的样子收（各算一个名字）；
 *        非引用围栏、空体不收
 *   AF-3 只收闭合的：没写完的不收；``` 开的只认 ``` 收（~~~ 不算），~~~ 开的同理；`~~~artifact` 也是引用；
 *        4 个反引号开的，3 个收不了、5 个收得了；收尾后面只能有空白；CRLF 换行照常
 *   AF-4 缩进 0–3 格是围栏，4 格是缩进代码块（开头与收尾都一样）；info string 取第一个词
 *        （`artifact foo` 是引用，`artifactx` 不是）；反引号围栏的 info 里带反引号就不是围栏
 *   AF-5 别的围栏里的 ```artifact（````md 示例）只是那段代码的内容；引用块 / 列表里的围栏**不解析**
 *        （文档写明的取舍：模型的回复里不这么写）—— 钉住现状
 */
import { describe, expect, it } from 'vitest'
import { ARTIFACT_FENCE_LANG, artifactFenceNames, artifactRefName } from './artifactFence'

/** 一段闭合的引用围栏 */
const ref = (body: string, open = '```artifact', close = '```'): string =>
  `${open}\n${body}\n${close}`

describe('artifactRefName', () => {
  it('AF-1 只认小写 artifact；第一行、trim；空体 → null', () => {
    expect(ARTIFACT_FENCE_LANG).toBe('artifact')
    expect(artifactRefName('artifact', 'chart.svg')).toBe('chart.svg')
    expect(artifactRefName('artifact', '  chart.svg  \nexplanation')).toBe('chart.svg')
    expect(artifactRefName('artifact', '\n\n  Requests by tier \n')).toBe('Requests by tier')
    expect(artifactRefName('artifact', 'chart.svg\r\nmore')).toBe('chart.svg')
    for (const body of ['', '  ', '\n', '\r\n', ' \t\n'])
      expect(artifactRefName('artifact', body), JSON.stringify(body)).toBeNull()
    for (const lang of ['Artifact', 'ARTIFACT', 'artifacts', 'svg', ''])
      expect(artifactRefName(lang, 'chart.svg'), lang).toBeNull()
  })
})

describe('artifactFenceNames', () => {
  it('AF-2 按出现顺序、去重；标题与文件名各算一个；非引用 / 空体不收', () => {
    const md = [
      'Intro text.',
      ref('b.svg'),
      'between',
      ref('a.svg'),
      '```svg',
      '<svg/>',
      '```',
      ref('b.svg'),
      ref('Bar chart'),
      ref('bar-chart.svg\nthe second line is not a name'),
      '```artifact',
      '',
      '```',
      'end'
    ].join('\n')
    expect(artifactFenceNames(md)).toEqual(['b.svg', 'a.svg', 'Bar chart', 'bar-chart.svg'])
    expect(artifactFenceNames('')).toEqual([])
    expect(artifactFenceNames('no fences at all')).toEqual([])
  })

  it('AF-3 只收闭合的；收尾同一种字符、不短于开头；~~~artifact；CRLF', () => {
    // 没写完（流式中、或模型忘了收尾）
    expect(artifactFenceNames('```artifact\nchart.svg')).toEqual([])
    expect(artifactFenceNames(`${ref('a.svg')}\n\`\`\`artifact\nb.svg\n`)).toEqual(['a.svg'])
    // ``` 开的，~~~ 收不了（于是没闭合）；反过来也一样
    expect(artifactFenceNames('```artifact\na.svg\n~~~')).toEqual([])
    expect(artifactFenceNames('~~~artifact\na.svg\n```')).toEqual([])
    // ~~~ 开的就是 ~~~ 收
    expect(artifactFenceNames(ref('tilde.svg', '~~~artifact', '~~~'))).toEqual(['tilde.svg'])
    expect(artifactFenceNames(ref('tilde.svg', '~~~~artifact', '~~~~~'))).toEqual(['tilde.svg'])
    // 4 个反引号开的：3 个只是内容、仍没闭合；4 / 5 个才收
    expect(artifactFenceNames('````artifact\nfour.svg\n```')).toEqual([])
    expect(artifactFenceNames(ref('four.svg', '````artifact', '````'))).toEqual(['four.svg'])
    expect(artifactFenceNames(ref('four.svg', '````artifact', '`````'))).toEqual(['four.svg'])
    // 收尾后面只能有空白：```x 不是收尾
    expect(artifactFenceNames('```artifact\na.svg\n```x\n')).toEqual([])
    expect(artifactFenceNames('```artifact\na.svg\n```  \t\n')).toEqual(['a.svg'])
    // CRLF：名字末尾不留 \r
    expect(artifactFenceNames('Text\r\n```artifact\r\ncrlf.svg\r\n```\r\nafter')).toEqual([
      'crlf.svg'
    ])
  })

  it('AF-4 缩进 0–3 格是围栏、4 格不是；info string 取第一个词；反引号 info 里带反引号不是围栏', () => {
    for (const indent of ['', ' ', '  ', '   ']) {
      expect(
        artifactFenceNames(ref('i.svg', `${indent}\`\`\`artifact`, `${indent}\`\`\``)),
        JSON.stringify(indent)
      ).toEqual(['i.svg'])
    }
    // 收尾缩进与开头无关，只要 ≤3 格
    expect(artifactFenceNames('```artifact\ni.svg\n   ```')).toEqual(['i.svg'])
    // 4 格：缩进代码块，不是围栏
    expect(artifactFenceNames(ref('i.svg', '    ```artifact', '    ```'))).toEqual([])
    // 开头 ≤3、收尾 4 格：收尾不算，没闭合
    expect(artifactFenceNames('```artifact\ni.svg\n    ```')).toEqual([])

    // info string 的第一个词
    expect(artifactFenceNames(ref('foo.svg', '```artifact foo'))).toEqual(['foo.svg'])
    expect(artifactFenceNames(ref('foo.svg', '```  artifact\tlabel="x"'))).toEqual(['foo.svg'])
    expect(artifactFenceNames(ref('foo.svg', '```artifactx'))).toEqual([])
    expect(artifactFenceNames(ref('foo.svg', '```Artifact'))).toEqual([])
    // 反引号围栏的 info 里不能有反引号（那是行内代码）；~~~ 的可以
    expect(artifactFenceNames(ref('foo.svg', '```artifact `x`'))).toEqual([])
    expect(artifactFenceNames(ref('foo.svg', '~~~artifact `x`', '~~~'))).toEqual(['foo.svg'])
  })

  it('AF-5 别的围栏里的引用只是内容；引用块 / 列表里的围栏不解析（钉住现状）', () => {
    // 一段 ````md 示例里写着 ```artifact：那是示例的内容，不是引用
    const example = [
      'Here is how to reference one:',
      '````md',
      '```artifact',
      'inside-example.svg',
      '```',
      '````',
      ref('real.svg')
    ].join('\n')
    expect(artifactFenceNames(example)).toEqual(['real.svg'])
    // ~~~ 包着的 ``` 同理
    expect(
      artifactFenceNames(['~~~', '```artifact', 'nested.svg', '```', '~~~'].join('\n'))
    ).toEqual([])
    // 普通代码块里的一行 ```artifact 也不算（它在别的围栏里）
    expect(artifactFenceNames(['```ts', '```artifact', 'x.svg'].join('\n'))).toEqual([])

    // 文档写明的限制：引用块、列表里的围栏不解析（渲染端会画出来，但宿主不为它钉版本）
    expect(artifactFenceNames(['> ```artifact', '> quoted.svg', '> ```'].join('\n'))).toEqual([])
    expect(artifactFenceNames(['- ```artifact', '  listed.svg', '  ```'].join('\n'))).toEqual([])
    expect(artifactFenceNames(['1. ```artifact', '   listed.svg', '   ```'].join('\n'))).toEqual([])
  })
})
