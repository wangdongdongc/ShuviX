/**
 * 词的静态求值 —— GuardFall 两类词法绕过的还原点：
 *   引号剥离 `r''m` / ANSI-C 转义 `$'\x72\x6d'`，源串里都没有 `rm` 字样，
 *   照抄 node.text 就漏，必须逐节点还原。
 *
 * ⚠️ Node 生命周期：evaluateWord 吃的是 tree-sitter 的 Node，而 withTree 在回调返回后
 * 立刻 tree.delete()。所以本文件的 evalWord 助手**在回调内完成求值**再返回纯对象；
 * 把 Node 带出回调读到的是已释放的 wasm 内存（表现为随机值或崩溃，不是异常）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type { Node } from 'web-tree-sitter'
import { initShellParser, evaluateWord, decodeAnsiC, type WordValue } from '../index'
import { withTree } from '../parser'
import { loadShellParserWasmFromNodeModules } from '../nodeWasm'

beforeAll(async () => {
  await initShellParser(loadShellParserWasmFromNodeModules())
})

/** 先序找第一个满足条件的节点（含匿名节点） */
function findFirst(root: Node, match: (n: Node) => boolean): Node | null {
  if (match(root)) return root
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)
    if (!child) continue
    const found = findFirst(child, match)
    if (found) return found
  }
  return null
}

/** 解析 src，在回调内选出节点并求值 —— Node 绝不逃出回调 */
function evalWord(src: string, pick: (root: Node) => Node | null): WordValue {
  const value = withTree(src, (root) => {
    const node = pick(root)
    if (!node) throw new Error(`未找到目标节点: ${src}`)
    return evaluateWord(node)
  })
  if (!value) throw new Error(`解析失败: ${src}`)
  return value
}

/** 第一个 command 的第 index 个命名子节点（0 = command_name，1 = 首个实参） */
const nth =
  (index: number) =>
  (root: Node): Node | null => {
    const cmd = findFirst(root, (n) => n.type === 'command')
    return cmd ? cmd.namedChild(index) : null
  }

/** 首个实参的求值 */
const evalArg = (src: string): WordValue => evalWord(src, nth(1))
/** command_name 的求值 */
const evalName = (src: string): WordValue => evalWord(src, nth(0))

describe("decodeAnsiC — $'...' 的 C 风格转义", () => {
  it('D1 十六进制：GuardFall 的核心还原', () => {
    expect(decodeAnsiC('\\x72\\x6d')).toBe('rm')
  })

  it('D2 八进制 / \\u / \\U', () => {
    expect(decodeAnsiC('\\101\\102')).toBe('AB')
    expect(decodeAnsiC('\\u0041')).toBe('A')
    expect(decodeAnsiC('\\U0001F600')).toBe('😀')
  })

  it('D3 命名转义与字面转义', () => {
    expect(decodeAnsiC('\\n\\t\\e\\a\\b\\f\\v')).toBe('\n\t\x1b\x07\b\f\v')
    expect(decodeAnsiC('\\\\')).toBe('\\')
    expect(decodeAnsiC("\\'")).toBe("'")
    expect(decodeAnsiC('\\"')).toBe('"')
    expect(decodeAnsiC('\\?')).toBe('?')
  })

  it('D4 control 转义 \\cA', () => {
    expect(decodeAnsiC('\\cA')).toBe('\x01')
  })

  it('D5 未识别转义保留反斜杠 + 原字符', () => {
    // 这一层宁可给出「某个确定串」也不给 null：宽松轨丢字符串等于漏检
    expect(decodeAnsiC('\\q')).toBe('\\q')
  })

  it('D6 结尾孤立反斜杠不越界', () => {
    expect(decodeAnsiC('ab\\')).toBe('ab\\')
  })

  it('D7 十六进制最多吃 2 位、八进制最多 3 位', () => {
    expect(decodeAnsiC('\\x7z')).toBe('\x07z')
    expect(decodeAnsiC('\\1234')).toBe(String.fromCharCode(0o123) + '4')
  })
})

