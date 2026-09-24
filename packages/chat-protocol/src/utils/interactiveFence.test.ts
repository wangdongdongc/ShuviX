/**
 * ```interactive 围栏的纯件（utils/interactiveFence.ts）—— 沙箱文档怎么拼、桥消息怎么验、
 * 流式中围栏闭合没有，以及「教给模型的」与「这里定的常量」是不是同一份。
 *
 * 隔离靠 iframe（`sandbox="allow-scripts"`，不透明源），不靠这里的任何过滤 —— 模型写的整段
 * 标记原样进 srcdoc。所以这里钉的是 iframe 之外、**这一层自己**担的那几条：
 *
 *  - **CSP 表**（IF-1…3）：没有任何网络出口；一个松动的记号（`*`、`https:`、`'unsafe-eval'`、
 *    一个主机名）就是一条出口。它还要能原样塞进 `content="…"` —— 带引号或尖括号就拆了属性，
 *    而 artifact 的 `titleOf` 跳过开头那行 meta 靠的是 `<meta\b[^>]*>`，里面不能有 `>`。
 *  - **文档顺序**（IF-4…6）：meta CSP 排第一（meta 只能收紧、写在后面的改不动前面的），模型内容
 *    排最后且一字不改；桥脚本不能被自己的内容提前闭合。
 *  - **token 过滤**（IF-7 / 8）：值来自宿主 getComputedStyle，但拼进 `<style>` 前仍按形状过一遍 ——
 *    一个带 `}` 或 `</style>` 的值就能跳出 `:root{…}`。
 *  - **桥消息**（IF-9…11）：数据来自模型写的代码，按不可信处理；超长的 prompt 丢弃而不是截断。
 *  - **闭合判定**（IF-12 / 13）：交互图不能逐帧画，半截脚本跑起来只会报错 —— 判定必须确切。
 *  - **契约同源**（IF-14…18）：库名、token 名单、高度上限这些常量，与提示片段 / 技能参考里教给
 *    模型的写法是同一份。片段与技能 md 用 fs 读（与 svgFence.test.ts 同策：chat-protocol 是零依赖
 *    叶子包，一条 import 会凭空造出一个反向的包依赖，读文本不会）。
 *
 * 已知管不到的两条出口（WebRTC、DNS 预取）在源文件头注释里写着，这里不断言它们被挡住。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INTERACTIVE_FENCE_LANG,
  SANDBOX_CSP,
  SANDBOX_LIBS,
  SANDBOX_LIB_SCHEME,
  SANDBOX_MAX_HEIGHT,
  SANDBOX_PROMPT_MAX,
  SANDBOX_THEME_TOKENS,
  buildSandboxDocument,
  clampSandboxHeight,
  fenceSourceIsClosed,
  parseSandboxMessage,
  sandboxLibUrl
} from './interactiveFence'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `packages/chat-protocol/src/utils` 往上四层 */
const REPO_ROOT = resolve(HERE, '../../../..')

const LANGUAGES = ['en', 'zh', 'ja'] as const

/** 三份 visual-guide 片段（`?raw` 内联的那批）—— fs 读，不 import（理由见文件头） */
const FRAGMENTS = LANGUAGES.map((lang) => {
  const file = lang === 'en' ? 'visual-guide.md' : `visual-guide.${lang}.md`
  return {
    name: `fragments/${file}`,
    text: readFileSync(
      join(REPO_ROOT, 'packages/agent-runtime/src/agentProfile/fragments', file),
      'utf8'
    )
  }
})

/** 三份作图技能的交互块参考（ja 是英文副本，照样过一遍） */
const SKILL_REFS = LANGUAGES.map((lang) => ({
  name: `skills/${lang}/drawing/references/interactive.md`,
  text: readFileSync(
    join(REPO_ROOT, 'apps/desktop/resources/skills', lang, 'drawing/references/interactive.md'),
    'utf8'
  )
}))

