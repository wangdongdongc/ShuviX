/**
 * celMatch —— CEL 匹配层直测：compileMatch 只校验语法（未知面推迟到求值期）、
 * evaluateMatch 的 strict 语义与错误吸收、inDir 段边界/空串防御、sep 绑定环境、
 * evaluateLet 的 {vars} 上下文、inDirOnlyVarNames 的目录变量识别、
 * withRealPaths 作用域里 inDir 按位置比较（路径与每个目录两边都解析）。
 */
import { describe, it, expect, vi, type Mock } from 'vitest'
import {
  compileMatch,
  evaluateMatch,
  evaluateLet,
  inDirOnlyVarNames,
  withRealPaths
} from '../celMatch'

/** 典型请求文档（evaluate.buildMatchContext 的产物形态） */
function makeDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: { kind: 'agent', agentKind: 'root', profile: '', sessionId: 's1', depth: 0 },
    action: 'read',
    tool: { name: '', operation: '' },
    object: { type: 'path', path: '/ws/f.txt', displayPath: '/ws/f.txt' },
    env: { host: 'desktop', platform: 'darwin' },
    vars: { workspace: '/ws', skillsDirs: ['/skills/a', '/skills/b'] },
    ...overrides
  }
}

const evalBool = (expression: string, doc = makeDoc(), sep = '/'): boolean =>
  evaluateMatch(expression, doc, sep)

describe('compileMatch — 语法校验', () => {
  it('CM-1 合法表达式（含内置策略的旗舰形态）→ null', () => {
    for (const expression of [
      "subject.kind == 'agent' && action == 'read' && object.type == 'path' && !inDir(object.path, vars.workspace)",
      "object.gitAction in ['init', 'restore'] || (object.gitAction == 'checkout' && object.force)",
      "['.ssh', '.aws'].map(s, vars.home + '/' + s)",
      'true',
      '"workspace" in vars'
    ]) {
      expect(compileMatch(expression)).toBeNull()
    }
  })

  it('CM-2 语法错误 → 非空错误消息字符串', () => {
    for (const expression of ['object.type ==', '(a', 'a &&']) {
      const result = compileMatch(expression)
      expect(typeof result).toBe('string')
      expect(result!.length).toBeGreaterThan(0)
    }
  })

  it('CM-3 未知标识符/未知函数：parse 只校验语法 → null，校验推迟到求值期 throw', () => {
    // 契约钉子：compileMatch 不拒未知面（policyFile 层因此放行，fail-safe 在 evaluate 层兜底）
    expect(compileMatch('bogusVar == "x"')).toBeNull()
    expect(compileMatch('bogusFn(object.path)')).toBeNull()

    expect(() => evalBool('bogusVar == "x"')).toThrow(/Unknown variable/)
    expect(() => evalBool('bogusFn(object.path)')).toThrow(/no matching overload/)
  })
})

describe('evaluateMatch — strict 语义', () => {
  it('CM-4 缺失属性访问 → throw（No such key）——跨 type 误引用的 strict 后果', () => {
    const commandDoc = makeDoc({ object: { type: 'command', command: 'ls', channel: 'bash' } })
    expect(() => evalBool('object.path == "/x"', commandDoc)).toThrow(/No such key/)
    expect(() => evalBool('vars.missing == "x"')).toThrow(/No such key/)
  })

  it('CM-5 && / || 吸收：已定值一侧决定结果时另一侧的缺键错误被吸收（type 守卫位置无关）', () => {
    const commandDoc = makeDoc({ object: { type: 'command', command: 'ls', channel: 'bash' } })
    // 守卫在前：false && error → false
    expect(evalBool("object.type == 'path' && object.path == '/x'", commandDoc)).toBe(false)
    // 守卫在后：error && false → false（CEL 吸收语义）
    expect(evalBool("object.path == '/x' && object.type == 'path'", commandDoc)).toBe(false)
    // || 同理：true || error → true
    expect(evalBool("object.type == 'command' || object.path == '/x'", commandDoc)).toBe(true)
  })

  it('CM-6 非布尔结果 → throw，消息含 must evaluate to a boolean, got <type>', () => {
    expect(() => evalBool('action')).toThrow(
      'match expression must evaluate to a boolean, got string'
    )
    expect(() => evalBool('vars')).toThrow(
      'match expression must evaluate to a boolean, got object'
    )
  })

  it('CM-7 文档命名空间可读：subject/tool/object/env/vars 全维度', () => {
    const doc = makeDoc({
      subject: {
        kind: 'agent',
        agentKind: 'spawned',
        profile: 'widget',
        sessionId: 's1',
        depth: 1
      },
      tool: { name: 'ssh', operation: 'connect' },
      env: { host: 'extension', platform: '' }
    })
    expect(
      evalBool(
        "subject.agentKind == 'spawned' && subject.profile == 'widget' && " +
          "tool.name == 'ssh' && tool.operation == 'connect' && " +
          "env.host == 'extension' && object.type == 'path'",
        doc
      )
    ).toBe(true)
  })

  it('CM-8 顶层注入名（lets 求值产物）可直接引用', () => {
    const doc = makeDoc({ credentialDirs: ['/home/u/.ssh', '/home/u/.aws'] })
    expect(
      evalBool('inDir(object.path, credentialDirs)', {
        ...doc,
        object: { type: 'path', path: '/home/u/.ssh/id_rsa' }
      })
    ).toBe(true)
  })
})

