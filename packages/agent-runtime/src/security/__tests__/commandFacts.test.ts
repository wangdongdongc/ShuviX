/**
 * projectCommandFacts —— 命令客体结构属性的投影层直测（纯函数，不起解析器）。
 *
 * 这一层是 CEL 唯一能看到的命令结构，所以它的契约要独立于任何一条策略被钉住：
 * 事实用手工字面量喂，摆脱 bash 语法细节（那部分由 shell/__tests__ 的 108 条覆盖），
 * 这里只管「解析层的事实怎么变成规则能写的属性」。
 */
import { describe, it, expect } from 'vitest'
import { projectCommandFacts } from '../commandFacts'
import type {
  LiteralCommand,
  ShellFacts,
  ShellRedirect,
  ShellRedirectKind,
  ShellSpan
} from '../shell'

const SPAN = { start: 0, end: 0 }

function literal(overrides: Partial<LiteralCommand> = {}): LiteralCommand {
  return {
    name: 'rm',
    base: 'rm',
    argv: ['rm'],
    complete: true,
    span: SPAN,
    depth: 0,
    ...overrides
  }
}

function redirect(
  kind: ShellRedirectKind,
  target: string | null,
  span: ShellSpan = SPAN
): ShellRedirect {
  return { kind, target, span }
}

function facts(overrides: Partial<ShellFacts> = {}): ShellFacts {
  return {
    source: '',
    parsed: true,
    reason: 'ok',
    errorSpans: [],
    wordOnly: false,
    wordOnlyCommands: [],
    literalCommands: [],
    dynamics: [],
    redirects: [],
    depthExceeded: false,
    ...overrides
  }
}

describe('projectCommandFacts — 三态与未解析', () => {
  it('CF-1 facts 为 undefined（宿主未注入解析器）→ 全空形态', () => {
    expect(projectCommandFacts(undefined, '/ws', '/')).toEqual({
      parsed: false,
      commands: [],
      writes: []
    })
  })

  it('CF-2 parsed=false 时按 span 取舍：错误区间外的照给，相交的丢', () => {
    // 整树 hasError 就全盘作废，等于「在脚本末尾追加一个未闭合 heredoc」即可关掉
    // 整道结构化门 —— 而 bash 对那种脚本照跑不误。落在任何错误区间之外的节点，
    // 与干净解析出来的一样可信；相交的才是真正说不准的那部分。
    const projected = projectCommandFacts(
      facts({
        parsed: false,
        reason: 'syntax-error',
        errorSpans: [{ start: 100, end: 110 }],
        literalCommands: [
          literal({ argv: ['rm', '-rf', '/'], span: { start: 0, end: 8 } }),
          literal({ argv: ['curl', 'x'], span: { start: 104, end: 112 } })
        ],
        redirects: [
          redirect('write', '/dev/sda', { start: 10, end: 20 }),
          redirect('write', '/dev/nvme0', { start: 99, end: 105 })
        ]
      }),
      '/ws',
      '/'
    )
    expect(projected.parsed).toBe(false)
    expect(projected.commands.map((c) => c.base)).toEqual(['rm'])
    expect(projected.writes).toEqual(['/dev/sda'])
  })

  it('CF-2b 嵌套载荷的节点不参与 span 取舍：它的坐标系不是外层源串', () => {
    // depth>0 的节点来自载荷串的独立且成功的解析（analyze 只在 inner.parsed 时并入），
    // 拿它的 span 去和外层错误区间比是拿两套坐标系相减 —— 一律放行。
    const projected = projectCommandFacts(
      facts({
        parsed: false,
        reason: 'syntax-error',
        errorSpans: [{ start: 0, end: 200 }],
        literalCommands: [
          literal({ argv: ['rm', '-rf', '/'], span: { start: 0, end: 8 }, depth: 1 })
        ]
      }),
      '/ws',
      '/'
    )
    expect(projected.commands.map((c) => c.base)).toEqual(['rm'])
  })
})

describe('projectCommandFacts — commands 投影', () => {
  it('CF-3 null 动态词换成空串且位置保留，complete 原样透传', () => {
    // 位置不能丢：`find . -name $X -delete` 里 -delete 的位置决定语义。
    // 换成空串是因为 cel-js 的列表强类型（['x', null] 直接报元素类型不一致）。
    const projected = projectCommandFacts(
      facts({
        literalCommands: [
          literal({
            name: 'find',
            base: 'find',
            argv: ['find', '.', '-name', null, '-delete'],
            complete: false
          })
        ]
      }),
      '/ws',
      '/'
    )
    expect(projected.commands).toEqual([
      {
        base: 'find',
        argv: ['find', '.', '-name', '', '-delete'],
        wrappers: [],
        complete: false,
        depth: 0
      }
    ])
  })

  it('CF-4 depth 原样透传（嵌套载荷的层级是规则可见的事实）', () => {
    const projected = projectCommandFacts(
      facts({
        literalCommands: [
          literal({ name: 'sh', base: 'sh', argv: ['sh', '-c', 'rm -rf /'] }),
          literal({ argv: ['rm', '-rf', '/'], depth: 1 })
        ]
      }),
      '/ws',
      '/'
    )
    expect(projected.commands.map((c) => c.depth)).toEqual([0, 1])
  })

  it('CF-15 透明 wrapper 在投影时剥掉：base/argv 是有效命令，wrappers 记录剥了什么', () => {
    // 规则按 `c.base == 'rm'` 判定，若这里不解包，`sudo rm -rf /` 的 base 是 sudo ——
    // 而 sudo 前缀恰恰是这条红线最常见的实际写法。解包放在投影层，规则就不必每条都记得。
    const projected = projectCommandFacts(
      facts({
        literalCommands: [
          literal({
            name: '/usr/bin/env',
            base: 'env',
            argv: ['/usr/bin/env', 'FOO=1', 'rm', '-rf', '/']
          })
        ]
      }),
      '/ws',
      '/'
    )
    expect(projected.commands).toEqual([
      { base: 'rm', argv: ['rm', '-rf', '/'], wrappers: ['env'], complete: true, depth: 0 }
    ])
  })
})

