/**
 * 通道守卫（server mode phase A §5）—— 主进程的定义与渲染端通道表（`shared/apiTable.ts`）两头对得上。扫的是
 * `src/main/**\/*.ts` 的**源码**（跳过 `__tests__` 与 `*.test.ts`），用 TypeScript 的语法树而不是正则：注释里就写着
 * `defineHandler(` / `ipcMain.handle` 这些字样。每个扫描器先对着几段手写的小源码自检。
 *
 *   CG-0 扫描器自检：注释里的 `defineHandler(` 不算；跨行的调用算；通道参数是模板串 / 标识符的会被报出来
 *   CG-1 `ipc/registry.ts` 之外每一处 `defineHandler(` / `defineListener(` 的第一个参数都是字符串字面量（否则报 文件:行）
 *   CG-2 没有哪条通道被定义两次（跨文件也算）
 *   CG-3 表 → 主进程：表里每条 invoke 与每条非 null 的 override invoke 恰有一个 `defineHandler`；表 / override 的每条 send
 *        恰有一个 `defineListener`；不合的按 `ns.member` 分成「缺定义」与「种类不对」
 *   CG-4 主进程 → 表：每条定义的通道都是表 ∪ override 里同种类的请求通道（定义了推送通道、或已删掉的
 *        `dialog:readTextFile`，都算到不了）。放行表 `MAIN_ONLY`（通道 → 理由）今天是空的；放行的通道必须真有定义
 *   CG-5 除 `index.ts` 外，有定义的文件都是 `ipc/*.ts` 且导出一个 `register*Handlers`；`ipc/*.ts` 导出的每个
 *        `register*Handlers`（`registerIpcHandlers` 除外）都在 `ipc/handlers.ts` 里被引入、并在 `registerIpcHandlers` 里被调用；
 *        `index.ts` 里的定义都是顶层语句
 *   CG-6 `src/main` 里除 `ipc/ipcAdapter.ts` 外没有标识符 `ipcMain`（注释不算），也没有从 'electron' 引 `ipcMain`；
 *        非测试代码里恰有一处 `attachIpcAdapter()`，是 `index.ts` 的顶层语句，排在第一条顶层 defineHandler /
 *        defineListener 之前、`registerIpcHandlers()` 之前
 *   CG-7 每条推送通道都有人推：表里每条 event 与 override 的 event（`app:event`、`sync:frame`）至少有一处 `send` /
 *        `sendToRenderer` / `pushTo`（第二个参数）/ `broadcastToClients` 的通道参数是那个字面量、或绑定到那个字面量的
 *        顶层 const（`SYNC_FRAME_CHANNEL`）。反过来：交给 `pushTo` / `broadcastToClients` / `sendToRenderer` 的字面量通道
 *        （registry.ts / ipcAdapter.ts 之外）都是表 / override 的推送通道（泛泛的 `.send(` 不查这一向）
 *   CG-8 推送的载荷个数对得上：表里推送通道的每一处推送，通道之后的参数个数 = 该条目的 `args`
 *        （`app:new-chat` / `app:new-project` 是 0，`sync:frame` 是 2，其余 1）
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { API_OVERRIDE_CHANNELS, API_TABLE, type ApiMemberKind } from '../../../shared/apiTable'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/src/main/ipc/__tests__` 往上两层 */
const MAIN_DIR = resolve(HERE, '../..')

// ─── 语法树小工具 ───

function parse(source: string, fileName = 'snippet.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function calls(node: ts.Node): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) found.push(n)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** 调用表达式调的名字（`foo(…)` / `x.foo(…)` / `x?.foo(…)` → 'foo'） */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return undefined
}

function isTopLevelStatement(sf: ts.SourceFile, call: ts.CallExpression): boolean {
  return ts.isExpressionStatement(call.parent) && call.parent.parent === sf
}

// ─── 定义的扫描 ───

type DefKind = 'handle' | 'listen'

interface Definition {
  readonly file: string
  readonly line: number
  readonly kind: DefKind
  /** 第一个参数是字符串字面量时的通道；否则 undefined */
  readonly channel: string | undefined
  /** 第一个参数的原文 */
  readonly argText: string
  readonly topLevel: boolean
}

const DEFINE_KIND: Record<string, DefKind> = { defineHandler: 'handle', defineListener: 'listen' }

