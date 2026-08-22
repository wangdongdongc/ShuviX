/**
 * wrapper 解包与嵌套 shell 载荷提取 —— 纯数组进出，不需要解析器。
 *
 * 两个函数的方向不同，测试也按两种口味写：
 *   stripWrappers   服务「发现危险」，拿不准时倾向继续剥；严格轨绝不调用它。
 *   extractShellPayload 服务递归解析，返回 null（没有载荷）与 { payload: null }
 *     （有载荷位但取不到值）语义完全不同 —— 后者必须让上层 fail-safe，
 *     所以本文件一律用 toEqual 区分二者，不用 toBeFalsy 之类含糊断言。
 */
import { describe, it, expect } from 'vitest'
import {
  stripWrappers,
  extractShellPayload,
  SHELL_RUNNERS,
  MULTICALL_BINARIES,
  EVAL_LIKE,
  TRANSPARENT_WRAPPERS
} from '../index'

describe('stripWrappers — 透明前缀剥离', () => {
  it('W1 单层 wrapper', () => {
    expect(stripWrappers(['time', 'curl', 'x'])).toEqual({
      argv: ['curl', 'x'],
      wrappers: ['time'],
      uncertain: false
    })
  })

  it('W2 链式 + 带值选项 + 赋值前缀 + positional 一网打尽', () => {
    expect(
      stripWrappers(['sudo', '-u', 'root', 'env', 'FOO=1', 'timeout', '30', 'curl', 'x'])
    ).toEqual({
      argv: ['curl', 'x'],
      wrappers: ['sudo', 'env', 'timeout'],
      uncertain: false
    })
  })

  it('W3 非 wrapper 头：原样返回，不得有任何副作用', () => {
    expect(stripWrappers(['ls', '-la'])).toEqual({
      argv: ['ls', '-la'],
      wrappers: [],
      uncertain: false
    })
  })

  it('W4 opaqueWithOptions：带选项的 xargs / script 不再是透明前缀', () => {
    // `xargs -n1 grep` 里 grep 拿的是 stdin 喂来的参数，执行语义已经变了 ——
    // 剥成 grep 会让上层以为看懂了这条命令，这是刻意的不剥
    expect(stripWrappers(['xargs', '-n1', 'grep', 'x'])).toEqual({
      argv: ['xargs', '-n1', 'grep', 'x'],
      wrappers: [],
      uncertain: false
    })
    expect(stripWrappers(['script', '-q', '/dev/null', 'bash'])).toEqual({
      argv: ['script', '-q', '/dev/null', 'bash'],
      wrappers: [],
      uncertain: false
    })
    // 不带选项时才恢复透明
    expect(stripWrappers(['xargs', 'grep', 'x'])).toEqual({
      argv: ['grep', 'x'],
      wrappers: ['xargs'],
      uncertain: false
    })
  })

  it('W5 动态 token：uncertain 且不得给出任何结论', () => {
    expect(stripWrappers([null, 'x'])).toEqual({
      argv: [null, 'x'],
      wrappers: [],
      uncertain: true
    })
    // `sudo $X rm`：$X 可能是 -u 也可能是别的，把 rm 当结论就是猜
    expect(stripWrappers(['sudo', null, 'rm'])).toEqual({
      argv: ['sudo', null, 'rm'],
      wrappers: [],
      uncertain: true
    })
  })

  it('W6 剥完无剩余：保持原样', () => {
    expect(stripWrappers(['sudo'])).toEqual({ argv: ['sudo'], wrappers: [], uncertain: false })
    expect(stripWrappers(['env', 'FOO=1'])).toEqual({
      argv: ['env', 'FOO=1'],
      wrappers: [],
      uncertain: false
    })
  })

  it('W7 `--` 结束选项区', () => {
    expect(stripWrappers(['sudo', '--', 'rm', '-rf', '/'])).toEqual({
      argv: ['rm', '-rf', '/'],
      wrappers: ['sudo'],
      uncertain: false
    })
  })

  it('W8 触到迭代上限：uncertain=true 且 argv 停在第 8 层之后', () => {
    // 9 层透明前缀：command builtin ×4 + command，最后才是真正的 ls
    const layers = ['command', 'builtin', 'command', 'builtin']
    const result = stripWrappers([...layers, ...layers, 'command', 'ls'])
    expect(result.wrappers.length).toBe(8)
    // 上限的可观测语义：剥了 8 层就收手，剩下的没看完，故 uncertain
    expect(result.uncertain).toBe(true)
    expect(result.argv).toEqual(['command', 'ls'])
  })

  it('W9 basename 生效：带路径的 wrapper 照剥', () => {
    expect(stripWrappers(['/usr/bin/sudo', 'ls'])).toEqual({
      argv: ['ls'],
      wrappers: ['sudo'],
      uncertain: false
    })
  })

  it('W10 四种选项形态：无值短选项 / 带值短选项 / positional / 两者叠加', () => {
    expect(stripWrappers(['nice', '-5', 'curl']).argv).toEqual(['curl'])
    expect(stripWrappers(['exec', '-a', 'foo', 'curl']).argv).toEqual(['curl'])
    expect(stripWrappers(['flock', '/tmp/l', 'curl']).argv).toEqual(['curl'])
    expect(stripWrappers(['timeout', '-s', '9', '30', 'curl']).argv).toEqual(['curl'])
  })

  it('W11 multicall 二进制不是透明前缀，归 extractShellPayload 管', () => {
    expect(stripWrappers(['busybox', 'sh', '-c', 'id'])).toEqual({
      argv: ['busybox', 'sh', '-c', 'id'],
      wrappers: [],
      uncertain: false
    })
  })

  it('W12 快照：Windows 可执行后缀不在表里，timeout.exe 不剥（已知取舍）', () => {
    expect(stripWrappers(['C:\\Windows\\system32\\timeout.exe', '30', 'curl'])).toEqual({
      argv: ['C:\\Windows\\system32\\timeout.exe', '30', 'curl'],
      wrappers: [],
      uncertain: false
    })
  })
})

