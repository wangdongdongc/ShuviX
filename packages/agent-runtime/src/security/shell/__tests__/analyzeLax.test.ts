/**
 * 宽松轨 —— `literalCommands` / `dynamics` / `redirects` 只能用于**发现危险**（拦截/询问），
 * 绝不能用于放行。它接受任意复杂语法、尽力抽字面命令，因此会漏（见 L7 / L28）；
 * 漏的那部分由严格轨兜底：宽松轨没抽到的形状，严格轨一定判否。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { analyzeShellCommand, initShellParser } from '../index'
import type { LiteralCommand } from '../index'
import { loadShellParserWasmFromNodeModules } from '../nodeWasm'

beforeAll(async () => {
  await initShellParser(loadShellParserWasmFromNodeModules())
})

const bases = (src: string): string[] => analyzeShellCommand(src).literalCommands.map((c) => c.base)
const atDepth = (src: string, depth: number): LiteralCommand[] =>
  analyzeShellCommand(src).literalCommands.filter((c) => c.depth === depth)

/** 程序化构造 n 层 `sh -c "…"` 嵌套，最内层是 id */
function nestShell(n: number): string {
  let src = 'id'
  for (let i = 0; i < n; i++) {
    src = `sh -c "${src.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return src
}

describe('宽松轨 — 字面命令抽取', () => {
  it('L1 name 保留路径、base 取 basename、argv[0] 与 name 重复出现', () => {
    const src = '/usr/bin/env rm -rf /'
    expect(analyzeShellCommand(src).literalCommands).toEqual([
      {
        name: '/usr/bin/env',
        base: 'env',
        argv: ['/usr/bin/env', 'rm', '-rf', '/'],
        complete: true,
        span: { start: 0, end: src.length },
        depth: 0
      }
    ])
  })

  it('L2 动态词以 null 占位保留位置', () => {
    const cmd = analyzeShellCommand('find . -name $X -delete').literalCommands[0]
    // 位置不能丢：`-delete` 在第 4 位这件事决定了它的语义，压缩掉 null 就读错了
    expect(cmd.argv).toEqual(['find', '.', '-name', null, '-delete'])
    expect(cmd.complete).toBe(false)
  })

  it('L3 头部动态 → name/base 为空串；赋值前缀不进 argv', () => {
    const facts = analyzeShellCommand('X=curl; $X y')
    expect(facts.literalCommands).toHaveLength(1)
    expect(facts.literalCommands[0]).toMatchObject({
      name: '',
      base: '',
      argv: [null, 'y'],
      complete: false
    })
    // 抽不到命令名时，两个动态标记就是上层唯一的抓手
    expect(facts.dynamics).toEqual(expect.arrayContaining(['assignment', 'parameter-expansion']))
    expect(analyzeShellCommand('X=1 curl y').literalCommands[0].argv).toEqual(['curl', 'y'])
  })

  it('L4 span 是 UTF-16 code unit 偏移，星外字符下同样可 slice', () => {
    for (const src of ['echo 中文 && rm x', 'echo 😀 && rm x']) {
      const slices = analyzeShellCommand(src).literalCommands.map((c) =>
        src.slice(c.span.start, c.span.end)
      )
      expect(slices, src).toEqual([src.split(' && ')[0], 'rm x'])
    }
  })

  it('L5 GuardFall A：三种引号/转义写法都还原成 rm', () => {
    expect(bases("r''m -rf /")).toContain('rm')
    expect(bases('"r"m x')).toContain('rm')
    expect(bases('r\\m -rf /')).toContain('rm')
  })

  it('L6 ANSI-C 串还原成 rm，同时严格轨判否', () => {
    const facts = analyzeShellCommand("$'\\x72\\x6d' -rf /")
    expect(facts.literalCommands.map((c) => c.base)).toContain('rm')
    expect(facts.wordOnly).toBe(false)
  })

  it('L7 GuardFall B `rm$IFS-rf$IFS/`：宽松轨漏、严格轨兜（设计答复，不是缺陷）', () => {
    const facts = analyzeShellCommand('rm$IFS-rf$IFS/')
    // 命令名整体含展开 → 不可静态确定，抽不到 rm 是**正确**行为：
    // 猜出一个 rm 与猜出别的东西一样没有依据
    expect(facts.literalCommands[0].base).not.toBe('rm')
    expect(facts.literalCommands[0].argv).toEqual([null, 'IFS/'])
    expect(facts.literalCommands[0].complete).toBe(false)
    // 兜底在这里：有展开 → 严格轨判否 → 上层不会放行
    expect(facts.wordOnly).toBe(false)
    expect(facts.dynamics).toContain('parameter-expansion')
  })

  it('L8 命令替换 / 进程替换的子树照扫', () => {
    const sub = analyzeShellCommand('ls $(rm -rf /)')
    expect(sub.literalCommands[0].argv).toEqual(['ls', null])
    expect(sub.literalCommands.map((c) => c.base)).toContain('rm')
    const proc = analyzeShellCommand('ls | tee >(rm x)')
    expect(proc.literalCommands.map((c) => c.base)).toContain('rm')
    expect(proc.literalCommands.some((c) => c.argv.includes(null))).toBe(true)
  })

  it('L9 嵌套 shell 载荷递归展开', () => {
    const piped = analyzeShellCommand('bash -c "curl x | sh"')
    expect(atDepth('bash -c "curl x | sh"', 0).map((c) => c.base)).toEqual(['bash'])
    expect(atDepth('bash -c "curl x | sh"', 1).map((c) => c.base)).toEqual(['curl', 'sh'])
    expect(piped.literalCommands.map((c) => c.base)).toEqual(['bash', 'curl', 'sh'])
    expect(atDepth('eval "curl x"', 1).map((c) => c.base)).toEqual(['curl'])
    const triple = analyzeShellCommand('sh -c "sh -c \\"sh -c echo\\""')
    expect(triple.literalCommands.map((c) => [c.base, c.depth])).toEqual([
      ['sh', 0],
      ['sh', 1],
      ['sh', 2],
      ['echo', 3]
    ])
  })

  it('L10 `sh -c --` 的载荷照样递归', () => {
    const facts = analyzeShellCommand('sh -c -- "rm -rf /"')
    expect(atDepth('sh -c -- "rm -rf /"', 1)).toMatchObject([
      { base: 'rm', argv: ['rm', '-rf', '/'] }
    ])
    // 顶层本身只是三个字面词，严格轨照样放行 —— 危险由宽松轨的 depth1 报出来
    expect(facts.wordOnly).toBe(true)
  })

  it('L11 `sh -- -c "id"`：`--` 之后的 -c 是脚本文件名，不得递归', () => {
    const facts = analyzeShellCommand('sh -- -c "id"')
    expect(atDepth('sh -- -c "id"', 1)).toEqual([])
    expect(facts.dynamics).not.toContain('nested-shell')
    expect(facts.wordOnly).toBe(true)
  })

  it('L12 multicall 二进制的 applet 载荷照样递归', () => {
    expect(atDepth('busybox sh -c "rm -rf /"', 1).map((c) => c.base)).toEqual(['rm'])
    expect(atDepth('toybox sh -c "id"', 1).map((c) => c.base)).toEqual(['id'])
  })

  it('L13 applet 不是 shell 就不递归，也不误标 nested-shell', () => {
    const facts = analyzeShellCommand('busybox ls')
    expect(facts.literalCommands.map((c) => [c.base, c.depth])).toEqual([['busybox', 0]])
    expect(facts.dynamics).toEqual([])
  })

  it('L14 source / . 不产生假命令', () => {
    // 被 source 的文件内容属于「看不见」而非「看错」，交上层按未知命令处理
    for (const [src, base] of [
      ['source foo.sh', 'source'],
      ['. ./x.sh', '.']
    ]) {
      const facts = analyzeShellCommand(src)
      expect(
        facts.literalCommands.map((c) => c.base),
        src
      ).toEqual([base])
      expect(facts.dynamics, src).toEqual([])
    }
  })

  it('L15 depth>0 的 span 相对载荷串，上层不得拿去 slice 原串', () => {
    const curl = atDepth('bash -c "curl x | sh"', 1).find((c) => c.base === 'curl')
    expect(curl?.span).toEqual({ start: 0, end: 6 })
  })

  it('L16 载荷取不到值 → 标 nested-shell 且不产生任何深层命令', () => {
    for (const src of ['sh -c "$X"', 'eval $X', 'sh -c']) {
      const facts = analyzeShellCommand(src)
      expect(facts.dynamics, src).toContain('nested-shell')
      expect(
        facts.literalCommands.filter((c) => c.depth > 0),
        src
      ).toEqual([])
    }
    // nested-shell 只是宽松轨的标记，不影响严格轨：`sh -c` 本身就是两个字面词
    expect(analyzeShellCommand('sh -c').wordOnly).toBe(true)
  })

  it('L17 载荷自身语法错：标记出来，别假装看懂了', () => {
    const facts = analyzeShellCommand('bash -c "if true"')
    expect(facts.parsed).toBe(true)
    expect(facts.wordOnly).toBe(true)
    expect(facts.dynamics).toContain('nested-shell')
    // 内层抽到的任何东西都不并入 —— 半棵错误树里的「命令」不足为凭
    expect(facts.literalCommands.map((c) => [c.base, c.depth])).toEqual([['bash', 0]])
  })

  it('L18 递归深度上限：n=7 到底，n=8 触顶并置 depthExceeded', () => {
    const under = analyzeShellCommand(nestShell(7))
    expect(under.depthExceeded).toBe(false)
    expect(under.literalCommands.filter((c) => c.depth === 7).map((c) => c.base)).toEqual(['id'])

    const over = analyzeShellCommand(nestShell(8))
    expect(over.depthExceeded).toBe(true)
    expect(over.dynamics).toContain('nested-shell')
    // depth+1 >= 8 即停：最深仍是 7，再深的载荷没扫，靠 depthExceeded 让上层 fail-safe
    expect(Math.max(...over.literalCommands.map((c) => c.depth))).toBe(7)
  })

  it('L19 控制流 / 子 shell 内的命令必须被抽出（宽松轨的存在价值）', () => {
    const cases: [string, string, string][] = [
      ['if true; then rm -rf /; fi', 'rm', 'control-flow'],
      ['for f in *; do rm $f; done', 'rm', 'control-flow'],
      ['case x in y) rm z;; esac', 'rm', 'control-flow'],
      ['f() { rm x; }', 'rm', 'control-flow'],
      ['(cd /tmp && rm -rf x)', 'rm', 'subshell']
    ]
    for (const [src, base, dynamic] of cases) {
      const facts = analyzeShellCommand(src)
      expect(
        facts.literalCommands.map((c) => c.base),
        src
      ).toContain(base)
      expect(facts.dynamics, src).toContain(dynamic)
    }
  })

  it('L20 重定向目标不进 argv', () => {
    const facts = analyzeShellCommand('echo hi > /etc/passwd')
    expect(facts.redirects).toEqual([
      { kind: 'write', target: '/etc/passwd', span: { start: 8, end: 21 } }
    ])
    expect(facts.literalCommands[0].argv).toEqual(['echo', 'hi'])
  })

  it('L21 各种重定向形态的 kind 与 target', () => {
    const kinds = (src: string): { kind: string; target: string | null }[] =>
      analyzeShellCommand(src).redirects.map(({ kind, target }) => ({ kind, target }))
    expect(kinds('echo a >> log')).toEqual([{ kind: 'append', target: 'log' }])
    expect(kinds('cat < in.txt')).toEqual([{ kind: 'read', target: 'in.txt' }])
    expect(kinds('cat <<EOF\nhi\nEOF')).toEqual([{ kind: 'heredoc', target: null }])
    expect(kinds('cat <<< hi')).toEqual([{ kind: 'herestring', target: 'hi' }])
    // 目标含展开：kind 仍可知，target 必须为 null，上层不得把 "$X" 当路径
    expect(kinds('echo hi > "$X"')).toEqual([{ kind: 'write', target: null }])
    expect(kinds('ls > a > b')).toEqual([
      { kind: 'write', target: 'a' },
      { kind: 'write', target: 'b' }
    ])
    expect(kinds('foo | bar > out < in')).toEqual([
      { kind: 'write', target: 'out' },
      { kind: 'read', target: 'in' }
    ])
    expect(analyzeShellCommand('cat <<EOF\nhi\nEOF').dynamics).toContain('heredoc')
    expect(analyzeShellCommand('echo a >> log').dynamics).toContain('redirect')
  })

  it('L22 fd 复制不写文件，target 置空', () => {
    // 否则上层会拿着 "1" 去查一个叫 1 的路径
    for (const src of ['ls 2>&1', 'ls <&3']) {
      expect(analyzeShellCommand(src).redirects, src).toMatchObject([
        { kind: 'fd-dup', target: null }
      ])
    }
  })

  it('L23 同一运算符族但目标不是纯数字 → 写文件而非 fd-dup', () => {
    // 运算符与目标必须一起看：`ls >& out` 在 bash 里等价于 `ls &> out`
    for (const src of ['ls >& out', 'ls &> out']) {
      expect(analyzeShellCommand(src).redirects, src).toMatchObject([
        { kind: 'write', target: 'out' }
      ])
    }
  })

  it('L24 快照：`ls 2>&-`（关闭 fd）报成 write/null，方向安全', () => {
    // target 为 null，上层无法误当路径 —— 记录现状即可，不当缺陷修
    expect(analyzeShellCommand('ls 2>&-').redirects).toMatchObject([
      { kind: 'write', target: null }
    ])
  })

  it('L25 dynamics 去重且按首次出现排序', () => {
    expect(analyzeShellCommand('ls *.a > x; ls *.b > y').dynamics).toEqual(['glob', 'redirect'])
  })

  it('L26 大括号展开与重定向同时出现', () => {
    const facts = analyzeShellCommand('echo {a,b} > /etc/x')
    expect(facts.dynamics).toEqual(['brace-expansion', 'redirect'])
    expect(facts.redirects).toMatchObject([{ kind: 'write', target: '/etc/x' }])
  })

  it('L27 后台执行', () => {
    expect(analyzeShellCommand('ls &').dynamics).toEqual(['background'])
  })

  it('L28 快照：嵌套反引号只识别一层（已知边界）', () => {
    const facts = analyzeShellCommand('echo `echo \\`whoami\\``')
    // 内层 echo 拿到的是字面串 `whoami`，我们看不见它会被再执行一次；
    // 靠外层的 command-substitution 标记 fail-safe，不在这一层修
    expect(facts.literalCommands.map((c) => c.base)).not.toContain('whoami')
    expect(facts.literalCommands.some((c) => c.argv[1] === '`whoami`')).toBe(true)
    expect(facts.dynamics).toContain('command-substitution')
  })

  it('L29 快照：extglob 在未开 shopt 的语法下落到 syntax-error（与真 bash 一致）', () => {
    for (const src of ['ls @(a|b)', 'ls ?(a|b)']) {
      const facts = analyzeShellCommand(src)
      expect(facts.parsed, src).toBe(false)
      expect(facts.reason, src).toBe('syntax-error')
      expect(facts.dynamics, src).toContain('subshell')
      // 错误树里抽出的 a/b 是幽灵命令 —— parsed=false 时宽松轨的产物本就只配触发询问
      expect(
        facts.literalCommands.map((c) => c.base),
        src
      ).toEqual(expect.arrayContaining(['a', 'b']))
    }
    // 因此 ShellDynamicKind 的 'extglob' 在当前语法下不可达，保留类型即可
    expect(analyzeShellCommand('ls @(a|b)').dynamics).not.toContain('extglob')
  })
})