/** 自有属性判断（`in` 会顺着原型链认出 `toString(` 之类的调用） */
function isDefineCall(call: ts.CallExpression): boolean {
  return Object.hasOwn(DEFINE_KIND, calleeName(call) ?? '')
}

function definitionsIn(source: string, file = 'snippet.ts'): Definition[] {
  const sf = parse(source, file)
  return calls(sf)
    .filter((c) => isDefineCall(c))
    .map((c) => {
      const [arg] = c.arguments
      return {
        file,
        line: lineOf(sf, c),
        kind: DEFINE_KIND[calleeName(c)!],
        channel: arg && ts.isStringLiteral(arg) ? arg.text : undefined,
        argText: arg ? arg.getText(sf) : '',
        topLevel: isTopLevelStatement(sf, c)
      }
    })
}

/** 通道不是字符串字面量的定义：`文件:行 (参数原文)` */
function nonLiteralDefinitions(defs: readonly Definition[]): string[] {
  return defs
    .filter((d) => d.channel === undefined)
    .map((d) => `${d.file}:${d.line} (${d.argText})`)
}

/** 定义了不止一次的通道：`通道 @ 文件:行, 文件:行` */
function duplicateDefinitions(defs: readonly Definition[]): string[] {
  const byChannel = new Map<string, Definition[]>()
  for (const d of defs) {
    if (d.channel === undefined) continue
    byChannel.set(d.channel, [...(byChannel.get(d.channel) ?? []), d])
  }
  return [...byChannel]
    .filter(([, list]) => list.length > 1)
    .map(([channel, list]) => `${channel} @ ${list.map((d) => `${d.file}:${d.line}`).join(', ')}`)
}

// ─── 通道表一侧 ───

interface TableEntry {
  /** `ns.member` */
  readonly name: string
  readonly kind: ApiMemberKind
  readonly channel: string
}

const TABLE_ENTRIES: TableEntry[] = Object.entries(API_TABLE).flatMap(([ns, members]) =>
  Object.entries(members).map(([member, m]) => ({
    name: `${ns}.${member}`,
    kind: m.kind,
    channel: m.channel
  }))
)

const OVERRIDE_ENTRIES: TableEntry[] = Object.entries(API_OVERRIDE_CHANNELS).flatMap(
  ([ns, members]) =>
    Object.entries(members as Record<string, { kind: ApiMemberKind; channel: string } | null>)
      .filter(([, ch]) => ch !== null)
      .map(([member, ch]) => ({ name: `${ns}.${member}`, kind: ch!.kind, channel: ch!.channel }))
)

const ALL_ENTRIES: TableEntry[] = [...TABLE_ENTRIES, ...OVERRIDE_ENTRIES]

const DEF_KIND_OF: Partial<Record<ApiMemberKind, DefKind>> = { invoke: 'handle', send: 'listen' }

interface Coverage {
  missing: string[]
  wrongKind: string[]
  multiple: string[]
}

/** 表 → 主进程：每条请求条目恰有一个同种类的定义 */
function tableCoverage(entries: readonly TableEntry[], defs: readonly Definition[]): Coverage {
  const result: Coverage = { missing: [], wrongKind: [], multiple: [] }
  for (const entry of entries) {
    const want = DEF_KIND_OF[entry.kind]
    if (want === undefined) continue
    const onChannel = defs.filter((d) => d.channel === entry.channel)
    const sameKind = onChannel.filter((d) => d.kind === want)
    if (sameKind.length === 1 && onChannel.length === 1) continue
    if (onChannel.length === 0) result.missing.push(entry.name)
    else if (sameKind.length === 0) result.wrongKind.push(entry.name)
    else result.multiple.push(entry.name)
  }
  return result
}

/** 主进程 → 表：到不了的定义（不是同种类的请求通道，也不在放行表里）：`通道 (种类) @ 文件:行` */
function unreachableDefinitions(
  defs: readonly Definition[],
  entries: readonly TableEntry[],
  mainOnly: Readonly<Record<string, string>>
): string[] {
  return defs
    .filter((d) => d.channel !== undefined && !(d.channel in mainOnly))
    .filter((d) => !entries.some((e) => e.channel === d.channel && DEF_KIND_OF[e.kind] === d.kind))
    .map((d) => `${d.channel} (${d.kind}) @ ${d.file}:${d.line}`)
}

