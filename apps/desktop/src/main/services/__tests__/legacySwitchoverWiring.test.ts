/**
 * 启动切换（P4-02，docs/pi-durable/p4-0102-test-design.md §C）—— 接线，读源码（语法树，注释里的字样不算）：
 *
 *   P4-02-24 main/index.ts：`app.whenReady().then(async () => …)` 回调体的顶层恰一句 `await runLegacySwitchover()`
 *            （不在 .then 里、不是 void），排在 registerIpcHandlers() / hookService.init() 之后，排在
 *            cliServer.start / registerChromeFrontend / chromeBridge.start / installChromeNativeHost /
 *            initSharedWindowServices / openMarkdownFile 循环 / createWindow 之前（PIN-12）；activate 里没有
 *   P4-02-25 启动不会因它中止：两种做法都算合规 —— 调用包在只记日志的 try 里，或函数本身从不 reject。
 *            实现选的是后者：runLegacySwitchover 体内每一处调用（汇总的 info 与 catch 里的日志除外）都在一个
 *            带 catch 的 try 里（行为上由 P4-02-07 / P4-02-09 钉着）
 *   P4-02-26 模块卫生：services/legacySwitchover.ts 不碰 user_version / pragma；不 import dao/migrations、
 *            dao/sessionDao（只经 sessionRecords）、frontend/sync/syncWiring、services/chromeBridge；不提
 *            harnessV3 / readLegacyTranscript（启动时从不解析 `.jsonl`）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/src/main/services/__tests__` 往上两层 */
const INDEX_TS = resolve(HERE, '../../index.ts')
const SWITCHOVER_TS = resolve(HERE, '../legacySwitchover.ts')

function parse(source: string, name = 'index.ts'): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function callsIn(node: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) found.push(n)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** `a.b.c` 这样纯标识符的属性链 → 'a.b.c'；别的形状回 undefined */
function chainOf(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) {
    const head = chainOf(expr.expression)
    return head === undefined ? undefined : `${head}.${expr.name.text}`
  }
  return undefined
}

const contains = (outer: ts.Node, inner: ts.Node): boolean =>
  outer.pos <= inner.pos && inner.end <= outer.end

/** `app.whenReady().then(<回调>)` 的回调体；找不到回 undefined */
function whenReadyBody(sf: ts.SourceFile): ts.Block | undefined {
  for (const call of callsIn(sf)) {
    if (!ts.isPropertyAccessExpression(call.expression)) continue
    if (call.expression.name.text !== 'then') continue
    const target = call.expression.expression
    if (!ts.isCallExpression(target) || chainOf(target.expression) !== 'app.whenReady') continue
    const [fn] = call.arguments
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) {
      return fn.body
    }
  }
  return undefined
}

/** `app.on('activate', <回调>)` 的回调 */
function activateHandlers(sf: ts.SourceFile): ts.Node[] {
  return callsIn(sf)
    .filter((call) => chainOf(call.expression) === 'app.on')
    .filter((call) => {
      const [event] = call.arguments
      return !!event && ts.isStringLiteral(event) && event.text === 'activate'
    })
    .map((call) => call.arguments[1])
    .filter((fn): fn is ts.Expression => fn !== undefined)
}

/** 必须排在切换之前 / 之后的调用（按调用的属性链认） */
const BEFORE = ['registerIpcHandlers', 'hookService.init']
const AFTER = [
  'cliServer.start',
  'registerChromeFrontend',
  'chromeBridge.start',
  'installChromeNativeHost',
  'initSharedWindowServices',
  'openMarkdownFile',
  'createWindow'
]

/** 接线合规时回 [] */
function wiringProblems(source: string): string[] {
  const sf = parse(source)
  const all = callsIn(sf).filter((call) => chainOf(call.expression) === 'runLegacySwitchover')
  if (all.length !== 1) return [`runLegacySwitchover(…) 应恰好一处，实际 ${all.length} 处`]
  const [call] = all
  const problems: string[] = []
  if (call.arguments.length !== 0) problems.push('runLegacySwitchover 不带参数')

  const body = whenReadyBody(sf)
  if (!body) return [...problems, '找不到 app.whenReady().then(…) 的回调体']
  const statements = body.statements
  const index = statements.findIndex(
    (s) =>
      ts.isExpressionStatement(s) &&
      ts.isAwaitExpression(s.expression) &&
      s.expression.expression === call
  )
  if (index < 0) {
    problems.push('应是 whenReady 回调体顶层的一句 `await runLegacySwitchover()`')
    return problems
  }

  /** 含有这个调用的顶层语句下标（全部） */
  const indexesOf = (chain: string): number[] => {
    const calls = callsIn(body).filter((c) => chainOf(c.expression) === chain)
    return statements
      .map((s, i) => (calls.some((c) => contains(s, c)) ? i : -1))
      .filter((i) => i >= 0)
  }
  for (const chain of BEFORE) {
    const at = indexesOf(chain)
    if (at.length === 0) problems.push(`whenReady 回调里找不到 ${chain}()`)
    else if (Math.max(...at) >= index) problems.push(`${chain}() 应排在切换之前`)
  }
  for (const chain of AFTER) {
    const at = indexesOf(chain)
    if (at.length === 0) problems.push(`whenReady 回调里找不到 ${chain}()`)
    else if (Math.min(...at) <= index) problems.push(`${chain}() 应排在切换之后`)
  }
  for (const handler of activateHandlers(sf)) {
    if (contains(handler, call)) problems.push('activate 里不该跑切换')
  }
  return problems
}

