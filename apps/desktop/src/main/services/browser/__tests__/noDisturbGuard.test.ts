/**
 * 「agent 的浏览器动作绝不打扰主窗口里的用户」—— 两条 lint 形状的用例，扫的是**源码**本身。
 *
 * 行为用例（browserWindowService / browserBackendBackground / browserViewExternalOpen）只能证明
 * **今天那几条路**不弹窗、不抢焦点；这里挡的是**以后**新加的调用 —— 那种事故没有哪条行为用例会
 * 变红，症状只是用户在主窗口里打着字，浏览器窗口突然叠到最前（或截图 / 点击在后台悄悄失效）。
 *
 *   ST-U13  main/index.ts：
 *           (a) 恰好一处 `app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')`
 *               —— 参数是字符串字面量、不带值，是**顶层语句**（不在函数、whenReady 回调、if、is.dev
 *               分支里），且位于第一条 `app.whenReady(` 顶层语句之前（开关只在 ready 之前生效）。
 *               没有它，停放窗口 / 被盖住 / 被关 / 最小化的窗口里新出生的 view 拿不到第一帧；e2e 自己
 *               带着这个开关启动，看不见它缺失，所以只能在这里钉；
 *           (b) Dock 的 `app.on('activate', …)` 按主窗口本身判断要不要重建（引用 mainWindow），不调
 *               `getAllWindows` —— 停放窗口从不显示却一直在，「一个窗口都没有」永远不成立。
 *   ST-U14  (a) src/main 里（跳过 __tests__）调用 `openBrowserWindow(` 的只有 ipc/browserViewHandlers.ts
 *               （用户的按钮经它进来）；定义与再导出不算调用；
 *           (b) services/browser/*.ts 里 `.show / .showInactive / .focus / .restore / .moveTop(` 的调用
 *               只出现在 openBrowserWindow 的函数体里，stagingWindow.ts 一处都没有；
 *           (c) services/browser/*.ts 里每一处 `.setVisible(` 恰好一个参数、就是字面量 `true`
 *               —— tab 的 view 永远不隐藏（隐藏的 view 截图失败、点击不落地）。
 *   NG-U10  (a) browserBackend.ts 里每一处 `browserCdpOps.X(` 调用都在传给 `this.guarded(` 的函数字面量里
 *               —— 只读 / 不会打开文件框的那几个除外（snapshotOp / readPageOp / waitForOp / networkOp /
 *               consoleOp / eventsOp / uploadFileOp，以及 openTab 里的 waitForLoad / markDocument /
 *               loadNote）。新加一个会点、会按键、会跑页面脚本的动作却忘了包，文件框就会从后台弹出来；
 *           (b) services/browser/*.ts 里调用 `showOpenDialog(` 与 `.print(` 的只有 agentGuards.ts ——
 *               原生文件框与原生打印框只能从那道「用户正看着浏览器窗口」的判断后面出来。
 *
 * 用 TypeScript 的语法树而不是正则：源码注释里就写着 `setVisible(false)`、`showInactive` 这些字样
 * （解释为什么不许用），正则会把注释当调用。每个扫描器先对着几段手写的小源码自检。
 * 路径从 `import.meta.url` 往上找 src/main（与 backgroundThrottlingGuard.test.ts 同一做法）。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/src/main/services/browser/__tests__` 往上三层 */
const MAIN_DIR = resolve(HERE, '../../..')
const BROWSER_DIR = resolve(HERE, '..')

const SWITCH = 'disable-backgrounding-occluded-windows'
const SURFACING = new Set(['show', 'showInactive', 'focus', 'restore', 'moveTop'])

// ─── 语法树小工具 ───

function parse(source: string, fileName = 'snippet.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
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

/** 调用表达式调的方法名（`x.foo(…)` / `x?.foo(…)` / `x['foo'](…)` / `foo(…)` → 'foo'） */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text
  }
  return undefined
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

/** 源码里 `.setVisible(…)` 调用参数不是恰好一个 `true` 的地方，`行号:参数原文` */
function badSetVisible(source: string): string[] {
  const sf = parse(source)
  return calls(sf)
    .filter((c) => calleeName(c) === 'setVisible')
    .filter((c) => !(c.arguments.length === 1 && c.arguments[0].kind === ts.SyntaxKind.TrueKeyword))
    .map((c) => `${lineOf(sf, c)}:(${c.arguments.map((a) => a.getText(sf)).join(', ')})`)
}