/** 只有主进程用、渲染端表里没有的请求通道：通道 → 理由。今天应当没有 */
const MAIN_ONLY: Readonly<Record<string, string>> = {}

// ─── register*Handlers 的接线 ───

const REGISTER_RE = /^register\w*Handlers$/

function exportedRegisterFns(source: string): string[] {
  const sf = parse(source)
  const found: string[] = []
  for (const stmt of sf.statements) {
    const exported = ts.canHaveModifiers(stmt)
      ? (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false
    if (!exported) continue
    if (ts.isFunctionDeclaration(stmt) && stmt.name && REGISTER_RE.test(stmt.name.text)) {
      found.push(stmt.name.text)
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && REGISTER_RE.test(decl.name.text))
          found.push(decl.name.text)
      }
    }
  }
  return found
}

/** handlers.ts：引入表（本地名 → 模块）与 registerIpcHandlers 函数体里调到的名字 */
function aggregatorWiring(source: string): { imports: Map<string, string>; called: Set<string> } {
  const sf = parse(source)
  const imports = new Map<string, string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const bindings = stmt.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.propertyName === undefined || el.propertyName.text === el.name.text) {
          imports.set(el.name.text, stmt.moduleSpecifier.text)
        }
      }
    }
  }
  const called = new Set<string>()
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'registerIpcHandlers' && stmt.body) {
      for (const c of calls(stmt.body))
        if (ts.isIdentifier(c.expression)) called.add(c.expression.text)
    }
  }
  return { imports, called }
}

// ─── ipcMain 与适配器的挂载 ───

/** 标识符 ipcMain 出现的行（注释、字符串里的不算） */
function ipcMainIdentifiers(source: string): number[] {
  const sf = parse(source)
  const lines: number[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === 'ipcMain') lines.push(lineOf(sf, n))
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return lines
}

/** 从 'electron' 引 ipcMain 的行（含 `ipcMain as x`） */
function ipcMainImports(source: string): number[] {
  const sf = parse(source)
  const lines: number[] = []
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== 'electron') continue
    const bindings = stmt.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if ((el.propertyName ?? el.name).text === 'ipcMain') lines.push(lineOf(sf, el))
      }
    }
  }
  return lines
}

function attachCalls(source: string): ts.CallExpression[] {
  return calls(parse(source)).filter((c) => calleeName(c) === 'attachIpcAdapter')
}

/**
 * index.ts 里 `attachIpcAdapter()` 的问题清单；空 = 合格：恰一处、不带参数、顶层语句、在第一条顶层
 * defineHandler / defineListener 之前、在每一处 registerIpcHandlers() 之前
 */
function attachPlacementProblems(source: string): string[] {
  const sf = parse(source)
  const all = calls(sf)
  const attaches = all.filter((c) => calleeName(c) === 'attachIpcAdapter')
  if (attaches.length !== 1)
    return [`expected exactly one attachIpcAdapter(), found ${attaches.length}`]
  const [attach] = attaches
  const problems: string[] = []
  if (attach.arguments.length !== 0) problems.push(`line ${lineOf(sf, attach)}: has arguments`)
  if (!isTopLevelStatement(sf, attach)) {
    problems.push(`line ${lineOf(sf, attach)}: not a top-level statement`)
    return problems
  }
  const firstDefine = all.find((c) => isDefineCall(c) && isTopLevelStatement(sf, c))
  if (firstDefine && firstDefine.getStart(sf) < attach.getStart(sf)) {
    problems.push(
      `line ${lineOf(sf, attach)}: after the top-level definition at line ${lineOf(sf, firstDefine)}`
    )
  }
  const registers = all.filter((c) => calleeName(c) === 'registerIpcHandlers')
  if (registers.length === 0) problems.push('no registerIpcHandlers() call')
  for (const r of registers) {
    if (r.getStart(sf) < attach.getStart(sf)) {
      problems.push(
        `line ${lineOf(sf, attach)}: after registerIpcHandlers() at line ${lineOf(sf, r)}`
      )
    }
  }
  return problems
}

// ─── 推送的扫描 ───

type PushVia = 'send' | 'sendToRenderer' | 'pushTo' | 'broadcastToClients'

/** 通道参数在第几个 */
const CHANNEL_ARG: Record<PushVia, number> = {
  send: 0,
  sendToRenderer: 0,
  pushTo: 1,
  broadcastToClients: 0
}