describe('extractShellPayload — 载荷提取（POSIX 选项区语义）', () => {
  it('X1 `sh -c` / 带路径的 runner', () => {
    expect(extractShellPayload(['sh', '-c', 'id'])).toEqual({ payload: 'id' })
    expect(extractShellPayload(['/bin/bash', '-c', 'id'])).toEqual({ payload: 'id' })
  })

  it('X2 短选项簇里含 c 即算内联脚本', () => {
    expect(extractShellPayload(['bash', '-lc', 'id'])).toEqual({ payload: 'id' })
    expect(extractShellPayload(['bash', '-cx', 'id'])).toEqual({ payload: 'id' })
    expect(extractShellPayload(['bash', '-x', '-c', 'id'])).toEqual({ payload: 'id' })
  })

  it('X3 脚本文件名不是内联脚本 → null', () => {
    expect(extractShellPayload(['bash', 'script.sh'])).toBeNull()
  })

  it('X4 有载荷位但没内容 → { payload: null }（与 X3 的 null 是两种语义）', () => {
    expect(extractShellPayload(['bash', '-c'])).toEqual({ payload: null })
    expect(extractShellPayload(['bash', '-c', '--'])).toEqual({ payload: null })
  })

  it('X5 动态 token 落在载荷位或选项位 → { payload: null }', () => {
    expect(extractShellPayload(['sh', '-c', null])).toEqual({ payload: null })
    expect(extractShellPayload(['sh', null, 'id'])).toEqual({ payload: null })
  })

  it('X6 eval 把余下参数以空格拼接（bash 的 eval 就是拼接后再解析）', () => {
    expect(extractShellPayload(['eval', 'curl', 'x'])).toEqual({ payload: 'curl x' })
    expect(extractShellPayload(['eval'])).toBeNull()
    expect(extractShellPayload(['eval', null])).toEqual({ payload: null })
  })

  it('X7 非 runner 的 `-c` 不得被当脚本', () => {
    expect(extractShellPayload(['ls', '-c', 'x'])).toBeNull()
  })

  it('X8 `--` 之后的第一个定位参数才是脚本文本', () => {
    // 与真 bash 一致：`/bin/sh -c -- "echo hi"` 确实执行 echo
    expect(extractShellPayload(['sh', '-c', '--', 'rm -rf /'])).toEqual({ payload: 'rm -rf /' })
  })

  it('X9 `--` 之后的 `-c` 不再是选项 → 无载荷', () => {
    // 真 bash 把它当脚本文件名，提取出 id 就等于凭空造了一条执行
    expect(extractShellPayload(['sh', '--', '-c', 'id'])).toBeNull()
  })

  it('X10 `-c` 后第一个定位参数是脚本，其余是 $0/$1', () => {
    expect(extractShellPayload(['sh', '-c', 'a', 'b'])).toEqual({ payload: 'a' })
  })

  it('X11 第一个定位参数结束选项区，后面的 `-c` 不再是选项', () => {
    expect(extractShellPayload(['sh', 'file.sh', '-c', 'x'])).toBeNull()
  })

  it('X12 multicall：跳过 applet 名前的自身选项后按 runner 规则续解', () => {
    expect(extractShellPayload(['busybox', 'sh', '-c', 'id'])).toEqual({ payload: 'id' })
    expect(extractShellPayload(['busybox', '-x', 'sh', '-c', 'id'])).toEqual({ payload: 'id' })
    expect(extractShellPayload(['toybox', 'sh', '-c', 'id'])).toEqual({ payload: 'id' })
  })

  it('X13 applet 不是 shell 就没有载荷', () => {
    expect(extractShellPayload(['busybox', 'ls'])).toBeNull()
    expect(extractShellPayload(['busybox'])).toBeNull()
  })

  it('X14 applet 名不可静态知 → 有载荷但不确定', () => {
    expect(extractShellPayload(['busybox', null, 'sh'])).toEqual({ payload: null })
  })

  it('X15 source / . 的参数是文件路径不是脚本文本 → 不得递归', () => {
    // 递归会造出一条名为 foo.sh 的不存在命令；「看不见」好过「看错」
    expect(extractShellPayload(['source', 'foo.sh'])).toBeNull()
    expect(extractShellPayload(['.', 'x.sh'])).toBeNull()
  })

  it('X16 头部动态 → null', () => {
    expect(extractShellPayload([null, '-c', 'id'])).toBeNull()
  })

  it('X17 带值选项跳过取值；长选项不参与 c 判定', () => {
    expect(extractShellPayload(['bash', '-o', 'pipefail', '-c', 'id'])).toEqual({ payload: 'id' })
    // `--color` 里也有 c，误认成 -c 会把后面的定位参数当脚本执行
    expect(extractShellPayload(['bash', '--color', '-c', 'id'])).toEqual({ payload: 'id' })
  })

  it('X18 导出常量的四条安全性质（不是表数据）', () => {
    // busybox 已从 runner 移出：它的第一个定位参数是 applet 名而不是脚本
    expect(SHELL_RUNNERS.has('busybox')).toBe(false)
    expect([...MULTICALL_BINARIES].sort()).toEqual(['busybox', 'toybox'])
    // source / . 混进 EVAL_LIKE 会让文件路径被当脚本文本解析（见 X15）
    expect([...EVAL_LIKE]).toEqual(['eval'])
    // shell runner 绝不能进透明前缀表：那样 `bash -c 'rm -rf /'` 会被剥成 `-c 'rm -rf /'`
    expect(TRANSPARENT_WRAPPERS.has('sh')).toBe(false)
    expect(TRANSPARENT_WRAPPERS.has('bash')).toBe(false)
  })
})