describe('evaluateMatch — inDir', () => {
  it('CM-11 段边界：/foo 命中 /foo/bar.txt 与自身，不命中 /foobar/x；条目带尾分隔符等价', () => {
    expect(evalBool("inDir('/foo/bar.txt', '/foo')")).toBe(true)
    expect(evalBool("inDir('/foobar/x', '/foo')")).toBe(false)
    expect(evalBool("inDir('/foo', '/foo')")).toBe(true)
    expect(evalBool("inDir('/foo/bar.txt', '/foo/')")).toBe(true)
    expect(evalBool("inDir('/foobar/x', '/foo/')")).toBe(false)
  })

  it('CM-12 dirs 形态：字符串/列表（任一命中）/非字符串忽略不 throw/vars 数组值直接作 dirs', () => {
    expect(evalBool("inDir('/b/x', ['/a', '/b'])")).toBe(true)
    expect(evalBool("inDir('/c/x', ['/a', '/b'])")).toBe(false)
    expect(evalBool("inDir('/a/x', [1])")).toBe(false)
    expect(evalBool("inDir('/a/x', 1)")).toBe(false)
    expect(evalBool("inDir('/skills/a/f', vars.skillsDirs)")).toBe(true)
    expect(evalBool("inDir('/elsewhere/f', vars.skillsDirs)")).toBe(false)
  })

  it("CM-12b 空串目录恒不命中（扩展端空 vars 防御：'' + sep 会前缀命中一切绝对路径）", () => {
    expect(evalBool("inDir('/anything', '')")).toBe(false)
    expect(evalBool("inDir('/anything', ['', '/a'])")).toBe(false)
    expect(evalBool("inDir('/a/x', ['', '/a'])")).toBe(true)
    // 空列表同样恒不命中
    const doc = makeDoc({ vars: { empty: [] as string[] } })
    expect(evalBool("inDir('/anything', vars.empty)", doc)).toBe(false)
  })

  it('CM-12c 数组值变量里的坏条目（undefined / null / 数字 / 布尔 / 空串）逐个跳过，旁边的有效条目照常命中', () => {
    const expression = 'inDir(object.path, vars.dirs)'
    const docAt = (path: string, dirs: unknown[]): Record<string, unknown> =>
      makeDoc({ object: { type: 'path', path }, vars: { dirs } })

    const mixed = [undefined, null, 1, true, '', '/bots']
    expect(evalBool(expression, docAt('/bots/x', mixed))).toBe(true)
    expect(evalBool(expression, docAt('/elsewhere/x', mixed))).toBe(false)

    // 一个有效目录都没有：谁都不命中，连根路径也不（'' + sep 的前缀陷阱照样挡住）
    const onlyBad = [undefined, null, '']
    expect(evalBool(expression, docAt('/bots/x', onlyBad))).toBe(false)
    expect(evalBool(expression, docAt('/', onlyBad))).toBe(false)
  })

  it('CM-12d 两变量列表 [vars.a, vars.b]：一格为 null / 空串不耽误另一格；两格都无效则恒不命中', () => {
    const expression = 'inDir(object.path, [vars.a, vars.b])'
    const docAt = (path: string, vars: Record<string, unknown>): Record<string, unknown> =>
      makeDoc({ object: { type: 'path', path }, vars })

    for (const a of [null, '']) {
      const label = `a=${JSON.stringify(a)}`
      expect(evalBool(expression, docAt('/bots/x', { a, b: '/bots' })), label).toBe(true)
      expect(evalBool(expression, docAt('/elsewhere/x', { a, b: '/bots' })), label).toBe(false)
    }
    expect(evalBool(expression, docAt('/bots/x', { a: null, b: '' }))).toBe(false)
    expect(evalBool(expression, docAt('/x', { a: null, b: '' }))).toBe(false)

    // 为什么守两个目录要写成两个变量：变量与字面量混排的列表字面量是类型错误（cel-js 列表强类型，
    // dyn 与 string 不同型）—— 哪怕 vars.a 本身是合法字符串
    expect(() =>
      evalBool("inDir(object.path, [vars.a, '/lit'])", docAt('/lit/x', { a: '/bots' }))
    ).toThrow(/List elements must have the same type/)
  })

  it('CM-12e CEL 层不宽恕缺失变量：inDir 目录参数里的缺键（含值为 undefined）照样 throw —— 宽恕只在 assemble', () => {
    for (const expression of [
      'inDir(object.path, vars.missing)',
      'inDir(object.path, [vars.missing, vars.workspace])'
    ]) {
      for (const vars of [{ workspace: '/ws' }, { workspace: '/ws', missing: undefined }]) {
        const label = `${expression} × ${'missing' in vars ? 'undefined' : '缺键'}`
        expect(() => evalBool(expression, makeDoc({ vars })), label).toThrow(/No such key: missing/)
      }
    }
  })

  it('CM-13 sep 绑定环境隔离；编译缓存不粘连（同表达式随文档/sep 变化）', () => {
    const expression = 'inDir(object.path, vars.workspace)'
    const winDoc = (path: string): Record<string, unknown> =>
      makeDoc({ object: { type: 'path', path }, vars: { workspace: 'C:\\ws' } })
    const posixDoc = (path: string): Record<string, unknown> =>
      makeDoc({ object: { type: 'path', path } })

    // '\\' 环境按反斜杠段边界
    expect(evaluateMatch(expression, winDoc('C:\\ws\\f.txt'), '\\')).toBe(true)
    expect(evaluateMatch(expression, winDoc('C:\\wsx\\f'), '\\')).toBe(false)
    // '/' 环境对 /-路径生效，且与 '\\' 环境互不污染（交替求值结果稳定）
    expect(evaluateMatch(expression, posixDoc('/ws/f.txt'), '/')).toBe(true)
    expect(evaluateMatch(expression, posixDoc('/wsx/f'), '/')).toBe(false)
    expect(evaluateMatch(expression, winDoc('C:\\ws\\g.txt'), '\\')).toBe(true)
    expect(evaluateMatch(expression, posixDoc('/ws/g.txt'), '/')).toBe(true)

    // 缓存的编译产物不携带上下文：同表达式随 vars 变化
    const custom = makeDoc({
      object: { type: 'path', path: '/other/f' },
      vars: { workspace: '/other' }
    })
    expect(evaluateMatch(expression, custom, '/')).toBe(true)
    expect(evaluateMatch(expression, posixDoc('/other/f'), '/')).toBe(false)
  })
})