describe('P4-02-24 main/index.ts 的接线', () => {
  const ok = [
    'app.whenReady().then(async () => {',
    "  measure('registerIPC', () => registerIpcHandlers())",
    "  measure('hookService.init', () => hookService.init())",
    '  await runLegacySwitchover()',
    '  cliServer.start().catch(() => {})',
    '  registerChromeFrontend()',
    '  chromeBridge.start({}).catch(() => {})',
    '  void installChromeNativeHost()',
    '  initSharedWindowServices()',
    '  for (const file of files) openMarkdownFile(file)',
    "  if (n > 0) log.info('x')",
    "  else measure('createWindow', () => createWindow())",
    "  app.on('activate', () => { createWindow() })",
    '})'
  ]

  it('P4-02-24 扫描器自检：合规的写法回 []；各种违规都报出来', () => {
    expect(wiringProblems(ok.join('\n'))).toStrictEqual([])
    const variants: Array<[string, string[]]> = [
      ['注释不算', ok.map((l) => l.replace('await runLegacySwitchover()', '// runLegacySwitchover()'))],
      ['不 await', ok.map((l) => l.replace('await runLegacySwitchover()', 'runLegacySwitchover()'))],
      [
        'void',
        ok.map((l) => l.replace('await runLegacySwitchover()', 'void runLegacySwitchover()'))
      ],
      [
        '.then 里',
        ok.map((l) =>
          l.replace('await runLegacySwitchover()', 'await runLegacySwitchover().then(() => {})')
        )
      ],
      [
        '排在 IPC 之前',
        [ok[0], ok[3], ok[1], ok[2], ...ok.slice(4)]
      ],
      [
        '排在 CLI 之后',
        [...ok.slice(0, 3), ok[4], ok[3], ...ok.slice(5)]
      ],
      [
        '排在 createWindow 之后',
        [...ok.slice(0, 3), ...ok.slice(4, 12), ok[3], ...ok.slice(12)]
      ],
      [
        '两处（activate 里也有）',
        ok.map((l) =>
          l.replace(
            "app.on('activate', () => { createWindow() })",
            "app.on('activate', async () => { await runLegacySwitchover(); createWindow() })"
          )
        )
      ]
    ]
    for (const [label, lines] of variants) {
      expect(wiringProblems(lines.join('\n')), label).not.toStrictEqual([])
    }
  })

  it('P4-02-24 main/index.ts：恰一句顶层 `await runLegacySwitchover()`，位置合规', () => {
    expect(wiringProblems(readFileSync(INDEX_TS, 'utf8'))).toStrictEqual([])
  })
})

/** 某函数声明体内、不在带 catch 的 try 块里的调用（`except` 里的属性链除外，catch 块里的一律不算） */
function unguardedCalls(sf: ts.SourceFile, fnName: string, except: string[]): string[] {
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === fnName
  )
  if (!fn?.body) return [`找不到函数 ${fnName}`]
  const guarded: ts.Node[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isTryStatement(n) && n.catchClause) {
      guarded.push(n.tryBlock, n.catchClause)
    }
    ts.forEachChild(n, visit)
  }
  visit(fn.body)
  return callsIn(fn.body)
    .filter((call) => !guarded.some((g) => contains(g, call)))
    .map((call) => chainOf(call.expression) ?? call.getText(sf))
    .filter((chain) => !except.includes(chain))
}

describe('P4-02-25 启动不会因切换中止', () => {
  it('P4-02-25 runLegacySwitchover 体内的每一步都在带 catch 的 try 里（只剩汇总日志在外面）', () => {
    const sf = parse(readFileSync(SWITCHOVER_TS, 'utf8'), 'legacySwitchover.ts')
    expect(unguardedCalls(sf, 'runLegacySwitchover', ['log.info'])).toStrictEqual([])
  })

  it('P4-02-25 扫描器自检：一步落在 try 外就报出来', () => {
    const sf = parse(
      [
        'async function runLegacySwitchover() {',
        '  try { a() } catch (e) { log.error(e) }',
        '  await b()',
        '  log.info("x")',
        '}'
      ].join('\n'),
      'x.ts'
    )
    expect(unguardedCalls(sf, 'runLegacySwitchover', ['log.info'])).toStrictEqual(['b'])
  })
})

describe('P4-02-26 模块卫生', () => {
  const source = readFileSync(SWITCHOVER_TS, 'utf8')
  const sf = parse(source, 'legacySwitchover.ts')
  /** 去掉注释之后的代码 */
  const code = ts.createPrinter({ removeComments: true }).printFile(sf)
  const imports = sf.statements
    .filter(ts.isImportDeclaration)
    .map((d) => (d.moduleSpecifier as ts.StringLiteral).text)

  it('P4-02-26 不碰 user_version / pragma', () => {
    expect(code).not.toMatch(/user_version/i)
    expect(code).not.toMatch(/pragma/i)
  })

  it('P4-02-26 不 import 迁移、sessionDao、syncWiring、chromeBridge', () => {
    expect(imports.length).toBeGreaterThan(0)
    for (const spec of imports) {
      expect(spec).not.toMatch(/(^|\/)migrations$/)
      expect(spec).not.toMatch(/(^|\/)sessionDao$/)
      expect(spec).not.toMatch(/(^|\/)syncWiring$/)
      expect(spec).not.toMatch(/(^|\/)chromeBridge$/)
    }
    expect(imports).toContain('./sessionRecords')
  })

  it('P4-02-26 启动时从不解析 `.jsonl`：不提 harnessV3 / readLegacyTranscript', () => {
    expect(code).not.toMatch(/harnessV3/i)
    expect(code).not.toMatch(/readLegacyTranscript/)
  })
})