describe('evaluateWord — 词求值三态', () => {
  it('E1 裸词', () => {
    expect(evalArg('ls abc')).toEqual({ value: 'abc', glob: false, brace: false })
  })

  it('E2 四类运行时展开一律不可静态确定', () => {
    for (const src of ['ls $X', 'ls $(pwd)', 'ls $((1+1))', 'ls <(x)']) {
      expect(evalArg(src).value).toBeNull()
    }
  })

  it('E3 GuardFall A：引号剥离 / 转义还原后 command_name 是 rm', () => {
    // 三种写法的源串里都没有连续的 `rm` 字样，只有还原后才看得见
    expect(evalName("r''m -rf /").value).toBe('rm')
    expect(evalName('"r"m -rf /').value).toBe('rm')
    expect(evalName('r\\m -rf /').value).toBe('rm')
  })

  it('E4 ANSI-C 串还原成 rm', () => {
    expect(evalName("$'\\x72\\x6d' -rf /")).toEqual({ value: 'rm', glob: false, brace: false })
  })

  it('E5 整词含动态片段即不可知，不得给出部分串', () => {
    // 给出 'ab' 会让上层以为看懂了这个词，比给 null 更危险
    expect(evalArg('echo "a$(whoami)b"').value).toBeNull()
  })

  it('E6 裸露元字符才算 glob，引号内的不算', () => {
    expect(evalArg('ls *.ts')).toMatchObject({ value: '*.ts', glob: true })
    expect(evalArg("ls 'a?b'")).toEqual({ value: 'a?b', glob: false, brace: false })
    expect(evalArg('ls "[abc]"')).toEqual({ value: '[abc]', glob: false, brace: false })
    expect(evalArg('ls [abc]')).toMatchObject({ value: '[abc]', glob: true })
  })

  it('E7 被转义的 * 不参与路径展开', () => {
    // 元字符判定走 maskEscapes 在**去转义之前**做：去转义后的 'a*b' 已经和真 glob 无法区分
    expect(evalArg('echo a\\*b')).toMatchObject({ value: 'a*b', glob: false })
  })

  it('E8 双引号内只对 $ ` " \\ 换行 认转义', () => {
    expect(evalArg('echo "a\\$b"').value).toBe('a$b')
    expect(evalArg('echo "a\\qb"').value).toBe('a\\qb')
  })

  it('E9 未加引号的反斜杠一律取字面下一字符', () => {
    expect(evalArg('echo a\\ b').value).toBe('a b')
  })

  it('E10 大括号展开：单片看不出逗号，靠整段拼起来的形状再判一次', () => {
    // tree-sitter 把 {a,b} 切成 concatenation 里的多个 word，
    // 光看任何一片都不含逗号型大括号 —— 只有拼回去才看得出第二个展开目标
    expect(evalArg('echo {a,b}')).toMatchObject({ value: '{a,b}', brace: true })
    expect(evalArg('echo a{b,c}d')).toMatchObject({ value: 'a{b,c}d', brace: true })
  })

  it('E11 无逗号 / 引号内 / 被转义的花括号都不是展开（防 E10 掩码过度触发）', () => {
    expect(evalArg('echo {a}').brace).toBe(false)
    expect(evalArg('echo "a{b,c}"').brace).toBe(false)
    expect(evalArg('echo a\\{b,c\\}').brace).toBe(false)
  })

  it('E12 {1..3} 走 DYNAMIC_KINDS 那条路径，与 E10 的 word 形状不同', () => {
    expect(evalArg('echo {1..3}').value).toBeNull()
  })

  it('E13 未知节点种类保守判不可知', () => {
    const value = evalWord('ls > x', (root) => findFirst(root, (n) => n.type === 'file_redirect'))
    expect(value).toEqual({ value: null, glob: false, brace: false })
  })
})
