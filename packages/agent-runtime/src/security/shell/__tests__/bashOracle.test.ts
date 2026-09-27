/**
 * 与真实 /bin/bash 的方向性差分 —— 测的是「我们的理解 vs bash 的真实行为」。
 *
 * 靶场是一批只往日志里写自己名字的假可执行（PATH 收窄到靶场 + /bin），
 * 所以 `rm x` 之类不会真的删任何东西。
 *
 * 唯一不变式（版本无关，故不易 flaky）：
 *   facts.parsed && literalCommands 里没有动态占位（每条 complete，argv 无 null）⟹
 *     真实执行集 E ⊆ 每条 literalCommand 的 base  ∪  它经 stripWrappers 后的头。
 * 读法：**凡是解析层自认每个词都看清了的命令，其真实执行的每个程序都必须已经被它看见** ——
 * 要么直接是一条字面命令的 argv[0]，要么在剥掉透明前缀之后成为某条命令的头。
 * 后者正是拦截规则读到的东西（commandFacts 投影出的 `base` 就是解包后的头），
 * 所以这里是 deny 规则所依赖的解析唯一的差分护栏：它红了，意味着某个会真跑的程序
 * 在规则眼里不存在。
 *
 * 前提为什么是「无动态占位」：argv 里的 null 是解析层自己承认「这个词运行时才知道」
 * （`$x y`、`rm$IFS-x`、`` `rm x` `` 的外层），它没声称看见，就不算漏看 ——
 * 那种命令本来就只能交给下一道门（询问或沙箱）。自认看清却漏掉的，才是要抓的缺陷。
 *
 * 并集的两支同时钉住**两层**：
 *   左支退化 = 解析层漏报了字面命令；右支退化 = wrapper 层停止解包。任一层坏掉它都会红。
 * 它顺带把一条对上层的要求编码了进来：策略层按程序名匹配之前**必须先过 stripWrappers**，
 * 否则 `time rm x` 会以 `time` 的身份去查表，而真正跑起来的是 rm（见 analyzeLax L31）。
 *
 * 刻意不做：
 *   - 随机 fuzz；`bash -n` 语法合法性对拍（extglob / shopt 在 bash 3.2 与 5.x 上会分叉）。
 *   - sudo：靶场 PATH 里没有 sudo，语料放进来只会是一条 E 恒为空、永远不可能红的假覆盖。
 *
 * 前提没有排除的已知盲区由 B3 钉成快照（不在 B1 语料里 —— 放进去 B1 就该红）。
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

/** 解析层是否自认看清了每个词 —— 不变式的前提 */
function claimsFullSight(src: string): boolean {
  const facts = analyzeShellCommand(src)
  return facts.parsed && facts.literalCommands.every((c) => c.complete)
}

/** 我们「已经看见」的程序名集合 —— 不变式右侧的并集 */
function seenPrograms(src: string): Set<string> {
  const seen = new Set<string>()
  for (const c of analyzeShellCommand(src).literalCommands) {
    seen.add(c.base)
    const head = stripWrappers(c.argv).argv[0]
    if (typeof head === 'string') seen.add(basename(head))
  }
  return seen
}

/** 不变式是否成立 */
function invariantHolds(src: string): boolean {
  if (!claimsFullSight(src)) return true // 没声称看见 → 不受不变式约束
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

  it('B1 不变式：自认看清的命令，其真实执行的每个程序都必须已被看见', () => {
    // 第二列是该条是否受不变式约束 —— 一并断言，免得前提悄悄收窄后不变式对整批语料空转
    const corpus: [string, boolean][] = [
      ['rm x', true],
      ["r''m x", true], // 引号剥离
      ["$'\\x72\\x6d' x", true], // ANSI-C：词层解码成 rm
      ['rm$IFS-x', false], // 展开拼词：命令名是动态占位
      ['time rm x', true], // 压平点：靠右支（stripWrappers 后的头）接住
      ["bash -c 'rm x'", true], // 嵌套 shell 递归
      ["sh -c -- 'rm x'", true], // `--` 之后的载荷
      ["eval 'rm x'", true], // eval 拼接
      ['x=rm; $x y', false], // 变量当命令名：动态占位
      ['`rm x`', false], // 命令替换：外层命令名是动态占位（内层 rm 照样被看见）
      ['cp a {b,c}', true] // 大括号展开：文本确定，只在 dynamics 里标 brace-expansion
    ]
    for (const [src, constrained] of corpus) {
      expect(claimsFullSight(src), src).toBe(constrained)
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

  it('B3 快照：前提没排除、不变式确实会红的两个已知盲区', () => {
    // 两条都「自认看清」，却有程序没被看见；解析层只在 dynamics 里留了标记，
    // 规则不命中，交给下一道门。钉住现状：哪天补上了，这里会红，提醒把它们挪进 B1。
    //
    // 命令位置上的 glob：`*` 展开成靶场目录的全部文件名，第一个（cp）被当成程序执行
    expect(claimsFullSight('* x')).toBe(true)
    expect(analyzeShellCommand('* x').dynamics).toContain('glob')
    expect(invariantHolds('* x')).toBe(false)
    // 载荷后半段语法错：bash 逐条读 -c 脚本，第一行的 rm 照跑；而解析层把整个载荷丢弃
    // （analyzeLax L17，只标 nested-shell）—— 顶层脚本同样的形状由 commandFacts 按 span 取舍接住，
    // 嵌套载荷没有
    const partial = "bash -c $'rm x\\nif'"
    expect(claimsFullSight(partial)).toBe(true)
    expect(analyzeShellCommand(partial).dynamics).toContain('nested-shell')
    expect(invariantHolds(partial)).toBe(false)
  })
})