/** 源码里「弄到眼前」的方法调用中，不在 `openBrowserWindow` 函数体里的，`行号:方法名` */
function surfacingOutsideOpen(source: string): string[] {
  const sf = parse(source)
  const insideOpen = (node: ts.Node): boolean => {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name?.text === 'openBrowserWindow') return true
    }
    return false
  }
  return calls(sf)
    .filter((c) => !ts.isIdentifier(c.expression)) // 只看成员调用：x.show()
    .filter((c) => SURFACING.has(calleeName(c) ?? ''))
    .filter((c) => !insideOpen(c))
    .map((c) => `${lineOf(sf, c)}:${calleeName(c)}`)
}

/** 源码里调用 openBrowserWindow（标识符或成员）的行号；定义、导入、再导出都不是调用 */
function openBrowserWindowCalls(source: string): number[] {
  const sf = parse(source)
  return calls(sf)
    .filter((c) => calleeName(c) === 'openBrowserWindow')
    .map((c) => lineOf(sf, c))
}

/**
 * main/index.ts 里那个 Chromium 开关的问题清单；空数组 = 合格：
 * 恰好一处、字面量、不带值、顶层语句、在第一条 app.whenReady( 顶层语句之前。
 */
function occludedSwitchProblems(source: string): string[] {
  const sf = parse(source)
  const hits = calls(sf).filter(
    (c) =>
      chainOf(c.expression) === 'app.commandLine.appendSwitch' &&
      c.arguments.length > 0 &&
      ts.isStringLiteralLike(c.arguments[0]) &&
      c.arguments[0].text === SWITCH
  )
  if (hits.length !== 1)
    return [`expected exactly one appendSwitch('${SWITCH}'), found ${hits.length}`]
  const [call] = hits
  const problems: string[] = []
  if (call.arguments.length !== 1) problems.push(`line ${lineOf(sf, call)}: has a value argument`)
  const stmt = call.parent
  const topLevel = ts.isExpressionStatement(stmt) && stmt.parent === sf
  if (!topLevel) problems.push(`line ${lineOf(sf, call)}: not a top-level statement`)
  const whenReadyAt = sf.statements.findIndex((s) =>
    calls(s).some((c) => chainOf(c.expression) === 'app.whenReady')
  )
  if (whenReadyAt < 0) problems.push('no top-level app.whenReady( statement')
  else if (topLevel && sf.statements.indexOf(stmt as ts.Statement) > whenReadyAt) {
    problems.push(`line ${lineOf(sf, call)}: after the first app.whenReady( statement`)
  }
  return problems
}

/** `app.on('activate', fn)` 的问题清单；空数组 = 合格：恰好一处，fn 里不调 getAllWindows、引用 mainWindow */
function activateProblems(source: string): string[] {
  const sf = parse(source)
  const listeners = calls(sf).filter(
    (c) =>
      chainOf(c.expression) === 'app.on' &&
      c.arguments.length >= 2 &&
      ts.isStringLiteralLike(c.arguments[0]) &&
      c.arguments[0].text === 'activate'
  )
  if (listeners.length !== 1)
    return [`expected exactly one app.on('activate'), found ${listeners.length}`]
  const fn = listeners[0].arguments[1]
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))
    return ['listener is not a function literal']
  const problems: string[] = []
  for (const c of calls(fn)) {
    if (calleeName(c) === 'getAllWindows')
      problems.push(`line ${lineOf(sf, c)}: calls getAllWindows`)
  }
  let mentionsMain = false
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === 'mainWindow') mentionsMain = true
    ts.forEachChild(n, visit)
  }
  visit(fn.body)
  if (!mentionsMain) problems.push('listener does not look at mainWindow')
  return problems
}

/** 不必包进防护的 browserCdpOps 成员（只读的配方，与 openTab 的加载等待） */
const UNGUARDED_OPS = new Set([
  'snapshotOp',
  'readPageOp',
  'waitForOp',
  'networkOp',
  'consoleOp',
  'eventsOp',
  'uploadFileOp',
  'waitForLoad',
  'markDocument',
  'loadNote'
])

