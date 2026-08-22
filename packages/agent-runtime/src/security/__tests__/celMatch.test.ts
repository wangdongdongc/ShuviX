/**
 * celMatch —— CEL 匹配层直测：compileMatch 只校验语法（未知面推迟到求值期）、
 * evaluateMatch 的 strict 语义与错误吸收、inDir 段边界/空串防御、sep 绑定环境、
 * evaluateLet 的 {vars} 上下文。
 */
import { describe, it, expect } from 'vitest'
import { compileMatch, evaluateMatch, evaluateLet } from '../celMatch'

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