describe('projectCommandFacts — writes 投影', () => {
  it('CF-5 只有 write/append 进 writes；read/heredoc/herestring/fd-dup 不进', () => {
    // fd-dup 的 target 根本不是路径（2>&1 的「1」），读方向也不落盘。
    const projected = projectCommandFacts(
      facts({
        redirects: [
          redirect('read', '/in.txt'),
          redirect('write', '/w.txt'),
          redirect('append', '/a.txt'),
          redirect('heredoc', '/h.txt'),
          redirect('herestring', '/hs.txt'),
          redirect('fd-dup', '1')
        ]
      }),
      undefined,
      '/'
    )
    expect(projected.writes).toEqual(['/w.txt', '/a.txt'])
  })

  it('CF-6 target 为 null（目标动态不可知）的写重定向被过滤', () => {
    const projected = projectCommandFacts(
      facts({ redirects: [redirect('write', null), redirect('write', '/w.txt')] }),
      undefined,
      '/'
    )
    expect(projected.writes).toEqual(['/w.txt'])
  })

  it('CF-7 相对目标按 cwd 解析成绝对路径（POSIX）', () => {
    const projected = projectCommandFacts(
      facts({ redirects: [redirect('write', 'out.txt'), redirect('write', './out2.txt')] }),
      '/ws',
      '/'
    )
    expect(projected.writes).toEqual(['/ws/out.txt', '/ws/out2.txt'])
  })

  it('CF-8 . 与 .. 折叠', () => {
    const projected = projectCommandFacts(
      facts({ redirects: [redirect('write', '../a/./b')] }),
      '/ws/x',
      '/'
    )
    expect(projected.writes).toEqual(['/ws/a/b'])
  })

  it('CF-9 绝对目标不受 cwd 影响', () => {
    const projected = projectCommandFacts(
      facts({ redirects: [redirect('write', '/dev/sda')] }),
      '/ws',
      '/'
    )
    expect(projected.writes).toEqual(['/dev/sda'])
  })

  it('CF-10 无 cwd（ssh 远端）→ 相对目标原样，不得被拼成绝对路径', () => {
    // 拼上本地 cwd 会把远端的 `> dev/sda` 变成 /dev/sda 而被块设备规则拒掉 ——
    // 一条普通的远端写文件被当成擦盘，是最不该发生的误拦。
    const projected = projectCommandFacts(
      facts({ redirects: [redirect('write', 'dev/sda'), redirect('write', './sda')] }),
      undefined,
      '/'
    )
    expect(projected.writes).toEqual(['dev/sda', './sda'])
  })

  it('CF-11 Windows sep：正斜杠输入一并归一到反斜杠', () => {
    const projected = projectCommandFacts(
      facts({ redirects: [redirect('write', 'a.txt'), redirect('write', 'sub/../a.txt')] }),
      'C:\\p',
      '\\'
    )
    expect(projected.writes).toEqual(['C:\\p\\a.txt', 'C:\\p\\a.txt'])
  })

  it('CF-12 Windows 绝对盘符路径按 sep 归一', () => {
    const projected = projectCommandFacts(
      facts({ redirects: [redirect('write', 'C:/Windows/x')] }),
      'C:\\p',
      '\\'
    )
    expect(projected.writes).toEqual(['C:\\Windows\\x'])
  })

  it('CF-13 越过根的 .. 不逃逸成 ../（否则拼出的路径无法与目录变量比较）', () => {
    const projected = projectCommandFacts(
      facts({ redirects: [redirect('write', '../../etc/x')] }),
      '/ws',
      '/'
    )
    expect(projected.writes).toEqual(['/etc/x'])
  })
})

describe('projectCommandFacts — 暴露面收敛', () => {
  it('CF-14 返回键恰为 parsed/commands/writes；单条命令键恰为 base/argv/wrappers/complete/depth', () => {
    // 严格轨（wordOnly / wordOnlyCommands）是**唯一可用于放行**的字段，现阶段只落 deny，
    // 就不暴露给 CEL：一旦漏出去，早晚有人拿它写成 allow 规则，而两轨混用正是本模块
    // 最主要的误用风险。这条用例就是那道门。
    const projected = projectCommandFacts(
      facts({
        wordOnly: true,
        wordOnlyCommands: [['rm', '-rf', '/']],
        literalCommands: [literal({ argv: ['rm', '-rf', '/'] })],
        redirects: [redirect('write', '/w.txt')],
        dynamics: ['glob']
      }),
      '/ws',
      '/'
    )
    expect(Object.keys(projected)).toEqual(['parsed', 'commands', 'writes'])
    expect(Object.keys(projected.commands[0])).toEqual([
      'base',
      'argv',
      'wrappers',
      'complete',
      'depth'
    ])
  })
})