/** node 是否在一个直接作为参数传给 `this.guarded(…)` 的函数字面量里 */
function insideGuarded(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (!ts.isArrowFunction(p) && !ts.isFunctionExpression(p)) continue
    const call = p.parent
    if (
      call &&
      ts.isCallExpression(call) &&
      call.arguments.includes(p as ts.Expression) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      call.expression.name.text === 'guarded'
    ) {
      return true
    }
  }
  return false
}

/** `browserCdpOps.X(…)` 调用，分成包在 this.guarded 里的与没包的（`行号:X`） */
function cdpOpCalls(source: string): { guarded: string[]; bare: string[] } {
  const sf = parse(source)
  const hits = calls(sf).filter(
    (c) =>
      ts.isPropertyAccessExpression(c.expression) &&
      chainOf(c.expression.expression) === 'browserCdpOps'
  )
  const tag = (c: ts.CallExpression): string => `${lineOf(sf, c)}:${calleeName(c)}`
  return {
    guarded: hits.filter((c) => insideGuarded(c)).map(tag),
    bare: hits.filter((c) => !insideGuarded(c)).map(tag)
  }
}

/** 没包进防护、也不在放行表里的 browserCdpOps 调用 */
function unguardedCdpOps(source: string): string[] {
  return cdpOpCalls(source).bare.filter((hit) => !UNGUARDED_OPS.has(hit.split(':')[1]))
}

/** 会弹原生文件框 / 打印框的调用：`showOpenDialog(`（任何形状）与成员调用 `.print(`（`行号:名字`） */
function nativeDialogCalls(source: string): string[] {
  const sf = parse(source)
  return calls(sf)
    .filter((c) => {
      const name = calleeName(c)
      if (name === 'showOpenDialog') return true
      return name === 'print' && !ts.isIdentifier(c.expression)
    })
    .map((c) => `${lineOf(sf, c)}:${calleeName(c)}`)
}

// ─── 被扫的源码 ───

/** src/main 下所有 .ts（跳过 __tests__），路径一律用 / 分隔，相对 src/main */
function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      found.push(...sourceFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(relative(MAIN_DIR, full).split(sep).join('/'))
    }
  }
  return found
}