const START = '<!-- shuvix:interactive-start -->'
const END = '<!-- shuvix:interactive-end -->'

/** 片段里 interactive 界桩圈出的那一段（不含界桩）；找不到界桩直接判失败 */
const interactiveSection = (text: string, name: string): string => {
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  expect(start, `${name} 缺 interactive-start 界桩`).toBeGreaterThanOrEqual(0)
  expect(end, `${name} 的 interactive-end 不在 start 之后`).toBeGreaterThan(start)
  return text.slice(start + START.length, end)
}

/** SANDBOX_CSP → 指令名 → 记号列表 */
const cspDirectives = (): Map<string, string[]> =>
  new Map(
    SANDBOX_CSP.split('; ').map((part) => {
      const [name, ...tokens] = part.split(' ')
      return [name, tokens] as const
    })
  )

/** 子串出现次数 */
const countOf = (text: string, needle: string): number => text.split(needle).length - 1

/** 一份不带脚本的缺省文档（结构类用例用） */
const plainDoc = (body = 'X'): string =>
  buildSandboxDocument({ body, tokens: {}, colorScheme: 'light' })

/** 文档里 `</head><body>` 之前的那一截（宿主拼的部分；模型内容全在它之后） */
const headOf = (doc: string): string => {
  const at = doc.indexOf('</head><body>')
  expect(at, '文档里找不到 </head><body>').toBeGreaterThan(0)
  return doc.slice(0, at)
}

/** 桥脚本本体（`<script>` 与 `</script>` 之间） */
const bridgeOf = (doc: string): string => {
  const open = doc.indexOf('<script>')
  const close = doc.indexOf('</script>')
  expect(open, '文档里找不到桥脚本').toBeGreaterThan(0)
  return doc.slice(open + '<script>'.length, close)
}

/** 片段 / 技能里提到的 `shuvix-lib://<name>` 的名字 */
const libNamesIn = (text: string): string[] =>
  [...text.matchAll(/shuvix-lib:\/\/([a-z0-9][a-z0-9._-]*[a-z0-9])/gi)].map((m) => m[1])

/** 文本里用到的 `--token`（去重） */
const tokensIn = (text: string): string[] => [
  ...new Set([...text.matchAll(/--[A-Za-z][A-Za-z0-9-]*/g)].map((m) => m[0]))
]

describe('SANDBOX_CSP —— 没有任何网络出口（IF-1…3）', () => {
  it('IF-1 指令表恰是这十二条；该是 none 的都是 none，脚本只有内联与 shuvix-lib:，媒体只有 data:', () => {
    const map = cspDirectives()
    expect([...map.keys()].sort()).toEqual(
      [
        'default-src',
        'script-src',
        'style-src',
        'img-src',
        'font-src',
        'media-src',
        'connect-src',
        'frame-src',
        'worker-src',
        'object-src',
        'form-action',
        'base-uri'
      ].sort()
    )
    for (const name of [
      'default-src',
      'connect-src',
      'frame-src',
      'worker-src',
      'object-src',
      'form-action',
      'base-uri'
    ]) {
      expect(map.get(name), name).toEqual(["'none'"])
    }
    expect([...map.get('script-src')!].sort()).toEqual(["'unsafe-inline'", 'shuvix-lib:'].sort())
    expect(map.get('style-src')).toEqual(["'unsafe-inline'"])
    for (const name of ['img-src', 'font-src', 'media-src']) {
      expect(map.get(name), name).toEqual(['data:'])
    }
  })

  it('IF-2 整条策略里没有任何放宽的记号：unsafe-eval / * / http: / https: / blob: / self / 主机名', () => {
    const tokens = [...cspDirectives().values()].flat()
    expect(tokens.length).toBeGreaterThan(10) // 正控制组：确实拆出了记号
    for (const bad of ["'unsafe-eval'", '*', 'http:', 'https:', 'blob:', "'self'"]) {
      expect(tokens, bad).not.toContain(bad)
    }
    // 白名单式再兜一层：出现的记号只能是这四种 —— 任何主机名、任何别的协议都会落在外面
    for (const token of tokens) {
      expect(["'none'", "'unsafe-inline'", `${SANDBOX_LIB_SCHEME}:`, 'data:'], token).toContain(
        token
      )
    }
    expect(SANDBOX_CSP).not.toMatch(/\*|:\/\/|\.\w/)
  })

  it('IF-3 能原样塞进属性值：不含 `"` / `<` / `>`（titleOf 跳过开头 meta 靠的就是 meta 里没有 `>`）', () => {
    for (const ch of ['"', '<', '>']) expect(SANDBOX_CSP, ch).not.toContain(ch)
  })
})