interface PushSite {
  readonly file: string
  readonly line: number
  readonly via: PushVia
  /** 通道参数能静态定下来时的字面量（直接的字面量，或绑定到字面量的顶层 const） */
  readonly channel: string | undefined
  /** 通道之后的参数个数 */
  readonly payloadCount: number
  /** 通道之后有展开参数（`...x`）—— 个数看不出来 */
  readonly spread: boolean
}

/** 顶层 `const NAME = 'literal'`（导出与否都算）：名字 → 字面量 */
function topLevelStringConsts(sf: ts.SourceFile): Map<string, string> {
  const found = new Map<string, string>()
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isStringLiteralLike(decl.initializer)
      ) {
        found.set(decl.name.text, decl.initializer.text)
      }
    }
  }
  return found
}

/** 被扫的文件里，相对路径引入的名字 → [模块（相对 src/main 的路径，找不到为 undefined），导出名] */
function relativeImports(
  sf: ts.SourceFile,
  file: string
): Map<string, [string | undefined, string]> {
  const found = new Map<string, [string | undefined, string]>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const spec = stmt.moduleSpecifier.text
    if (!spec.startsWith('.')) continue
    const base = posix.join(posix.dirname(file), spec)
    const target = [`${base}.ts`, `${base}/index.ts`].find((p) => existsSync(join(MAIN_DIR, p)))
    const bindings = stmt.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        found.set(el.name.text, [target, (el.propertyName ?? el.name).text])
      }
    }
  }
  return found
}

/**
 * 源码里的推送：`x.send(ch, …)` / `send(ch, …)` / `sendToRenderer(ch, …)` / `pushTo(client, ch, …)` /
 * `broadcastToClients(ch, …)`。通道参数按字面量 → 本文件顶层 const → 相对引入的模块的顶层 const 去定。
 */
function pushSitesIn(
  source: string,
  file = 'snippet.ts',
  readModule?: (rel: string) => string | undefined
): PushSite[] {
  const sf = parse(source, file)
  const consts = topLevelStringConsts(sf)
  const imports = readModule
    ? relativeImports(sf, file)
    : new Map<string, [string | undefined, string]>()
  const resolveChannel = (arg: ts.Expression | undefined): string | undefined => {
    if (!arg) return undefined
    if (ts.isStringLiteralLike(arg)) return arg.text
    if (!ts.isIdentifier(arg)) return undefined
    const local = consts.get(arg.text)
    if (local !== undefined) return local
    const imported = imports.get(arg.text)
    if (!imported || !imported[0] || !readModule) return undefined
    const text = readModule(imported[0])
    return text === undefined ? undefined : topLevelStringConsts(parse(text)).get(imported[1])
  }
  const sites: PushSite[] = []
  for (const c of calls(sf)) {
    const name = calleeName(c)
    if (
      name !== 'send' &&
      name !== 'sendToRenderer' &&
      name !== 'pushTo' &&
      name !== 'broadcastToClients'
    ) {
      continue
    }
    const at = CHANNEL_ARG[name]
    const rest = c.arguments.slice(at + 1)
    sites.push({
      file,
      line: lineOf(sf, c),
      via: name,
      channel: resolveChannel(c.arguments[at]),
      payloadCount: rest.length,
      spread: rest.some((a) => ts.isSpreadElement(a))
    })
  }
  return sites
}

/** override 推送通道交给回调的载荷个数（`events.subscribe` 交一个事件、`sync.onFrame` 交（链路 id，帧）） */
const OVERRIDE_EVENT_ARGS: Readonly<Record<string, number>> = { 'app:event': 1, 'sync:frame': 2 }

/** 推送通道 → 交给回调的载荷个数 */
function eventArity(): Map<string, number> {
  const map = new Map<string, number>()
  for (const [, members] of Object.entries(API_TABLE)) {
    for (const m of Object.values(members)) if (m.kind === 'event') map.set(m.channel, m.args)
  }
  for (const e of OVERRIDE_ENTRIES)
    if (e.kind === 'event') map.set(e.channel, OVERRIDE_EVENT_ARGS[e.channel])
  return map
}

// ─── 被扫的源码 ───

/** src/main 下所有 .ts（跳过 __tests__ 与 *.test.ts），路径一律用 / 分隔、相对 src/main */
function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      found.push(...sourceFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(relative(MAIN_DIR, full).split(sep).join('/'))
    }
  }
  return found
}