const mainFiles = sourceFiles(MAIN_DIR).sort()
const browserFiles = readdirSync(BROWSER_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.ts'))
  .map((e) => e.name)
  .sort()
const read = (rel: string): string => readFileSync(join(MAIN_DIR, rel), 'utf8')
const readBrowser = (name: string): string => readFileSync(join(BROWSER_DIR, name), 'utf8')

describe('main/index.ts：遮挡窗口照常合成、Dock 按主窗口重建（ST-U13）', () => {
  it('ST-U13 扫描器自检：合格的写法过；在 whenReady 回调里 / if 里 / 函数里 / whenReady 之后 / 带值 / 只在注释里 都不过', () => {
    const head = "import { app } from 'electron'\n"
    const ready = 'app.whenReady().then(() => {})\n'
    const sw = `app.commandLine.appendSwitch('${SWITCH}')\n`
    expect(occludedSwitchProblems(head + sw + ready)).toEqual([])
    // 别的开关不算数，也不干扰
    expect(
      occludedSwitchProblems(head + "app.commandLine.appendSwitch('other-switch')\n" + sw + ready)
    ).toEqual([])

    expect(occludedSwitchProblems(head + `app.whenReady().then(() => {\n  ${sw}})\n`)).toEqual([
      'line 3: not a top-level statement'
    ])
    expect(
      occludedSwitchProblems(head + `if (process.platform === 'darwin') {\n  ${sw}}\n` + ready)
    ).toEqual(['line 3: not a top-level statement'])
    expect(
      occludedSwitchProblems(head + `function early() {\n  ${sw}}\nearly()\n` + ready)
    ).toEqual(['line 3: not a top-level statement'])
    expect(occludedSwitchProblems(head + ready + sw)).toEqual([
      'line 3: after the first app.whenReady( statement'
    ])
    expect(
      occludedSwitchProblems(head + `app.commandLine.appendSwitch('${SWITCH}', '1')\n` + ready)
    ).toEqual(['line 2: has a value argument'])
    expect(occludedSwitchProblems(head + `// ${sw}/* ${sw} */\n` + ready)).toEqual([
      `expected exactly one appendSwitch('${SWITCH}'), found 0`
    ])
    expect(occludedSwitchProblems(head + sw + sw + ready)).toEqual([
      `expected exactly one appendSwitch('${SWITCH}'), found 2`
    ])
    // 开关名不是字面量：看不出是它，按没有算
    expect(
      occludedSwitchProblems(
        head + `const s = '${SWITCH}'\napp.commandLine.appendSwitch(s)\n` + ready
      )
    ).toEqual([`expected exactly one appendSwitch('${SWITCH}'), found 0`])
  })

  it('ST-U13 扫描器自检：activate 里按 getAllWindows 判断的不过，按 mainWindow 判断的过', () => {
    expect(
      activateProblems(
        "app.on('activate', () => {\n  if (BrowserWindow.getAllWindows().length === 0) createWindow()\n})\n"
      )
    ).toEqual(['line 2: calls getAllWindows', 'listener does not look at mainWindow'])
    expect(
      activateProblems(
        "app.on('activate', function () {\n  if (!mainWindow || mainWindow.isDestroyed()) createWindow()\n})\n"
      )
    ).toEqual([])
    expect(activateProblems("app.on('ready', () => {})\n")).toEqual([
      "expected exactly one app.on('activate'), found 0"
    ])
  })

  it(`ST-U13 main/index.ts：恰好一处顶层、字面量、不带值的 appendSwitch('${SWITCH}')，在第一条 app.whenReady( 之前`, () => {
    expect(mainFiles).toContain('index.ts')
    expect(occludedSwitchProblems(read('index.ts'))).toEqual([])
  })

  it("ST-U13 main/index.ts：app.on('activate') 按 mainWindow 本身判断，不调 getAllWindows", () => {
    expect(activateProblems(read('index.ts'))).toEqual([])
  })
})

describe('只有用户能把浏览器窗口弄出来、tab 永远不隐藏（ST-U14）', () => {
  it('ST-U14 扫描器自检：定义 / 导入 / 再导出 / 注释不算调用；openBrowserWindow 函数体里的 show / focus / restore 不算；setVisible 只放行一个字面量 true', () => {
    expect(
      openBrowserWindowCalls(
        [
          "import { openBrowserWindow } from './browserWindowService'",
          "export { openBrowserWindow } from './browserWindowService'",
          'export function openBrowserWindow(): void {}',
          '// openBrowserWindow()',
          'openBrowserWindow()',
          'wins.openBrowserWindow()'
        ].join('\n')
      )
    ).toEqual([5, 6])

    expect(
      surfacingOutsideOpen(
        [
          'export function openBrowserWindow(): void {',
          '  const w = get()',
          '  if (w.isMinimized()) w.restore()',
          '  w.show()',
          '  w.focus()',
          '}',
          'function reveal(): void { host.showInactive() }',
          'const raise = (): void => win.moveTop()',
          "win['show']()",
          'app.focus({ steal: true })',
          '// win.show()',
          'show()'
        ].join('\n')
      )
    ).toEqual(['7:showInactive', '8:moveTop', '9:show', '10:focus'])

    expect(
      badSetVisible(
        [
          'view.setVisible(true)',
          'view.setVisible(false)',
          'view.setVisible(visible)',
          'view.setVisible()',
          'view.setVisible(true, 1)',
          '// view.setVisible(false)',
          "const s = 'view.setVisible(false)'"
        ].join('\n')
      )
    ).toEqual(['2:(false)', '3:(visible)', '4:()', '5:(true, 1)'])
  })

  it('ST-U14 扫到的确实是浏览器模块：窗口 / 停放窗口 / tab 服务 / 后端都在其中', () => {
    expect(browserFiles).toEqual(
      expect.arrayContaining([
        'browserBackend.ts',
        'browserViewService.ts',
        'browserWindowService.ts',
        'stagingWindow.ts'
      ])
    )
    // 这张表里至少真有一处 show / focus（openBrowserWindow 里）与一处 setVisible(true) —— 扫描器没扫空
    expect(openBrowserWindowCalls(readBrowser('browserWindowService.ts'))).toEqual([])
    expect(
      calls(parse(readBrowser('browserWindowService.ts'))).filter((c) =>
        SURFACING.has(calleeName(c) ?? '')
      ).length
    ).toBeGreaterThan(0)
    expect(readBrowser('browserViewService.ts')).toMatch(/\.setVisible\(true\)/)
  })

  it('ST-U14 src/main 里调用 openBrowserWindow( 的只有 ipc/browserViewHandlers.ts', () => {
    const callers = mainFiles.filter((rel) => openBrowserWindowCalls(read(rel)).length > 0)
    expect(callers).toEqual(['ipc/browserViewHandlers.ts'])
  })

  it('ST-U14 services/browser 里 show / showInactive / focus / restore / moveTop 只在 openBrowserWindow 里调；stagingWindow.ts 一处都没有', () => {
    const hits = browserFiles.flatMap((name) =>
      surfacingOutsideOpen(readBrowser(name)).map((hit) => `${name}:${hit}`)
    )
    expect(hits).toEqual([])
    const staging = calls(parse(readBrowser('stagingWindow.ts'))).filter((c) =>
      SURFACING.has(calleeName(c) ?? '')
    )
    expect(staging).toEqual([])
  })

  it('ST-U14 services/browser 里每一处 setVisible( 都恰好是 setVisible(true)', () => {
    const hits = browserFiles.flatMap((name) =>
      badSetVisible(readBrowser(name)).map((hit) => `${name}:${hit}`)
    )
    expect(hits).toEqual([])
  })
})

describe('会打开文件框的动作都包在防护里、原生文件框 / 打印框只从防护里出来（NG-U10）', () => {
  it('NG-U10 扫描器自检：this.guarded 的函数字面量里的算包了；外面的、别人的 guarded、放行表里的分得清', () => {
    const src = [
      'class B {',
      '  async a() { return this.guarded(uuid, () => browserCdpOps.clickOp(s, u)) }',
      '  async b() { return browserCdpOps.fillOp(s, u, t) }',
      '  async c() { return other.guarded(uuid, () => browserCdpOps.typeOp(s, t)) }',
      '  async d() { return browserCdpOps.snapshotOp(s, url) }',
      '  async e() { return this.guarded(uuid, async function () { return browserCdpOps.cdpOp(s, m) }) }',
      '  async f() { const op = () => browserCdpOps.hoverOp(s, u); return this.guarded(uuid, op) }',
      '  // browserCdpOps.pressKeyOp(s, k)',
      '  async g() { return this.guarded(uuid, () => x.browserCdpOps.scrollOp(s)) }',
      '}'
    ].join('\n')
    expect(cdpOpCalls(src)).toEqual({
      guarded: ['2:clickOp', '6:cdpOp'],
      bare: ['3:fillOp', '4:typeOp', '5:snapshotOp', '7:hoverOp']
    })
    expect(unguardedCdpOps(src)).toEqual(['3:fillOp', '4:typeOp', '7:hoverOp'])

    expect(
      nativeDialogCalls(
        [
          'dialog.showOpenDialog(win, {})',
          'showOpenDialog(win)',
          'wc.print({}, cb)',
          'view.webContents.printToPDF({})',
          '// wc.print()',
          "const src = 'window.print()'",
          'print()'
        ].join('\n')
      )
    ).toEqual(['1:showOpenDialog', '2:showOpenDialog', '3:print'])
  })

  it('NG-U10 browserBackend.ts：九个会动页面的动作都包在 this.guarded 里；没包的只有放行表里的', () => {
    const { guarded } = cdpOpCalls(readBrowser('browserBackend.ts'))
    expect(guarded.map((hit) => hit.split(':')[1]).sort()).toEqual(
      [
        'clickOp',
        'fillOp',
        'typeOp',
        'pressKeyOp',
        'hoverOp',
        'scrollOp',
        'evaluateOp',
        'cdpOp',
        'navigateOp'
      ].sort()
    )
    expect(unguardedCdpOps(readBrowser('browserBackend.ts'))).toEqual([])
  })

  it('NG-U10 services/browser 里调用 showOpenDialog( 与 .print( 的只有 agentGuards.ts', () => {
    const byFile = browserFiles
      .map((name) => [name, nativeDialogCalls(readBrowser(name))] as const)
      .filter(([, hits]) => hits.length > 0)
    expect(byFile.map(([name]) => name)).toEqual(['agentGuards.ts'])
    // 扫到的确实是那两处：一处替用户弹文件框、一处替用户打印
    expect(byFile[0][1].map((hit) => hit.split(':')[1]).sort()).toEqual(['print', 'showOpenDialog'])
  })
})