/**
 * 按位置比较（withRealPaths）—— 宿主给了 realPath 时，inDir 的路径参数与**每个**目录参数都先过
 * 同一个解析再比。解析器在这里是 Node-free 的假件（一张表：写法 → 真实去处，表外原样），
 * 用 vi.fn 包一层，数得出它被问过哪些参数。
 */
describe('evaluateMatch — inDir 按位置比较（withRealPaths）', () => {
  /** 一张表的假解析器：写法 → 真实去处，表外原样 */
  const resolverOf = (table: Record<string, string>): Mock<(p: string) => string> =>
    vi.fn((p: string): string => table[p] ?? p)
  const docAt = (
    path: string,
    vars: Record<string, unknown> = { workspace: '/ws' }
  ): Record<string, unknown> => makeDoc({ object: { type: 'path', path }, vars })

  it('CM-R1 路径参数被解析：工作区里的一条链接指向凭据目录 → 按位置命中；作用域之外按写法不命中', () => {
    const realPath = resolverOf({ '/ws/key': '/home/u/.ssh/id_rsa' })
    const expression = "inDir(object.path, '/home/u/.ssh')"
    const doc = docAt('/ws/key')

    expect(withRealPaths(realPath, () => evalBool(expression, doc))).toBe(true)
    expect(realPath).toHaveBeenCalledWith('/ws/key')
    // 同一份文档、同一张表，出了作用域就回到按写法比较 —— 解析器一次都不再被问
    realPath.mockClear()
    expect(evalBool(expression, doc)).toBe(false)
    expect(realPath).not.toHaveBeenCalled()
  })

  it('CM-R2 目录参数也被解析：受保护的目录本身是链接（dotfiles 仓库）时，落在它真实位置里的文件照样命中', () => {
    // ~/.ssh → ~/dotfiles/ssh；交来的是真实位置上的私钥（写法里根本没有 .ssh）
    const realPath = resolverOf({ '/home/u/.ssh': '/home/u/dotfiles/ssh' })
    const expression = 'inDir(object.path, vars.credentials)'
    const doc = docAt('/home/u/dotfiles/ssh/id_rsa', { credentials: '/home/u/.ssh' })

    expect(withRealPaths(realPath, () => evalBool(expression, doc))).toBe(true)
    expect(realPath).toHaveBeenCalledWith('/home/u/.ssh')
    // 只按写法（或只解析路径那一边）就对不上 —— 这不在 ~/.ssh 里
    expect(evalBool(expression, doc)).toBe(false)

    // 两边都经链接：经链接的写法 × 经链接的目录，按位置仍是同一处
    const both = resolverOf({
      '/ws/key': '/home/u/dotfiles/ssh/id_rsa',
      '/home/u/.ssh': '/home/u/dotfiles/ssh'
    })
    const viaLink = docAt('/ws/key', { credentials: '/home/u/.ssh' })
    expect(withRealPaths(both, () => evalBool(expression, viaLink))).toBe(true)
  })

  it('CM-R3 目录从哪来都一样被解析：字面量 / 字面量列表 / vars 字符串 / vars 数组 / lets 算出来的列表', () => {
    const realPath = resolverOf({
      '/lit': '/real/lit',
      '/v': '/real/v',
      '/home/u/.ssh': '/real/ssh'
    })
    // lets 的产物：与 assemble 一样经 evaluateLet 算出、以顶层名字注入
    const credentialDirs = evaluateLet(
      "['.ssh'].map(s, vars.home + '/' + s)",
      { home: '/home/u' },
      '/'
    )
    expect(credentialDirs).toEqual(['/home/u/.ssh'])

    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["inDir(object.path, '/lit')", '/real/lit/f', {}],
      ["inDir(object.path, ['/nope', '/lit'])", '/real/lit/f', {}],
      ['inDir(object.path, vars.dir)', '/real/v/f', { vars: { dir: '/v' } }],
      ['inDir(object.path, vars.dirs)', '/real/v/f', { vars: { dirs: ['/nope', '/v'] } }],
      ['inDir(object.path, credentialDirs)', '/real/ssh/id_rsa', { credentialDirs }]
    ]
    for (const [expression, path, extra] of cases) {
      const doc = makeDoc({ object: { type: 'path', path }, ...extra })
      const located = withRealPaths(realPath, () => evalBool(expression, doc))
      expect({ expression, located, written: evalBool(expression, doc) }).toEqual({
        expression,
        located: true,
        written: false
      })
    }
  })

  it('CM-R4 空串目录照样恒不命中，且在解析之前就挡掉（解析一个空串会得到某个进程目录）；非字符串条目也不交给解析器', () => {
    // 一个把 '' 解析成「当前目录」的宿主 —— 若空串先被解析再比，就会前缀命中工作区里的一切
    const realPath = resolverOf({ '': '/ws' })
    const doc = docAt('/ws/f.txt', { a: null, b: '' })
    for (const expression of [
      "inDir(object.path, '')",
      "inDir(object.path, [''])",
      'inDir(object.path, [vars.a, vars.b])'
    ]) {
      const hit = withRealPaths(realPath, () => evalBool(expression, doc))
      expect({ expression, hit }).toEqual({ expression, hit: false })
    }
    // 被问过的只有路径本身：空串与 null 条目都没到解析器那里
    expect(new Set(realPath.mock.calls.map(([p]) => p))).toEqual(new Set(['/ws/f.txt']))
  })

  it('CM-R5 取反的用法与正向一致：`!inDir` 恰是 `inDir` 的反面 —— 链接带出工作区 → 区外；工作区本身是链接 → 区内', () => {
    const expression = 'inDir(object.path, vars.workspace)'
    const negated = '!inDir(object.path, vars.workspace)'
    const table: Array<[string, Record<string, string>, string, boolean]> = [
      // 工作区里的链接指向区外：按位置不在区内（ask-on-read 的取反豁免因此不再豁免它）
      ['链接带出区外', { '/ws/link': '/elsewhere/f' }, '/ws/link', false],
      // 工作区本身是链接（/ws → /data/ws），交来的是真实位置上的文件：按位置在区内
      ['工作区是链接', { '/ws': '/data/ws' }, '/data/ws/f', true]
    ]
    for (const [label, map, path, inside] of table) {
      const realPath = resolverOf(map)
      const doc = docAt(path)
      const hit = withRealPaths(realPath, () => evalBool(expression, doc))
      const miss = withRealPaths(realPath, () => evalBool(negated, doc))
      // 作用域之外按写法：结论恰好翻过来
      const written = evalBool(expression, doc)
      expect({ label, hit, miss, written }).toEqual({
        label,
        hit: inside,
        miss: !inside,
        written: !inside
      })
    }
  })

  it('CM-R6 没有作用域 / 作用域给的是 undefined：按写法比较，谁也不问', () => {
    const realPath = resolverOf({ '/ws/key': '/home/u/.ssh/id_rsa' })
    const expression = "inDir(object.path, '/home/u/.ssh')"
    const doc = docAt('/ws/key')
    expect(evalBool(expression, doc)).toBe(false)
    expect(withRealPaths(undefined, () => evalBool(expression, doc))).toBe(false)
    // 装过一次解析器、离开作用域之后，再求值也不再问它
    expect(withRealPaths(realPath, () => evalBool(expression, doc))).toBe(true)
    realPath.mockClear()
    expect(evalBool(expression, doc)).toBe(false)
    expect(realPath).not.toHaveBeenCalled()
  })

  it('CM-R7 作用域可嵌套、结束复原外层（含内层显式关掉解析）；run 抛错也复原；返回值原样交回', () => {
    const expression = "inDir(object.path, '/target')"
    const doc = docAt('/ws/link')
    const outer = resolverOf({ '/ws/link': '/target/x' })
    const inner = resolverOf({ '/ws/link': '/elsewhere/x' })

    const seen = withRealPaths(outer, () => {
      const before = evalBool(expression, doc)
      const nested = withRealPaths(inner, () => evalBool(expression, doc))
      const disabled = withRealPaths(undefined, () => evalBool(expression, doc))
      const after = evalBool(expression, doc)
      return { before, nested, disabled, after }
    })
    expect(seen).toEqual({ before: true, nested: false, disabled: false, after: true })

    // run 抛错（含 CEL 求值自己的报错）：异常原样穿出，作用域照样复原
    expect(() =>
      withRealPaths(outer, () => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(() =>
      withRealPaths(outer, () => evalBool('inDir(object.path, vars.missing)', doc))
    ).toThrow(/No such key/)
    outer.mockClear()
    expect(evalBool(expression, doc)).toBe(false)
    expect(outer).not.toHaveBeenCalled()

    expect(withRealPaths(outer, () => 42)).toBe(42)
  })
})

/**
 * 内置 ask-on-read 的 match 原文（md 里 `>-` 折叠后的单行形态）—— 刻意抄录而非从 md 读：
 * 这里钉的是「这种写法」被识别，md 日后改写不该让本用例跟着悄悄改义。
 */
const ASK_ON_READ_MATCH =
  '!inDir(object.path, vars.workspace)' +
  ' && !inDir(object.path, vars.toolResultsBase)' +
  ' && !inDir(object.path, vars.skillsDirs)' +
  ' && !inDir(object.path, vars.memoryDirs)'

describe('inDirOnlyVarNames — 只作 inDir 目录参数的 vars 名', () => {
  it('CM-D1 收集目录参数位置的变量（点号 / 字面量下标 / 列表元素，排序去重）；路径参数与别处的其他变量不牵连它', () => {
    const cases: Array<[string, string[]]> = [
      ['inDir(object.path, [vars.botsDir])', ['botsDir']],
      ['inDir(object.path, vars.memoryDirs)', ['memoryDirs']],
      ["inDir(object.path, vars['botsDir'])", ['botsDir']],
      [ASK_ON_READ_MATCH, ['memoryDirs', 'skillsDirs', 'toolResultsBase', 'workspace']],
      // 同一变量多处都只作目录参数：去重；结果排序，与书写顺序无关
      ['inDir(object.path, [vars.b, vars.a]) || inDir(object.path, vars.b)', ['a', 'b']],
      // 路径参数位置的 vars.a 算「别处」—— 只排除 a，不牵连目录参数 b
      ['inDir(vars.a, vars.b)', ['b']],
      // 另一个变量用在比较里：排除的只是那个变量
      ["inDir(object.path, vars.a) || vars.flag == 'on'", ['a']],
      // 宏体里的 inDir 一样认
      ["['/x'].exists(d, inDir(object.path, [vars.a]))", ['a']]
    ]
    for (const [expression, names] of cases) {
      expect({ expression, names: inDirOnlyVarNames(expression) }).toEqual({ expression, names })
    }
  })

  it('CM-D2 同一表达式别处也用到、或目录参数不是裸 vars.x 的变量一律排除；语法错返回空且不 throw', () => {
    for (const expression of [
      // 别处也用到：拼接 / 比较 / has / 作宏的接收者 / 作路径参数
      "inDir(object.path, vars.a) || vars.a + '/x' == object.path",
      "inDir(object.path, vars.a) && vars.a != ''",
      '!has(vars.a) || inDir(object.path, vars.a)',
      'vars.a.exists(d, inDir(object.path, d))',
      "inDir(object.path, [vars.a]) || inDir(vars.a, '/x')",
      // 目录参数不是裸 vars.x：拼接 / 嵌套列表 / 三元 / 取子字段 / 非字面量下标
      'inDir(object.path, vars.a + vars.b)',
      'inDir(object.path, [[vars.a]])',
      'inDir(object.path, true ? vars.a : vars.b)',
      'inDir(object.path, vars.a.b)',
      'inDir(object.path, vars[object.type])',
      // 根本不是 vars：lets 注入的顶层名 / 表达式里没有 inDir
      'inDir(object.path, credentialDirs)',
      'vars.autoAllow'
    ]) {
      // 先确认表达式本身合法 —— 否则空结果可能只是语法错分支给的，而不是被规则排除的
      expect(compileMatch(expression), expression).toBeNull()
      expect({ expression, names: inDirOnlyVarNames(expression) }).toEqual({
        expression,
        names: []
      })
    }

    // 语法错：不 throw、返回空（这种表达式进不了装配 —— policyFile 已判整份非法）
    expect(() => inDirOnlyVarNames('object.type ==')).not.toThrow()
    expect(inDirOnlyVarNames('object.type ==')).toEqual([])
  })
})

describe('evaluateMatch — hasShortFlags', () => {
  /** argv 直接作顶层注入名喂进去（内置策略里它来自 object.commands 的某一条） */
  const flags = (argv: unknown, want: string): boolean =>
    evalBool(`hasShortFlags(argv, '${want}')`, makeDoc({ argv }))

  it('CM-H1 簇写/倒序/分写/夹带无关字母 全部算带齐', () => {
    for (const argv of [
      ['rm', '-rf', '/'],
      ['rm', '-fr', '/'],
      ['rm', '-r', '-f', '/'],
      ['rm', '-vrf', '/']
    ]) {
      expect({ argv, has: flags(argv, 'rf') }).toEqual({ argv, has: true })
    }
  })

  it('CM-H2 缺任一个即 false（deny 规则靠这个「齐」字避免误伤单选项删除）', () => {
    for (const argv of [
      ['rm', '-r', '/'],
      ['rm', '-f', '/'],
      ['rm', '/']
    ]) {
      expect({ argv, has: flags(argv, 'rf') }).toEqual({ argv, has: false })
    }
  })

  it('CM-H3 长选项不算短选项簇', () => {
    // --recursive 里也有 r 和 f，若把长选项当簇拆开会假阳。写规则的人要么另起
    // recursiveForce.all 分支，要么就得不到长选项 —— 引擎不替他做这个决定。
    expect(flags(['rm', '--recursive', '--force', '/'], 'rf')).toBe(false)
  })

  it('CM-H4 大小写敏感：-Rf 不算 rf 带齐', () => {
    // 钉住当前语义。rm 的 -R 与 -r 等价，但「哪些命令的短选项大小写等价」是命令特定的
    // 知识，引擎不猜；策略里要覆盖就再写一个 'Rf' 分支（block-catastrophic-commands 正是）。
    expect(flags(['rm', '-Rf', '/'], 'rf')).toBe(false)
  })

  it('CM-H5 非 GNU 风格的长横线单选项照样被当簇（引擎不做通用 flag 归一化）', () => {
    // `-delete` 匹配 ^-[A-Za-z]+$，于是它「含 d 和 e」为真。这不是 bug 而是取舍的
    // 直接后果：find/dd 都不遵守 GNU 簇约定，判断「这条命令按不按 GNU 解析」的责任
    // 留给写规则的人 —— 与 inDir 同类的接缝。
    expect(flags(['find', '.', '-name', 'x', '-delete'], 'de')).toBe(true)
  })

  it('CM-H6 argv 非数组 / 空数组 / 含非字符串项：不 throw，均为 false', () => {
    expect(flags('rm -rf /', 'rf')).toBe(false)
    expect(flags([], 'rf')).toBe(false)
    expect(flags(['rm', 1], 'rf')).toBe(false)
  })

  it('CM-H7 空 want 恒真（every 的空集语义）——别拿它当「有没有短选项」用', () => {
    expect(flags(['rm', '-rf'], '')).toBe(true)
    expect(flags(['rm'], '')).toBe(true)
  })

  it('CM-H8 单横线本体与 -- 分隔符不是短选项簇', () => {
    expect(flags(['rm', '-', '--', '/'], 'rf')).toBe(false)
  })
})

describe('evaluateLet', () => {
  it('CM-L1 上下文仅 {vars}：字符串拼接、map 宏、列表拼接可用', () => {
    const vars = { home: '/home/u', systemDirs: ['C:\\Windows'] }
    expect(evaluateLet("['.ssh', '.aws'].map(s, vars.home + '/' + s)", vars, '/')).toEqual([
      '/home/u/.ssh',
      '/home/u/.aws'
    ])
    expect(evaluateLet("['/etc'] + vars.systemDirs", vars, '/')).toEqual(['/etc', 'C:\\Windows'])
    expect(evaluateLet('vars.home', vars, '/')).toBe('/home/u')
  })

  it('CM-L2 vars 缺键 → throw（assemble 捕获后 warn，名字缺失走规则级 fail-safe）', () => {
    expect(() => evaluateLet('vars.nope + "/x"', {}, '/')).toThrow(/No such key/)
  })

  it('CM-L3 求值文档以外的名字不可见（无请求上下文）', () => {
    expect(() => evaluateLet('object.path', { home: '/h' }, '/')).toThrow(/Unknown variable/)
  })

  it('CM-8b 布尔检查只在 evaluateMatch：同一表达式经 evaluateLet 返回非布尔值、经 evaluateMatch 则 throw（共享编译缓存无粘连）', () => {
    const expression = "vars.home + '/x'"
    const vars = { home: '/h' }

    // 先经 evaluateLet 编译并缓存：非布尔结果正常返回
    expect(evaluateLet(expression, vars, '/')).toBe('/h/x')
    // 同一缓存产物经 evaluateMatch：结果非布尔 → throw（布尔检查在 evaluateMatch 侧）
    expect(() => evaluateMatch(expression, makeDoc({ vars }), '/')).toThrow(
      'match expression must evaluate to a boolean, got string'
    )
    // 反向无粘连：evaluateMatch 抛过之后 evaluateLet 依旧正常返回值
    expect(evaluateLet(expression, vars, '/')).toBe('/h/x')
  })
})
