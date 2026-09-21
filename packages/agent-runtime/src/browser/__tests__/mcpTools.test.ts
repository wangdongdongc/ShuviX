/**
 * 内置 browser MCP server 的工具目录（mcpTools）与 cdp_recipes 文本 —— 纯函数那一半。
 * 协议那一半（同一份目录过线之后的样子、分发、门、排队、中止）在 mcpServer.test.ts。
 *
 * 目录是模型看到的全部手册，也是策略按 annotations 判断「这一步要不要问」的依据，所以这里钉：
 *   T1–T3  工具清单与参数随端能力（caps）增减：顺序稳定，一个 cap 只拿掉它自己的工具 / 参数；
 *   T4–T6  四个 hint 逐工具显式写全（规范的缺省是保守的，漏一个 snapshot 就成了「有破坏性」），
 *          只读集合与其余几档的取值；
 *   T7     每个工具的入参 schema：必填表（它的顺序就是「缺参数」报错里的顺序）、枚举、
 *          数组 / 对象参数的形状；
 *   T8–T9  宿主说明只接在 list_tabs 后面；截图的交付方式随 screenshotToFile 换措辞；
 *   T11    **描述里不提这台 server 上没有的东西**，caps 的全部 2^9 种组合扫一遍 ——
 *          教模型去用一个它手里没有的工具，是在教一条死路；
 *   T12    press_key 列出的具名键没有空项（KEY_DEFS 里有一个键名就是空格）；
 *   X4     cdp_recipes 说「会被拒」的方法确实被 blockedCdpReason 拒，配方里让模型调的方法确实放行。
 */
import { describe, expect, it } from 'vitest'
import type { BrowserCaps } from '../backend'
import { browserToolSpec, browserToolsForCaps, type BrowserMcpTool } from '../mcpTools'
import { devtoolsRecipes } from '../devtoolsRecipes'
import { blockedCdpReason } from '../cdpPolicy'
import { KEY_DEFS } from '../keyboard'

// ─── caps 预设 ───────────────────────────────────────────────────────────

/** 桌面：全开 */
const DESKTOP: BrowserCaps = {
  pdf: true,
  fullPageScreenshot: true,
  elementScreenshot: true,
  screenshotToFile: true,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true,
  upload: true
}

/** 扩展：没有落盘语义（pdf / 截图落盘）、没有本机路径可交给文件 input */
const EXTENSION: BrowserCaps = {
  pdf: false,
  fullPageScreenshot: false,
  elementScreenshot: false,
  screenshotToFile: false,
  evaluate: true,
  network: true,
  console: true,
  rawCdp: true,
  upload: false
}

/** 每个可选能力都关掉 */
const MINIMAL: BrowserCaps = {
  pdf: false,
  fullPageScreenshot: false,
  elementScreenshot: false,
  screenshotToFile: false,
  evaluate: false,
  network: false,
  console: false,
  rawCdp: false,
  upload: false
}

/** BrowserCaps 的全部键 —— 取自类型上必须写全的 DESKTOP，新增一个 cap 会自动进扫描 */
const CAP_KEYS = Object.keys(DESKTOP) as Array<keyof BrowserCaps>

/** caps 的全部 2^n 种组合 */
const ALL_COMBOS: BrowserCaps[] = Array.from(
  { length: 1 << CAP_KEYS.length },
  (_, mask) =>
    Object.fromEntries(
      CAP_KEYS.map((k, i) => [k, (mask & (1 << i)) !== 0])
    ) as unknown as BrowserCaps
)

/** 组合的简短标签（失败信息用） */
const label = (caps: BrowserCaps): string => CAP_KEYS.filter((k) => caps[k]).join('+') || '(none)'

/** 目录顺序（全开时） */
const ALL_NAMES = [
  'list_tabs',
  'open_tab',
  'close_tab',
  'navigate',
  'snapshot',
  'read_page',
  'screenshot',
  'click',
  'fill',
  'type',
  'press_key',
  'hover',
  'upload_file',
  'scroll',
  'wait_for',
  'evaluate',
  'network',
  'console',
  'pdf',
  'cdp',
  'events',
  'cdp_recipes'
]

/** 整个工具依赖某个 cap 的那几个 */
const GATED_TOOLS: Record<string, keyof BrowserCaps> = {
  upload_file: 'upload',
  evaluate: 'evaluate',
  network: 'network',
  console: 'console',
  pdf: 'pdf',
  cdp: 'rawCdp',
  events: 'rawCdp',
  cdp_recipes: 'rawCdp'
}