const mainFiles = sourceFiles(MAIN_DIR).sort()
const sources = new Map(mainFiles.map((rel) => [rel, readFileSync(join(MAIN_DIR, rel), 'utf8')]))
const read = (rel: string): string => {
  const text = sources.get(rel)
  if (text === undefined) throw new Error(`not a scanned source: ${rel}`)
  return text
}

const REGISTRY = 'ipc/registry.ts'
const ADAPTER = 'ipc/ipcAdapter.ts'

const allDefinitions: Definition[] = mainFiles
  .filter((rel) => rel !== REGISTRY)
  .flatMap((rel) => definitionsIn(read(rel), rel))

const allPushSites: PushSite[] = mainFiles.flatMap((rel) =>
  pushSitesIn(read(rel), rel, (m) => sources.get(m))
)

// ─── 用例 ───

describe('CG-0 扫描器自检', () => {
  it('CG-0 定义：注释里的不算；跨行调用算；模板串 / 标识符通道被报出来；顶层与否分得清', () => {
    const src = [
      "import { defineHandler, defineListener } from './registry'", // 1
      "// defineHandler('x:comment', () => 1)", // 2
      "/* defineListener('x:block', () => {}) */", // 3
      'const s = "defineHandler(\'x:string\', fn)"', // 4
      "defineHandler('x:one', () => 1)", // 5
      'defineListener(', // 6
      "  'x:multi',", // 7
      '  (ctx) => {}', // 8
      ')', // 9
      'defineHandler(`x:${s}`, () => 1)', // 10
      'defineListener(CHANNEL, () => {})', // 11
      'export function registerXHandlers(): void {', // 12
      "  defineHandler('x:inner', () => 1)", // 13
      '}', // 14
      "buf.toString('hex')" // 15 —— 原型链上的名字不是定义
    ].join('\n')
    const defs = definitionsIn(src, 'ipc/x.ts')
    expect(defs.map((d) => [d.line, d.kind, d.channel ?? null, d.topLevel])).toEqual([
      [5, 'handle', 'x:one', true],
      [6, 'listen', 'x:multi', true],
      [10, 'handle', null, true],
      [11, 'listen', null, true],
      [13, 'handle', 'x:inner', false]
    ])
    expect(nonLiteralDefinitions(defs)).toEqual(['ipc/x.ts:10 (`x:${s}`)', 'ipc/x.ts:11 (CHANNEL)'])
    expect(
      duplicateDefinitions([...defs, ...definitionsIn("defineListener('x:one', f)", 'ipc/y.ts')])
    ).toEqual(['x:one @ ipc/x.ts:5, ipc/y.ts:1'])
  })

  it('CG-0 覆盖与可达：缺的、种类不对的、重复的、推送通道上的、已删的通道各归各类；放行表放得过', () => {
    const entries: TableEntry[] = [
      { name: 'a.inv', kind: 'invoke', channel: 'a:inv' },
      { name: 'a.snd', kind: 'send', channel: 'a:snd' },
      { name: 'a.missing', kind: 'invoke', channel: 'a:missing' },
      { name: 'a.wrong', kind: 'invoke', channel: 'a:wrong' },
      { name: 'a.twice', kind: 'invoke', channel: 'a:twice' },
      { name: 'a.ev', kind: 'event', channel: 'a:ev' }
    ]
    const defs = definitionsIn(
      [
        "defineHandler('a:inv', f)",
        "defineListener('a:snd', f)",
        "defineListener('a:wrong', f)",
        "defineHandler('a:twice', f)",
        "defineHandler('a:twice', g)",
        "defineHandler('a:ev', f)",
        "defineHandler('dialog:readTextFile', f)",
        "defineHandler('main:only', f)"
      ].join('\n'),
      'ipc/s.ts'
    )
    expect(tableCoverage(entries, defs)).toEqual({
      missing: ['a.missing'],
      wrongKind: ['a.wrong'],
      multiple: ['a.twice']
    })
    expect(unreachableDefinitions(defs, entries, { 'main:only': '理由' })).toEqual([
      'a:wrong (listen) @ ipc/s.ts:3',
      'a:ev (handle) @ ipc/s.ts:6',
      'dialog:readTextFile (handle) @ ipc/s.ts:7'
    ])
  })

  it('CG-0 接线：导出的 register*Handlers 认得出；handlers.ts 的引入与函数体里的调用认得出', () => {
    expect(
      exportedRegisterFns(
        [
          'export function registerAHandlers(): void {}',
          'function registerBHandlers(): void {}',
          'export const registerCHandlers = (): void => {}',
          'export function helper(): void {}'
        ].join('\n')
      )
    ).toEqual(['registerAHandlers', 'registerCHandlers'])
    const wiring = aggregatorWiring(
      [
        "import { registerAHandlers } from './a'",
        "import { registerBHandlers as b } from './b'",
        'export function registerIpcHandlers(): void {',
        '  registerAHandlers()',
        '}',
        'registerCHandlers()'
      ].join('\n')
    )
    expect([...wiring.imports]).toEqual([['registerAHandlers', './a']])
    expect([...wiring.called]).toEqual(['registerAHandlers'])
  })

  it('CG-0 ipcMain：注释与字符串不算，别名引入也认得；attachIpcAdapter 的位置分得清', () => {
    const src = [
      "import { ipcMain as m, app } from 'electron'", // 1
      '// ipcMain.handle(x)', // 2
      "const s = 'ipcMain'", // 3
      'const x = electron.ipcMain', // 4
      'ipcMain.on(c, f)' // 5
    ].join('\n')
    expect(ipcMainIdentifiers(src)).toEqual([1, 4, 5])
    expect(ipcMainImports(src)).toEqual([1])

    const ok = [
      'attachIpcAdapter()',
      "defineHandler('a', f)",
      'app.whenReady().then(() => registerIpcHandlers())'
    ]
    expect(attachPlacementProblems(ok.join('\n'))).toEqual([])
    expect(
      attachPlacementProblems(
        ["defineHandler('a', f)", 'attachIpcAdapter()', 'registerIpcHandlers()'].join('\n')
      )
    ).toEqual(['line 2: after the top-level definition at line 1'])
    expect(
      attachPlacementProblems(['registerIpcHandlers()', 'attachIpcAdapter()'].join('\n'))
    ).toEqual(['line 2: after registerIpcHandlers() at line 1'])
    expect(
      attachPlacementProblems(
        ['function f() { attachIpcAdapter() }', 'registerIpcHandlers()'].join('\n')
      )
    ).toEqual(['line 1: not a top-level statement'])
    expect(
      attachPlacementProblems(['attachIpcAdapter(fake)', 'registerIpcHandlers()'].join('\n'))
    ).toEqual(['line 1: has arguments'])
    expect(
      attachPlacementProblems(['attachIpcAdapter()', 'attachIpcAdapter()'].join('\n'))
    ).toEqual(['expected exactly one attachIpcAdapter(), found 2'])
    // 注释里的不算
    expect(attachPlacementProblems('// attachIpcAdapter()\nregisterIpcHandlers()')).toEqual([
      'expected exactly one attachIpcAdapter(), found 0'
    ])
  })

  it('CG-0 推送：四种写法、字面量 / 顶层 const 能定下来；参数 / 注释 / 展开分得清', () => {
    const src = [
      "const CH = 'x:const'", // 1
      "wc.send('x:lit', p)", // 2
      'win?.webContents.send(CH, a, b)', // 3
      "pushTo(client, 'x:push', p)", // 4
      "broadcastToClients('x:b')", // 5
      "sendToRenderer('x:r', p)", // 6
      "// wc.send('x:comment', p)", // 7
      'function f(channel: string) { wc.send(channel, p) }', // 8
      "wc.send('x:spread', ...rest)", // 9
      "function g() { const LOCAL = 'x:local'; wc.send(LOCAL, p) }" // 10
    ].join('\n')
    expect(
      pushSitesIn(src).map((s) => [s.line, s.via, s.channel ?? null, s.payloadCount, s.spread])
    ).toEqual([
      [2, 'send', 'x:lit', 1, false],
      [3, 'send', 'x:const', 2, false],
      [4, 'pushTo', 'x:push', 1, false],
      [5, 'broadcastToClients', 'x:b', 0, false],
      [6, 'sendToRenderer', 'x:r', 1, false],
      [8, 'send', null, 1, false],
      [9, 'send', 'x:spread', 1, true],
      [10, 'send', null, 1, false]
    ])
  })

  it('CG-0 推送：相对引入的顶层 const 能定下来（按真文件解析）；找不到的模块定不下来', () => {
    const sites = pushSitesIn(
      [
        "import { SYNC_FRAME_CHANNEL as F } from '../frontend/sync/ipcLink'",
        "import { NOPE } from './doesNotExist'",
        'wc.send(F, a, b)',
        'wc.send(NOPE, a)'
      ].join('\n'),
      'ipc/user.ts',
      (rel) => sources.get(rel)
    )
    expect(sites.map((s) => s.channel ?? null)).toEqual(['sync:frame', null])
  })
})

