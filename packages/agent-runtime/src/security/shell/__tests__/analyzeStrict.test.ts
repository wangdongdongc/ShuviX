/**
 * 严格轨红线 —— `wordOnly` / `wordOnlyCommands` 是**唯一可用于放行**的字段。
 *
 * 它回答的只有一个问题：这条命令能不能被证明「只是若干字面词命令 + `&&` `||` `;` `|` 的组合」。
 * 名单外的任何命名节点或算子一律判否，宁可多问一次也不放行一条看错的命令。
 * 反过来，它**不**回答「这些名字是否危险」——那是上层策略的活，见 S7。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { analyzeShellCommand, initShellParser, stripWrappers } from '../index'
import { loadShellParserWasmFromNodeModules } from '../nodeWasm'

beforeAll(async () => {
  await initShellParser(loadShellParserWasmFromNodeModules())
})

describe('严格轨 — 可证明的字面子集', () => {
  it('S1 `&&` 串联的字面命令', () => {
    const facts = analyzeShellCommand('git status && npm test')
    expect(facts.parsed).toBe(true)
    expect(facts.wordOnly).toBe(true)
    expect(facts.wordOnlyCommands).toEqual([
      ['git', 'status'],
      ['npm', 'test']
    ])
  })

  it('S2 四种安全算子与换行分隔，命令按源码顺序排列', () => {
    expect(analyzeShellCommand('echo hi | grep x ; ls').wordOnlyCommands).toEqual([
      ['echo', 'hi'],
      ['grep', 'x'],
      ['ls']
    ])
    expect(analyzeShellCommand('a || b').wordOnlyCommands).toEqual([['a'], ['b']])
    expect(analyzeShellCommand('ls\n\nrm x').wordOnlyCommands).toEqual([['ls'], ['rm', 'x']])
  })

  it('S3 一切非字面构造都踢出严格轨', () => {
    const cases: string[] = [
      // 重定向族
      'echo hi > /etc/passwd',
      'echo a >> log',
      'cat < in.txt',
      'cat <<EOF\nhi\nEOF',
      'cat <<< hello',
      'ls 2>&1',
      // 子 shell / 替换 / 展开
      '(cd /tmp && rm x)',
      'ls $(pwd)',
      'ls `pwd`',
      'diff <(ls) <(ls)',
      'echo ${HOME}',
      'echo $((1+1))',
      'ls *.ts',
      'echo {a,b}',
      'echo {1..3}',
      'ls &',
      // 赋值
      'X=1 curl y',
      'a=1',
      'export A=1',
      // 控制流
      'if true; then rm -rf /; fi',
      'for f in *; do rm $f; done',
      'while true; do :; done',
      'case x in y) rm z;; esac',
      'f() { rm x; }',
      '! rm x',
      '[ -f x ] && rm x',
      // ANSI-C 串：能解码但刻意不放行，见下方注释
      "$'\\x72\\x6d' -rf /"
    ]
    for (const src of cases) {
      const facts = analyzeShellCommand(src)
      expect(facts.wordOnly, src).toBe(false)
      expect(facts.wordOnlyCommands, src).toHaveLength(0)
    }
  })

  it("S3 补注：$'...' 能解码却仍不放行（GuardFall 载体）", () => {
    // 词层能把 $'\x72\x6d' 还原成 rm（见 words.test.ts E4），严格轨照样判否 ——
    // 多问一次的成本，远低于放行一条解码错的命令
    expect(analyzeShellCommand("$'\\x72\\x6d' -rf /").wordOnly).toBe(false)
    // {a,b} 同理：`cp x {a,/etc/passwd}` 的字面 argv 完全看不出第二个目标，与 glob 同等对待
    expect(analyzeShellCommand('cp x {a,/etc/passwd}').wordOnly).toBe(false)
  })

  it('S4 引号内 / 被转义的元字符与无逗号花括号仍在可证明子集内（防过度保守）', () => {
    const cases: string[] = [
      'ls "*.ts"',
      'echo a\\*b',
      'echo {a}',
      'echo "a{b,c}"',
      'echo a\\{b,c\\}',
      'grep -r x .',
      "r''m -rf /",
      'r\\m -rf /',
      "echo 'don'\\''t'",
      'ls -- -delete'
    ]
    for (const src of cases) {
      expect(analyzeShellCommand(src).wordOnly, src).toBe(true)
    }
  })

  it('S5 空命令不得因「没有违规节点」被判 true', () => {
    for (const src of ['', '   ']) {
      const facts = analyzeShellCommand(src)
      expect(facts.parsed, src).toBe(true)
      // 没有任何命令 → 没有可证明的东西，wordOnly 必须为假（collectWordOnly 的 length===0 分支）
      expect(facts.wordOnly, src).toBe(false)
      expect(facts.wordOnlyCommands, src).toEqual([])
      expect(facts.literalCommands, src).toEqual([])
    }
  })

  it('S6 语法错时严格轨恒否', () => {
    for (const src of ['echo "unterminated', 'ls |', 'ls;;;']) {
      const facts = analyzeShellCommand(src)
      expect(facts.wordOnly, src).toBe(false)
      expect(facts.wordOnlyCommands, src).toEqual([])
    }
  })

  it('S7 可证明字面 ≠ 语义安全：严格轨只承诺「无动态语法」', () => {
    // 这五条全都是 wordOnly=true，判「这些名字危不危险」是上层策略的活，不是本模块的
    const cases: string[] = [
      'bash -c "rm -rf /"',
      'busybox sh -c "rm -rf /"',
      'cat p | base64 -d | sh',
      'sudo rm -rf /',
      'find . -name x -delete'
    ]
    for (const src of cases) {
      expect(analyzeShellCommand(src).wordOnly, src).toBe(true)
    }
    // 宽松轨确实看见了载荷里的 rm —— 严格轨放行、宽松轨报警，两轨各司其职
    for (const src of ['bash -c "rm -rf /"', 'busybox sh -c "rm -rf /"']) {
      const nested = analyzeShellCommand(src).literalCommands.filter((c) => c.depth === 1)
      expect(
        nested.map((c) => c.base),
        src
      ).toContain('rm')
    }
  })

  it('S8 快照：`time cmd` 被 tree-sitter 拍平，由 wrapper 层弥补', () => {
    // 严格轨拿到的是一条命令而不是两条 —— 这是 tree-sitter 的已知压平点
    expect(analyzeShellCommand('time curl x').wordOnlyCommands).toEqual([['time', 'curl', 'x']])
    // 需要知道真正执行的是谁时，由上层调 stripWrappers 补上
    expect(stripWrappers(['time', 'curl', 'x']).argv).toEqual(['curl', 'x'])
  })

  it('S9 `&&` 是独立 token，不得被当成后台执行的 `&`', () => {
    expect(analyzeShellCommand('a && b').dynamics).not.toContain('background')
  })

  it('S10 严格轨绝不调用 stripWrappers，argv 原样保留', () => {
    // 过度解包对「找危险」是安全方向，对「证明安全」是致命方向：
    // 剥掉 sudo 后放行，等于把提权执行当成了普通执行
    expect(analyzeShellCommand('sudo rm -rf /').wordOnlyCommands).toEqual([
      ['sudo', 'rm', '-rf', '/']
    ])
    expect(analyzeShellCommand('xargs -n1 grep').wordOnlyCommands).toEqual([
      ['xargs', '-n1', 'grep']
    ])
  })
})