const names = (caps: BrowserCaps): string[] => browserToolsForCaps(caps).map((t) => t.name)

const tool = (caps: BrowserCaps, name: string, hostNote?: string): BrowserMcpTool => {
  const found = browserToolsForCaps(caps, hostNote).find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} is not listed under ${label(caps)}`)
  return found
}

/** 文本里是否把 word 当成一个完整的词提到（`cdp` 不算 `cdp_recipes` 的一部分，大小写敏感） */
const mentions = (text: string, word: string): boolean => new RegExp(`\\b${word}\\b`).test(text)

// ─── T1–T3 清单与参数 ─────────────────────────────────────────────────────

describe('T1–T3 工具清单随 caps 增减', () => {
  it('T1 全开时是 22 个工具、目录顺序；再取一次逐项相同（规范要求列表稳定）', () => {
    expect(names(DESKTOP)).toEqual(ALL_NAMES)
    expect(browserToolsForCaps(DESKTOP)).toEqual(browserToolsForCaps(DESKTOP))
    expect(browserToolsForCaps(EXTENSION)).toEqual(browserToolsForCaps(EXTENSION))
  })

  it.each(CAP_KEYS)('T2 只关掉 %s → 只少它自己的那几个工具，其余顺序不变', (cap) => {
    const removed = Object.keys(GATED_TOOLS).filter((t) => GATED_TOOLS[t] === cap)
    expect(names({ ...DESKTOP, [cap]: false })).toEqual(
      ALL_NAMES.filter((n) => !removed.includes(n))
    )
  })

  it('T2 全关 → 恰是 14 个常驻工具；扩展 → 20 个（没有 upload_file / pdf）', () => {
    expect(names(MINIMAL)).toEqual([
      'list_tabs',
      'open_tab',
      'close_tab',
      'navigate',
      'snapshot',
      'read_page',
      'screenshot',
      'click',
      'fill',
      'type',
      'press_key',
      'hover',
      'scroll',
      'wait_for'
    ])
    expect(names(EXTENSION)).toEqual(ALL_NAMES.filter((n) => n !== 'upload_file' && n !== 'pdf'))
    expect(names(EXTENSION)).toHaveLength(20)
  })

  it('T2 browserToolSpec 与清单是同一份目录：列出的才查得到，必填表一致；未知名字查不到', () => {
    for (const caps of ALL_COMBOS) {
      const listed = browserToolsForCaps(caps)
      for (const name of ALL_NAMES) {
        const spec = browserToolSpec(name, caps)
        const entry = listed.find((t) => t.name === name)
        expect(!!spec, `${name} @ ${label(caps)}`).toBe(!!entry)
        if (spec && entry) expect(spec.required).toEqual(entry.inputSchema.required)
      }
    }
    // 目录按 Map 查：原型链上的名字不会被当成工具
    for (const name of ['help', 'browser', '', 'toString', 'constructor', '__proto__']) {
      expect(browserToolSpec(name, DESKTOP), name).toBeUndefined()
    }
    // 只有 fill 的 text 允许空串（"" 清空字段）
    expect(browserToolSpec('fill', DESKTOP)?.allowEmpty).toEqual(['text'])
    for (const name of ALL_NAMES.filter((n) => n !== 'fill')) {
      expect(browserToolSpec(name, DESKTOP)?.allowEmpty, name).toEqual([])
    }
  })

  it.each<[string, Partial<BrowserCaps>, string[]]>([
    ['两者都有', {}, ['tabId', 'fullPage', 'uid']],
    ['没有全页截图', { fullPageScreenshot: false }, ['tabId', 'uid']],
    ['没有元素截图', { elementScreenshot: false }, ['tabId', 'fullPage']],
    ['两者都没有', { fullPageScreenshot: false, elementScreenshot: false }, ['tabId']]
  ])(
    'T3 screenshot 的 fullPage / uid 参数只随各自的 cap 出现（%s），必填始终只有 tabId',
    (_l, patch, props) => {
      const schema = tool({ ...DESKTOP, ...patch }, 'screenshot').inputSchema
      expect(Object.keys(schema.properties)).toEqual(props)
      expect(schema.required).toEqual(['tabId'])
    }
  )
})

// ─── T4–T6 annotations ───────────────────────────────────────────────────

/** [readOnly, destructive, idempotent, openWorld] */
const HINTS: Record<string, [boolean, boolean, boolean, boolean]> = {
  list_tabs: [true, false, true, false],
  open_tab: [false, false, false, true],
  close_tab: [false, true, true, false],
  navigate: [false, false, false, true],
  snapshot: [true, false, true, false],
  read_page: [true, false, true, false],
  screenshot: [true, false, true, false],
  click: [false, true, false, true],
  fill: [false, true, false, true],
  type: [false, true, false, true],
  press_key: [false, true, false, true],
  hover: [true, false, true, false],
  upload_file: [false, true, false, true],
  scroll: [true, false, true, false],
  wait_for: [true, false, true, false],
  evaluate: [false, true, false, true],
  network: [true, false, true, false],
  console: [true, false, true, false],
  pdf: [false, true, true, false],
  cdp: [false, true, false, true],
  events: [true, false, true, false],
  cdp_recipes: [true, false, true, false]
}

const READ_ONLY = [
  'list_tabs',
  'snapshot',
  'read_page',
  'screenshot',
  'hover',
  'scroll',
  'wait_for',
  'network',
  'console',
  'events',
  'cdp_recipes'
]

describe('T4–T6 annotations', () => {
  it('T4 每个工具恰好五个键、四个 hint 都是布尔值，title 非空且等于工具的 title', () => {
    for (const t of browserToolsForCaps(DESKTOP)) {
      expect(Object.keys(t.annotations).sort(), t.name).toEqual([
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
        'readOnlyHint',
        'title'
      ])
      for (const hint of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint'
      ] as const) {
        expect(typeof t.annotations[hint], `${t.name}.${hint}`).toBe('boolean')
      }
      expect(t.title.trim(), t.name).not.toBe('')
      expect(t.annotations.title, t.name).toBe(t.title)
    }
  })

  it('T5 只读的恰是这 11 个，它们都不破坏、不触达外部', () => {
    const tools = browserToolsForCaps(DESKTOP)
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(READ_ONLY)
    for (const t of tools.filter((x) => x.annotations.readOnlyHint)) {
      expect(t.annotations.destructiveHint, t.name).toBe(false)
      expect(t.annotations.openWorldHint, t.name).toBe(false)
    }
  })

  it('T6 逐工具钉住四个 hint（只读的一律幂等；pdf / close_tab 破坏但幂等、不触达外部）', () => {
    const tools = browserToolsForCaps(DESKTOP)
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(HINTS).sort())
    for (const t of tools) {
      const a = t.annotations
      expect(
        [a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint],
        t.name
      ).toEqual(HINTS[t.name])
    }
  })

  it('T6 annotations 不随 caps 变（同一个工具在扩展上与桌面上一样）', () => {
    for (const t of browserToolsForCaps(EXTENSION)) {
      expect(t.annotations, t.name).toEqual(tool(DESKTOP, t.name).annotations)
    }
  })
})

// ─── T7 入参 schema ──────────────────────────────────────────────────────

/** 工具 → [全部参数（不计顺序）, 必填（按顺序）] */
const SHAPES: Record<string, [string[], string[]]> = {
  list_tabs: [[], []],
  open_tab: [['url'], ['url']],
  close_tab: [['tabId'], ['tabId']],
  navigate: [['tabId', 'url', 'nav'], ['tabId']],
  snapshot: [['tabId', 'full'], ['tabId']],
  read_page: [['tabId'], ['tabId']],
  screenshot: [['tabId', 'fullPage', 'uid'], ['tabId']],
  click: [
    ['tabId', 'uid'],
    ['tabId', 'uid']
  ],
  fill: [
    ['tabId', 'uid', 'text'],
    ['tabId', 'uid', 'text']
  ],
  type: [
    ['tabId', 'text', 'uid', 'submitKey'],
    ['tabId', 'text']
  ],
  press_key: [
    ['tabId', 'key'],
    ['tabId', 'key']
  ],
  hover: [
    ['tabId', 'uid'],
    ['tabId', 'uid']
  ],
  upload_file: [
    ['tabId', 'uid', 'paths'],
    ['tabId', 'uid', 'paths']
  ],
  scroll: [['tabId', 'direction', 'amount', 'uid'], ['tabId']],
  wait_for: [
    ['tabId', 'text', 'timeout'],
    ['tabId', 'text']
  ],
  evaluate: [
    ['tabId', 'expression'],
    ['tabId', 'expression']
  ],
  network: [['tabId', 'limit'], ['tabId']],
  console: [['tabId', 'limit'], ['tabId']],
  pdf: [
    ['tabId', 'outputPath', 'pageSize', 'landscape', 'scale'],
    ['tabId', 'outputPath']
  ],
  cdp: [
    ['tabId', 'method', 'params'],
    ['tabId', 'method']
  ],
  events: [['tabId', 'event', 'sinceSeq', 'limit'], ['tabId']],
  cdp_recipes: [[], []]
}

/** 标量参数的 JSON 类型 */
const SCALAR_TYPES: Record<string, string> = {
  tabId: 'string',
  url: 'string',
  uid: 'string',
  text: 'string',
  submitKey: 'string',
  key: 'string',
  expression: 'string',
  outputPath: 'string',
  pageSize: 'string',
  method: 'string',
  event: 'string',
  full: 'boolean',
  fullPage: 'boolean',
  landscape: 'boolean',
  amount: 'number',
  timeout: 'number',
  limit: 'number',
  scale: 'number',
  sinceSeq: 'number'
}

describe('T7 入参 schema', () => {
  it('T7 每个工具：对象型、不收未声明的键、参数与必填表逐项对上', () => {
    const tools = browserToolsForCaps(DESKTOP)
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(SHAPES).sort())
    for (const t of tools) {
      const [props, required] = SHAPES[t.name]
      expect(t.inputSchema.type, t.name).toBe('object')
      expect(t.inputSchema.additionalProperties, t.name).toBe(false)
      expect(Object.keys(t.inputSchema.properties).sort(), t.name).toEqual([...props].sort())
      // 顺序就是「缺参数」报错里列出的顺序
      expect(t.inputSchema.required, t.name).toEqual(required)
    }
  })

  it('T7 每个参数都有非空说明；标量参数的类型', () => {
    for (const t of browserToolsForCaps(DESKTOP)) {
      for (const [key, schema] of Object.entries(t.inputSchema.properties)) {
        const where = `${t.name}.${key}`
        expect(typeof schema.description, where).toBe('string')
        expect(String(schema.description).trim(), where).not.toBe('')
        if (key in SCALAR_TYPES) expect(schema.type, where).toBe(SCALAR_TYPES[key])
      }
    }
  })

  it('T7 枚举、文件列表与 cdp params 的形状', () => {
    const props = (name: string): Record<string, Record<string, unknown>> =>
      tool(DESKTOP, name).inputSchema.properties
    expect(props('navigate').nav).toEqual({
      type: 'string',
      enum: ['goto', 'back', 'forward', 'reload'],
      description: expect.any(String)
    })
    expect(props('scroll').direction).toEqual({
      type: 'string',
      enum: ['up', 'down', 'left', 'right'],
      description: expect.any(String)
    })
    expect(props('upload_file').paths).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: expect.any(String)
    })
    expect(props('cdp').params).toEqual({
      type: 'object',
      additionalProperties: true,
      description: expect.any(String)
    })
  })

  it('T7 任何 caps 组合下，必填的参数都在 properties 里（被 cap 拿掉的参数都不是必填）', () => {
    for (const caps of ALL_COMBOS) {
      for (const t of browserToolsForCaps(caps)) {
        for (const r of t.inputSchema.required) {
          expect(t.inputSchema.properties, `${t.name}.${r} @ ${label(caps)}`).toHaveProperty(r)
        }
      }
    }
  })
})

// ─── T8–T9 宿主说明与截图措辞 ─────────────────────────────────────────────

describe('T8–T9 描述里的宿主差异', () => {
  it('T8 hostNote 只以「空一行 + 原文」接在 list_tabs 后面，别的工具一个字不变', () => {
    const base = browserToolsForCaps(DESKTOP)
    const noted = browserToolsForCaps(DESKTOP, 'This is the built-in panel; tabs persist.')
    for (const [i, t] of noted.entries()) {
      expect(t.description, t.name).toBe(
        t.name === 'list_tabs'
          ? `${base[i].description}\n\nThis is the built-in panel; tabs persist.`
          : base[i].description
      )
    }
  })

  it.each<[string, string | undefined]>([
    ['undefined', undefined],
    ['空串', '']
  ])('T8 hostNote 为 %s → 描述与不给时完全相同', (_l, note) => {
    expect(browserToolsForCaps(DESKTOP, note)).toEqual(browserToolsForCaps(DESKTOP))
    expect(tool(DESKTOP, 'list_tabs', note).description).not.toContain('\n\n')
  })

  it('T9 截图落盘时说「存成 PNG、读那个路径」，内联时说「图片随结果返回」—— 两句互斥', () => {
    const toFile = tool(DESKTOP, 'screenshot').description
    const inline = tool({ ...DESKTOP, screenshotToFile: false }, 'screenshot').description
    expect(toFile).toContain(
      'The image is saved as a PNG file and its path returned — read that path when you actually need to look at it.'
    )
    expect(toFile).not.toContain('returned inline')
    expect(inline).toContain('The image is returned inline.')
    expect(inline).not.toContain('PNG file')
  })
})

// ─── T11 不提没有的东西 ────────────────────────────────────────────────────

describe('T11 描述与配方只提这台 server 上真有的工具', () => {
  it('T11 全部 caps 组合：列出的每个工具的描述都不提一个没列出的工具', () => {
    for (const caps of ALL_COMBOS) {
      const listed = names(caps)
      const absent = Object.keys(GATED_TOOLS).filter((t) => !listed.includes(t))
      for (const t of browserToolsForCaps(caps)) {
        for (const missing of absent) {
          expect(mentions(t.description, missing), `${t.name} → ${missing} @ ${label(caps)}`).toBe(
            false
          )
        }
      }
    }
  })

  it('T11 全部带 rawCdp 的组合：cdp_recipes 的文本也不提一个没列出的工具', () => {
    for (const caps of ALL_COMBOS.filter((c) => c.rawCdp)) {
      const listed = names(caps)
      const text = devtoolsRecipes(caps)
      for (const missing of Object.keys(GATED_TOOLS).filter((t) => !listed.includes(t))) {
        expect(mentions(text, missing), `recipes → ${missing} @ ${label(caps)}`).toBe(false)
      }
    }
  })

  it('T11 这台 server 没有 help 工具（旧 multiplex 工具的 help 动作），描述与配方都不指向它', () => {
    for (const t of browserToolsForCaps(DESKTOP))
      expect(mentions(t.description, 'help'), t.name).toBe(false)
    expect(mentions(devtoolsRecipes(DESKTOP), 'help')).toBe(false)
  })

  it.each<[string, string, keyof BrowserCaps, string]>([
    ['snapshot', 'upload_file', 'upload', 'click / fill / type / hover / upload_file'],
    ['read_page', 'evaluate', 'evaluate', 'use evaluate instead'],
    ['screenshot', 'evaluate', 'evaluate', 'use evaluate'],
    ['network', 'cdp', 'rawCdp', '(for cdp Network.getResponseBody)']
  ])('T11 %s 只在有 %s 时提它（cap: %s）', (name, other, cap, phrase) => {
    expect(tool(DESKTOP, name).description).toContain(phrase)
    // 正对照：mentions 真能认出这个词，下面那条「不提」才不是空转
    expect(mentions(tool(DESKTOP, name).description, other)).toBe(true)
    const without = tool({ ...DESKTOP, [cap]: false }, name).description
    expect(mentions(without, other)).toBe(false)
    expect(without).not.toContain(phrase)
  })

  it('T11 snapshot 在扩展上列的是 click / fill / type / hover', () => {
    expect(tool(EXTENSION, 'snapshot').description).toContain(
      'Required before click / fill / type / hover — uids come from'
    )
  })

  it('T11 screenshot：有全页截图时提 fullPage；两种截图都没有时一个字不提', () => {
    expect(tool(DESKTOP, 'screenshot').description).toContain(
      'fullPage:true captures beyond the viewport.'
    )
    expect(tool(DESKTOP, 'screenshot').description).toContain('more with fullPage')
    expect(tool(EXTENSION, 'screenshot').description).not.toContain('fullPage')
    expect(tool(MINIMAL, 'screenshot').description).not.toContain('fullPage')
  })

  // 有元素截图、没有全页截图的端：schema 里没有 fullPage，描述也不能提它
  it('T11 screenshot：只有元素截图、没有全页截图时也不提 fullPage', () => {
    const d = tool({ ...DESKTOP, fullPageScreenshot: false }, 'screenshot').description
    expect(d).toContain('uid captures a single element')
    expect(d).not.toContain('fullPage')
  })

  it.each<[string, keyof BrowserCaps, string]>([
    ['upload_file', 'upload', 'upload_file'],
    ['network(tabId)', 'network', 'network(tabId)']
  ])('T11 cdp_recipes 只在有对应能力时提 %s', (_l, cap, phrase) => {
    expect(devtoolsRecipes(DESKTOP)).toContain(phrase)
    expect(devtoolsRecipes({ ...DESKTOP, [cap]: false })).not.toContain(phrase)
  })

  it('T11 没有 network 工具时，配方改用 events 拿 requestId', () => {
    const text = devtoolsRecipes({ ...DESKTOP, network: false })
    expect(text).toContain('events(event:"Network.requestWillBeSent") for the requestIds')
  })
})

// ─── T12 press_key 的具名键 ───────────────────────────────────────────────

describe('T12 press_key 列出的具名键', () => {
  it('T12 逐项非空、就是 KEY_DEFS 里除空格键名之外的全部', () => {
    const desc = tool(DESKTOP, 'press_key').description
    const listed = /Named keys: (.*?)\. Combinations/.exec(desc)?.[1]
    expect(listed).toBeDefined()
    const keys = listed!.split(', ')
    for (const k of keys) {
      expect(k).not.toBe('')
      expect(k.trim()).toBe(k)
    }
    expect(keys).toEqual(Object.keys(KEY_DEFS).filter((k) => k.trim() !== ''))
    expect(keys).toContain('Space')
    expect(desc).not.toMatch(/, ,|, \./)
  })
})

// ─── X4 配方与拦截表对账 ──────────────────────────────────────────────────

/** 配方里「Domain.member」形式的记号（Domain 是占位写法，不是真域） */
function cdpTokens(text: string): string[] {
  return [...text.matchAll(/\b([A-Z][A-Za-z]*)\.([a-z][A-Za-z]*)\b/g)]
    .filter((m) => m[1] !== 'Domain')
    .map((m) => `${m[1]}.${m[2]}`)
}

/** 配方「Safety」一条里点名会被拒的域与方法 */
function refusedList(text: string): string[] {
  const m = /outside the tab \(([^)]*)\) are refused/.exec(text)
  if (!m) throw new Error('the recipes no longer list what is refused')
  return m[1].split(', ')
}

describe('X4 cdp_recipes 与 blockedCdpReason 对账', () => {
  it.each<[string, BrowserCaps]>([
    ['桌面', DESKTOP],
    ['扩展', EXTENSION],
    ['没有 network / upload', { ...DESKTOP, network: false, upload: false }]
  ])('X4 %s：说会被拒的都被拒，其余提到的方法（含 cdp(...) 里让模型调的）都放行', (_l, caps) => {
    const text = devtoolsRecipes(caps)
    const refused = refusedList(text)
    expect(refused.length).toBeGreaterThan(0)
    for (const entry of refused) {
      // 只写了域名的一整个域都拒
      const method = entry.includes('.') ? entry : `${entry}.enable`
      expect(blockedCdpReason(method), entry).toBeTruthy()
    }

    const called = [...text.matchAll(/cdp\(([A-Z][A-Za-z]*\.[a-z][A-Za-z]*)/g)]
      .map((m) => m[1])
      .filter((m) => !m.startsWith('Domain.'))
    expect(called.length).toBeGreaterThan(5)
    for (const m of called) expect(blockedCdpReason(m), m).toBeNull()

    for (const token of cdpTokens(text).filter((t) => !refused.includes(t))) {
      expect(blockedCdpReason(token), token).toBeNull()
    }
  })

  it('X4 cdp 工具描述里举的「会被拒」的域确实被拒', () => {
    const desc = tool(DESKTOP, 'cdp').description
    const m = /Methods outside the tab \(([^)]*)\) are refused/.exec(desc)
    expect(m).not.toBeNull()
    const domains = m![1].split(', ').filter((d) => d !== '…')
    expect(domains).toEqual(['Browser', 'Target', 'Tracing'])
    for (const d of domains) expect(blockedCdpReason(`${d}.getVersion`), d).toBeTruthy()
  })
})