describe('扫到的确实是主进程源码', () => {
  it('index.ts、ipc/handlers.ts、registry / 适配器都在；定义与推送都扫到了不少', () => {
    expect(mainFiles).toEqual(
      expect.arrayContaining(['index.ts', 'ipc/handlers.ts', REGISTRY, ADAPTER])
    )
    expect(mainFiles.some((rel) => rel.includes('__tests__') || rel.endsWith('.test.ts'))).toBe(
      false
    )
    expect(allDefinitions.length).toBeGreaterThan(200)
    expect(allPushSites.length).toBeGreaterThan(20)
  })
})

describe('CG-1 通道是字符串字面量', () => {
  it('CG-1 registry.ts 之外每一处 defineHandler / defineListener 的第一个参数都是字符串字面量', () => {
    expect(nonLiteralDefinitions(allDefinitions)).toEqual([])
  })
})

describe('CG-2 没有重复定义', () => {
  it('CG-2 没有哪条通道被定义两次（跨文件也算）', () => {
    expect(duplicateDefinitions(allDefinitions)).toEqual([])
  })
})

describe('CG-3 表 → 主进程', () => {
  it('CG-3 每条 invoke / send（表 + override）恰有一个同种类的定义', () => {
    expect(tableCoverage(ALL_ENTRIES, allDefinitions)).toEqual({
      missing: [],
      wrongKind: [],
      multiple: []
    })
  })
})

