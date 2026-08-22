/**
 * 与真实 /bin/bash 的方向性差分 —— 测的是「我们的理解 vs bash 的真实行为」。
 *
 * 靶场是一批只往日志里写自己名字的假可执行（PATH 收窄到靶场 + /bin），
 * 所以 `rm x` 之类不会真的删任何东西。
 *
 * 唯一不变式（版本无关，故不易 flaky）：
 *   facts.parsed && facts.wordOnly ⟹ 真实执行集 E ⊆
 *     literalCommands 的 base 集合  ∪  每条 wordOnlyCommand 经 stripWrappers 后的头。
 * 读法：**凡是我们敢证明安全的命令，其真实执行的每个程序都必须已经被我们看见** ——
 * 要么直接是一条字面命令的 argv[0]，要么在剥掉透明前缀之后成为某条命令的头。
 *
 * 并集的两支不是为了让测试好过，而是同时钉住**两层**：
 *   左支退化 = 解析层漏报了字面命令；右支退化 = wrapper 层停止解包。任一层坏掉它都会红。
 * 它顺带把一条对上层的要求编码了进来：策略层按 argv[0] 匹配之前**必须先过 stripWrappers**，
 * 否则 `time rm x` 会以 `time` 的身份去查表，而真正跑起来的是 rm（见 analyzeStrict S8 / S10）。
 *
 * 刻意不做：
 *   - 随机 fuzz；`bash -n` 语法合法性对拍（extglob / shopt 在 bash 3.2 与 5.x 上会分叉）。
 *   - sudo：靶场 PATH 里没有 sudo，语料放进来只会是一条 E 恒为空、永远不可能红的假覆盖；
 *     而造一个 `exec "$@"` 的假 sudo 又会把「严格轨不解包 wrapper」这条已知边界变成假阳性 ——
 *     那条边界已由 S8 / S10 记录，不必在这里重复一遍。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeShellCommand, initShellParser, stripWrappers } from '../index'
import { loadShellParserWasmFromNodeModules } from '../nodeWasm'

const HAS_BASH = process.platform !== 'win32' && existsSync('/bin/bash')

let fakeDir = ''
let logPath = ''

/** 收集一条命令在真 bash 下的实际执行集 */
function realExecutions(src: string): Set<string> {
  writeFileSync(logPath, '')
  try {
    execFileSync('/bin/bash', ['-c', src], {
      cwd: fakeDir,
      env: { PATH: `${fakeDir}:/bin`, SHUVIX_LOG: logPath },
      stdio: 'ignore'
    })
  } catch {
    // 假可执行退出码不重要，命令未找到（127）也是有效观察结果
  }
  return new Set(
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
  )
}

function basename(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}

/** 我们「已经看见」的程序名集合 —— 不变式右侧的并集 */
function seenPrograms(src: string): Set<string> {
  const facts = analyzeShellCommand(src)
  const seen = new Set(facts.literalCommands.map((c) => c.base))
  for (const argv of facts.wordOnlyCommands) {
    const head = stripWrappers(argv).argv[0]
    if (typeof head === 'string') seen.add(basename(head))
  }
  return seen
}

/** 不变式是否成立 */
function invariantHolds(src: string): boolean {
  const facts = analyzeShellCommand(src)
  if (!facts.parsed || !facts.wordOnly) return true // 不承诺安全 → 不受不变式约束
  const seen = seenPrograms(src)
  return [...realExecutions(src)].every((name) => seen.has(name))
}

describe.skipIf(!HAS_BASH)('与真实 bash 的差分', () => {
  beforeAll(async () => {
    await initShellParser(loadShellParserWasmFromNodeModules())
    fakeDir = mkdtempSync(join(tmpdir(), 'shuvix-bash-oracle-'))
    logPath = join(fakeDir, 'exec.log')
    for (const name of ['rm', 'curl', 'id', 'cp']) {
      const file = join(fakeDir, name)
      // 用 ${0##*/} 而不是 basename：PATH 被收窄到靶场 + /bin，basename 在 /usr/bin 里取不到
      writeFileSync(file, '#!/bin/sh\nprintf \'%s\\n\' "${0##*/}" >> "$SHUVIX_LOG"\n')
      chmodSync(file, 0o755)
    }
    writeFileSync(logPath, '')
  })

  afterAll(() => {
    if (fakeDir) rmSync(fakeDir, { recursive: true, force: true })
  })

  it('B0 靶场自检：假可执行确实被记录，真 rm 不会被调用', () => {
    // 靶场一旦坏掉（如脚本依赖 PATH 外的工具），E 会恒为空集，
    // 不变式随之恒真 —— 整个 oracle 看着全绿却什么都没测。这条专门堵这个失效模式
    expect(realExecutions('rm x')).toEqual(new Set(['rm']))
  })

  it('B1 不变式：敢证明安全的命令，其真实执行的每个程序都必须已被看见', () => {
    const corpus = [
      'rm x',
      "r''m x", // 引号剥离
      "$'\\x72\\x6d' x", // ANSI-C（wordOnly=false，不受约束）
      'rm$IFS-x', // 展开拼词（wordOnly=false）
      'time rm x', // 压平点：靠不变式右支（stripWrappers 后的头）接住
      "bash -c 'rm x'", // 嵌套 shell 递归
      "sh -c -- 'rm x'", // `--` 之后的载荷
      "eval 'rm x'", // eval 拼接
      'x=rm; $x y', // 变量当命令名（wordOnly=false）
      '`rm x`', // 命令替换（wordOnly=false）
      'cp a {b,c}' // 大括号展开（wordOnly=false）
    ]
    for (const src of corpus) {
      expect(invariantHolds(src), src).toBe(true)
    }
  })

  it('B2 两支各自可辨：time 走 wrapper 支，rm 走解析层支', () => {
    // 把并集拆开看一眼，免得哪天两支之一悄悄失效却被另一支掩盖
    expect(analyzeShellCommand('time rm x').literalCommands.map((c) => c.base)).toEqual(['time'])
    expect(stripWrappers(['time', 'rm', 'x']).argv[0]).toBe('rm')
    expect(seenPrograms('time rm x')).toEqual(new Set(['time', 'rm']))
    expect(seenPrograms('rm x')).toEqual(new Set(['rm']))
  })
})