describe('buildSandboxDocument —— 顺序就是安全前提（IF-4…8）', () => {
  it('IF-4 以 doctype + charset + meta CSP 开头；CSP meta < <style> < <script> < <body> < 模型内容', () => {
    const doc = plainDoc('X')
    expect(
      doc.startsWith(
        '<!doctype html><html><head><meta charset="utf-8">\n' +
          `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`
      )
    ).toBe(true)
    const at = (needle: string): number => doc.indexOf(needle)
    const order = [
      at('http-equiv="Content-Security-Policy"'),
      at('<style>'),
      at('<script>'),
      at('<body>'),
      doc.lastIndexOf('X')
    ]
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('IF-5 模型内容逐字节原样放进 body（实体、`</body></html>`、反引号、CJK、制表符、自带的松 CSP 都不动）', () => {
    const body =
      '<head><meta http-equiv="Content-Security-Policy" content="default-src *"></head>\n' +
      '<p>a &amp; b — 中文 \t `${x}` ``tpl``</p>\n</body></html>\n<p>after</p>'
    const doc = plainDoc(body)
    expect(doc.endsWith(`<body>\n${body}\n</body></html>`)).toBe(true)
    // 宿主拼的那截里恰好一条 CSP；模型自带的那条在 body 里（按规范不生效），不会跑到前面去
    expect(countOf(headOf(doc), 'Content-Security-Policy')).toBe(1)
    expect(countOf(doc, 'Content-Security-Policy')).toBe(2)
    expect(doc.indexOf('default-src *')).toBeGreaterThan(doc.indexOf('<body>'))
  })

  it('IF-6 桥不会被自己提前闭合：无脚本的内容下恰一对 <script></script>、一个 </style>，head 里只有那一个 </script', () => {
    const doc = plainDoc('<p>no script here</p>')
    expect(countOf(doc, '<script>')).toBe(1)
    expect(countOf(doc, '</script>')).toBe(1)
    expect(countOf(doc, '</style>')).toBe(1)
    expect([...headOf(doc).matchAll(/<\/script/gi)]).toHaveLength(1)
  })

  it('IF-7 token 按形状过滤：名字不像 `--x`、值带 < > { } ; \\ 或空白的一律丢，保留的值去掉首尾空白', () => {
    const doc = buildSandboxDocument({
      body: 'X',
      colorScheme: 'light',
      tokens: {
        '--viz-1': ' #123 ',
        '--ok': 'light-dark(#fff, #000)',
        color: 'red',
        '--x;}': 'red',
        '--a': 'red</style><script>',
        '--b': 'a{b}',
        '--c': 'x;y',
        '--d': 'a\\b',
        '--e': '  '
      }
    })
    const root = /:root\{([^}]*)\}/.exec(doc)
    expect(root, '找不到 :root{…}').not.toBeNull()
    expect(root![1]).toBe('color-scheme:light;--viz-1:#123;--ok:light-dark(#fff, #000)')
    for (const gone of ['--x;}', '--a:', '--b:', '--c:', '--d:', '--e:', 'color:red']) {
      expect(doc, gone).not.toContain(gone)
    }
    for (const value of ['red</style>', 'a{b}', 'x;y', 'a\\b']) {
      expect(doc, value).not.toContain(value)
    }
    // 跳出 :root 的那一招若得逞，head 里就会多出一对 style / script
    expect(countOf(doc, '</style>')).toBe(1)
    expect(countOf(doc, '<script>')).toBe(1)
  })

  it('IF-8 color-scheme 只认那几个值（去首尾空白）；别的一律 normal', () => {
    const schemeOf = (colorScheme: string): string | undefined =>
      /:root\{(color-scheme:[^;}]*)/.exec(
        buildSandboxDocument({ body: '', tokens: {}, colorScheme })
      )?.[1]
    expect(schemeOf('dark')).toBe('color-scheme:dark')
    expect(schemeOf(' light dark ')).toBe('color-scheme:light dark')
    for (const bad of ['dark;background:red', '', 'only light']) {
      expect(schemeOf(bad), JSON.stringify(bad)).toBe('color-scheme:normal')
    }
  })
})

describe('parseSandboxMessage / clampSandboxHeight —— 桥消息按不可信处理（IF-9…11）', () => {
  it('IF-9 收下的形状：高度原样（0 与小数都行）；prompt 去首尾空白；恰 2000 字收；多余字段不带出来', () => {
    expect(parseSandboxMessage({ __shuvix: 1, type: 'resize', height: 0 })).toEqual({
      type: 'resize',
      height: 0
    })
    expect(parseSandboxMessage({ __shuvix: 1, type: 'resize', height: 300.5 })).toEqual({
      type: 'resize',
      height: 300.5
    })
    expect(parseSandboxMessage({ __shuvix: 1, type: 'prompt', text: '  hi \n' })).toEqual({
      type: 'prompt',
      text: 'hi'
    })
    const max = 'x'.repeat(SANDBOX_PROMPT_MAX)
    expect(SANDBOX_PROMPT_MAX).toBe(2000)
    expect(parseSandboxMessage({ __shuvix: 1, type: 'prompt', text: `  ${max}  ` })).toEqual({
      type: 'prompt',
      text: max
    })
    // 多余字段（包括标记本身）不进结果 —— 结果只有 type 与那一个载荷
    expect(
      parseSandboxMessage({ __shuvix: 1, type: 'resize', height: 5, extra: 'x', text: 'y' })
    ).toStrictEqual({ type: 'resize', height: 5 })
    expect(
      parseSandboxMessage({ __shuvix: 1, type: 'prompt', text: 'go', height: 9 })
    ).toStrictEqual({ type: 'prompt', text: 'go' })
  })

  it('IF-10 拒收 → null：非对象、没标记 / 标记不是 1、未知 type、坏高度、坏文字、超长（丢弃而非截断）', () => {
    const rejected: unknown[] = [
      null,
      undefined,
      'x',
      42,
      { type: 'resize', height: 1 },
      { __shuvix: true, type: 'resize', height: 1 },
      { __shuvix: '1', type: 'resize', height: 1 },
      { __shuvix: 2, type: 'resize', height: 1 },
      { __shuvix: 1, type: 'navigate', url: 'x' },
      { __shuvix: 1 },
      { __shuvix: 1, type: 'resize', height: -1 },
      { __shuvix: 1, type: 'resize', height: Number.NaN },
      { __shuvix: 1, type: 'resize', height: Number.POSITIVE_INFINITY },
      { __shuvix: 1, type: 'resize', height: '100' },
      { __shuvix: 1, type: 'resize' },
      { __shuvix: 1, type: 'prompt', text: 42 },
      { __shuvix: 1, type: 'prompt', text: '' },
      { __shuvix: 1, type: 'prompt', text: '   ' },
      { __shuvix: 1, type: 'prompt', text: 'x'.repeat(SANDBOX_PROMPT_MAX + 1) }
    ]
    for (const data of rejected) {
      expect(parseSandboxMessage(data), JSON.stringify(data)?.slice(0, 60)).toBeNull()
    }
  })

  it('IF-11 高度先向上取整、再夹进 40…720', () => {
    expect(clampSandboxHeight(0)).toBe(40)
    expect(clampSandboxHeight(39.2)).toBe(40)
    expect(clampSandboxHeight(40.1)).toBe(41)
    expect(clampSandboxHeight(720)).toBe(720)
    expect(clampSandboxHeight(720.5)).toBe(720)
    expect(clampSandboxHeight(1e6)).toBe(720)
  })
})

describe('fenceSourceIsClosed —— 流式中这一截围栏写完了没有（IF-12 / 13）', () => {
  it('IF-12 闭合：常规、尾随空行、更长的闭栅栏、~~~、闭栅栏后有空格、引用块、列表缩进、CRLF', () => {
    const closed = [
      '```interactive\n<p>x</p>\n```',
      '```interactive\nx\n```\n\n\n',
      '```interactive\nx\n`````',
      '~~~interactive\nx\n~~~',
      '```interactive\nx\n```   ',
      '```interactive\n> x\n> ```',
      '> ```interactive\n> x\n> ```',
      '```interactive\n   x\n   ```',
      '```interactive\r\nx\r\n```\r\n'
    ]
    for (const slice of closed) expect(fenceSourceIsClosed(slice), JSON.stringify(slice)).toBe(true)
  })

  it('IF-13 没闭合：只有一行、没写到闭栅栏、闭栅栏只写了两个反引号、闭的比开的短、字符不同、闭栅栏带语言、首行不是栅栏', () => {
    const open = [
      '```interactive',
      '```interactive\nx\ny',
      '```interactive\nx\n``',
      '````interactive\nx\n```',
      '~~~interactive\nx\n```',
      '```interactive\nx\n```js',
      'intro\nx\n```'
    ]
    for (const slice of open) expect(fenceSourceIsClosed(slice), JSON.stringify(slice)).toBe(false)
  })
})

describe('契约同源：常量 ↔ 教给模型的写法（IF-14…18）', () => {
  it('IF-14 库表恰两项：chart.js → Chart、d3.js → d3；地址是 shuvix-lib://<名字>', () => {
    expect(Object.keys(SANDBOX_LIBS)).toEqual(['chart.js', 'd3.js'])
    expect(SANDBOX_LIBS['chart.js'].global).toBe('Chart')
    expect(SANDBOX_LIBS['d3.js'].global).toBe('d3')
    expect(SANDBOX_LIB_SCHEME).toBe('shuvix-lib')
    expect(sandboxLibUrl('chart.js')).toBe('shuvix-lib://chart.js')
  })

  it('IF-15 token 名单：不重复、形状对、含桥用到的每一个（白盒扫桥脚本）、每个在 themes.css 里都有定义', () => {
    expect(new Set(SANDBOX_THEME_TOKENS).size).toBe(SANDBOX_THEME_TOKENS.length)
    for (const name of SANDBOX_THEME_TOKENS) expect(name).toMatch(/^--[A-Za-z0-9-]+$/)
    for (let i = 1; i <= 8; i++) expect(SANDBOX_THEME_TOKENS).toContain(`--viz-${i}`)
    for (const name of ['--theme-text-secondary', '--viz-grid', '--theme-bg-primary']) {
      expect(SANDBOX_THEME_TOKENS).toContain(name)
    }

    // 桥里写死的每个 token 字面量都必须真被注入 —— 否则 shuvix.color() 在沙箱里取到空串
    const bridge = bridgeOf(plainDoc())
    const used = [...new Set([...bridge.matchAll(/'(--[A-Za-z0-9-]+)'/g)].map((m) => m[1]))]
    expect(used.length, '桥里应当引用了若干 token').toBeGreaterThan(5)
    for (const name of used) expect(SANDBOX_THEME_TOKENS, `桥用了 ${name}`).toContain(name)

    // 名单里的每个名字宿主都得真有：拷不到的 token 在沙箱里就是个未定义变量
    const css = readFileSync(join(REPO_ROOT, 'packages/app-shell/src/themes.css'), 'utf8')
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
    for (const name of SANDBOX_THEME_TOKENS) {
      expect(defined.has(name), `themes.css 没有定义 ${name}`).toBe(true)
    }
  })

  it('IF-16 技能参考是契约的唯一一份：教全库名、720px、用到的 token；片段只指路，不带契约', () => {
    const keys = Object.keys(SANDBOX_LIBS)
    for (const { name, text } of FRAGMENTS) {
      expect(text, name).toContain('```' + INTERACTIVE_FENCE_LANG)
      // 契约不常驻系统提示：片段里不提任何库地址、也不教桥（见 fragments/index.ts 的界桩说明）
      expect(libNamesIn(text), `${name} 不该教库`).toEqual([])
      expect(text, name).not.toContain('shuvix.sendPrompt')
      expect(interactiveSection(text, name), name).toContain('references/interactive.md')
    }
    for (const { name, text } of SKILL_REFS) {
      expect(text, name).toContain('```' + INTERACTIVE_FENCE_LANG)
      const libs = libNamesIn(text)
      for (const lib of libs) expect(keys, `${name} 提到了 ${lib}`).toContain(lib)
      for (const key of keys) expect(libs, `${name} 没教 ${key}`).toContain(key)
      const pixels = [...new Set([...text.matchAll(/(\d+)px/g)].map((m) => Number(m[1])))]
      expect(pixels, `${name} 提到的高度上限`).toContain(SANDBOX_MAX_HEIGHT)
      expect(text, name).toContain('shuvix.sendPrompt')
      expect(text, name).toContain('shuvix.color')
      // `--viz-N` 是散文里的占位写法，不是一个真 token
      const tokens = tokensIn(text).filter((t) => t !== '--viz-N')
      expect(tokens.length, `${name} 应当用到 token`).toBeGreaterThan(0)
      for (const token of tokens) {
        expect(SANDBOX_THEME_TOKENS, `${name} 用了 ${token}`).toContain(token)
      }
    }
  })

  it('IF-17 片段里每一处 ```interactive 都落在 interactive 界桩之内（段外提到就是没门控）', () => {
    for (const { name, text } of FRAGMENTS) {
      const start = text.indexOf(START)
      const end = text.indexOf(END)
      expect(start, name).toBeGreaterThanOrEqual(0)
      let seen = 0
      for (const needle of ['```' + INTERACTIVE_FENCE_LANG, `${SANDBOX_LIB_SCHEME}://`]) {
        for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
          expect(i > start && i < end, `${name} 第 ${i} 字符处的 ${needle} 在界桩外`).toBe(true)
          seen++
        }
      }
      expect(seen, `${name} 一处都没找到 —— 断言空转`).toBeGreaterThan(0)
    }
  })

  it('IF-18 片段里提到的每一种围栏（不只行首的开栅栏）都是渲染器认的：svg / artifact / interactive', () => {
    // svgFence.test.ts 那条只看行首开栅栏（```interactive 只在散文里出现），这里把散文也算上
    for (const { name, text } of FRAGMENTS) {
      const langs = new Set([...text.matchAll(/```([A-Za-z][\w+-]*)/g)].map((m) => m[1]))
      expect(langs.has('svg'), name).toBe(true)
      expect(langs.has(INTERACTIVE_FENCE_LANG), name).toBe(true)
      for (const lang of langs) {
        expect(['svg', 'artifact', INTERACTIVE_FENCE_LANG], `${name}: 未知围栏 ${lang}`).toContain(
          lang
        )
      }
    }
  })
})