describe('CG-4 主进程 → 表', () => {
  it('CG-4 每条定义都是表 ∪ override 里同种类的请求通道', () => {
    expect(unreachableDefinitions(allDefinitions, ALL_ENTRIES, MAIN_ONLY)).toEqual([])
  })

  it('CG-4 放行表今天是空的；放行的通道必须真有定义', () => {
    expect(Object.keys(MAIN_ONLY)).toEqual([])
    const defined = new Set(allDefinitions.map((d) => d.channel))
    expect(Object.keys(MAIN_ONLY).filter((ch) => !defined.has(ch))).toEqual([])
  })

  it('CG-4 已删掉的 dialog:readTextFile 没有定义', () => {
    expect(allDefinitions.filter((d) => d.channel === 'dialog:readTextFile')).toEqual([])
  })
})

describe('CG-5 定义住在哪里、怎么接上', () => {
  it('CG-5 除 index.ts 外，有定义的文件都是 ipc/*.ts 且导出一个 register*Handlers', () => {
    const files = [...new Set(allDefinitions.map((d) => d.file))].filter((f) => f !== 'index.ts')
    expect(files.length).toBeGreaterThan(30)
    const bad = files.filter(
      (f) => !/^ipc\/[^/]+\.ts$/.test(f) || exportedRegisterFns(read(f)).length === 0
    )
    expect(bad).toEqual([])
  })

  it('CG-5 ipc/*.ts 导出的每个 register*Handlers 都在 handlers.ts 里被引入、并在 registerIpcHandlers 里被调用', () => {
    const ipcFiles = mainFiles.filter((rel) => /^ipc\/[^/]+\.ts$/.test(rel))
    const exported = ipcFiles.flatMap((rel) =>
      exportedRegisterFns(read(rel))
        .filter((name) => name !== 'registerIpcHandlers')
        .map((name) => ({ name, module: `./${posix.basename(rel, '.ts')}` }))
    )
    expect(exported.length).toBeGreaterThan(30)
    const { imports, called } = aggregatorWiring(read('ipc/handlers.ts'))
    const notImported = exported
      .filter(({ name, module }) => imports.get(name) !== module)
      .map((e) => e.name)
    const notCalled = exported.filter(({ name }) => !called.has(name)).map((e) => e.name)
    expect({ notImported, notCalled }).toEqual({ notImported: [], notCalled: [] })
    // registerIpcHandlers 本身就在 handlers.ts 里
    expect(exportedRegisterFns(read('ipc/handlers.ts'))).toContain('registerIpcHandlers')
  })

  it('CG-5 index.ts 里的定义都是顶层语句', () => {
    const inIndex = allDefinitions.filter((d) => d.file === 'index.ts')
    expect(inIndex.length).toBeGreaterThan(0)
    expect(
      inIndex.filter((d) => !d.topLevel).map((d) => `index.ts:${d.line} ${d.channel}`)
    ).toEqual([])
  })
})

describe('CG-6 只有适配器碰 ipcMain；适配器在最早处挂上一次', () => {
  it('CG-6 除 ipc/ipcAdapter.ts 外没有标识符 ipcMain，也没有从 electron 引 ipcMain', () => {
    const identifiers = mainFiles
      .filter((rel) => rel !== ADAPTER)
      .flatMap((rel) => ipcMainIdentifiers(read(rel)).map((line) => `${rel}:${line}`))
    const imports = mainFiles
      .filter((rel) => rel !== ADAPTER)
      .flatMap((rel) => ipcMainImports(read(rel)).map((line) => `${rel}:${line}`))
    expect({ identifiers, imports }).toEqual({ identifiers: [], imports: [] })
    // 适配器自己确实引了它（扫描器没扫空）
    expect(ipcMainImports(read(ADAPTER)).length).toBe(1)
  })

  it('CG-6 非测试代码里恰有一处 attachIpcAdapter()，在 index.ts', () => {
    const sites = mainFiles.flatMap((rel) => attachCalls(read(rel)).map(() => rel))
    expect(sites).toEqual(['index.ts'])
  })

  it('CG-6 index.ts：顶层、不带参数，在第一条顶层定义之前、在 registerIpcHandlers() 之前', () => {
    expect(attachPlacementProblems(read('index.ts'))).toEqual([])
  })
})

describe('CG-7 每条推送通道都有人推', () => {
  const arity = eventArity()

  it('CG-7 override 的推送通道都有载荷个数（OVERRIDE_EVENT_ARGS 与 override 的 event 一致）', () => {
    const overrideEvents = OVERRIDE_ENTRIES.filter((e) => e.kind === 'event').map((e) => e.channel)
    expect(Object.keys(OVERRIDE_EVENT_ARGS).sort()).toEqual([...new Set(overrideEvents)].sort())
  })

  it('CG-7 表里每条 event 与 override 的 event 至少有一处推送', () => {
    const pushed = new Set(allPushSites.map((s) => s.channel))
    const unpushed = [...arity.keys()].filter((ch) => !pushed.has(ch))
    expect(unpushed).toEqual([])
    // sync:frame 是经顶层 const（SYNC_FRAME_CHANNEL）推的：确实定下来了
    expect(
      allPushSites.some((s) => s.channel === 'sync:frame' && s.file === 'frontend/sync/ipcLink.ts')
    ).toBe(true)
  })

  it('CG-7 交给 pushTo / broadcastToClients / sendToRenderer 的字面量通道都是推送通道', () => {
    const stray = allPushSites
      .filter((s) => s.via !== 'send' && s.file !== REGISTRY && s.file !== ADAPTER)
      .filter((s) => s.channel !== undefined && !arity.has(s.channel))
      .map((s) => `${s.channel} via ${s.via} @ ${s.file}:${s.line}`)
    expect(stray).toEqual([])
  })
})

describe('CG-8 推送的载荷个数', () => {
  it('CG-8 每处推送通道之后的参数个数 = 表里的 args（没有展开参数）', () => {
    const arity = eventArity()
    const bad = allPushSites
      .filter((s) => s.channel !== undefined && arity.has(s.channel))
      .filter((s) => s.spread || s.payloadCount !== arity.get(s.channel!))
      .map(
        (s) =>
          `${s.channel} via ${s.via} @ ${s.file}:${s.line}: ${s.spread ? 'spread' : s.payloadCount} != ${arity.get(s.channel!)}`
      )
    expect(bad).toEqual([])
    // 零个与两个的那几条确实被核对过
    const checked = allPushSites.filter((s) => s.channel !== undefined && arity.has(s.channel))
    expect(checked.some((s) => s.channel === 'app:new-chat' && s.payloadCount === 0)).toBe(true)
    expect(checked.some((s) => s.channel === 'sync:frame' && s.payloadCount === 2)).toBe(true)
  })
})
