/**
 * `~/.ssh/config` 的**别名枚举** —— `listSshHosts` 的全部语义。
 *
 * 分工是刻意的：这里只回答「这份配置里有哪些可以直接连的别名」，不做 OpenSSH 的求值。
 * 于是每条用例都落在同一条线上的某一侧 —— **枚举得到的是不是一份「能交给 ssh 的名字清单」**：
 *
 *   42…48  一个块里写着什么就是什么（`Host *` 的缺省**不合并**：它是求值的产物，不是这台机器的事实）；
 *   49…54  词法：关键字大小写、`=` 分隔、注释、引号 —— 其中行尾注释处**刻意不忠实于 OpenSSH**
 *          （它真的会把 `# my box` 当成三个别名），因为这份清单是给模型挑机器用的；
 *   55…57  `Match` 块不属于任何别名，且枚举**绝不起进程**（`ssh -G` 会真的执行 `Match exec`
 *          里的 shell 命令 —— 「列一下有哪些主机」不该有副作用）；
 *   58…75  `Include`：按 ~/.ssh 解析相对路径、通配、符号链接、坏目标、环、深度上限，
 *          以及「被包含文件不夺走父文件的当前块」；
 *   76…79  先到先得按**键**算，端口的取值范围；
 *   80…84  边界：配置不存在 / 读不动 / 没有任何 Host / CRLF / 顺序；
 *   85…89  `-` 开头的记号一律不是别名 —— 别名原样进 `ssh` 的 argv，而 `Host -oProxyCommand=…`
 *          是一份配置可以合法写出的东西，放它出去等于本地任意命令执行。
 *
 * fs 是真的 —— 通配、符号链接、EISDIR 这些换成假 fs 一条也测不到；`readFileSync` 只套了一层
 * 可数的透传壳（同 instruction/__tests__/instructionInjector.test.ts 的手法），因为「环里每个
 * 文件只读一次」这种断言在返回值上看不出来。`homedir` 换成本用例的临时家目录，这样 `~/` 开头的
 * Include 也能真跑一遍。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

// mock 路径按**测试文件**解析：被测模块在 services/builtinMcp/，测试在其 __tests__/ 下，
// 故比被测模块的 '../../logger' 多一层
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, default: actual, homedir: () => home.dir || actual.homedir() }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, default: actual, readFileSync: vi.fn(actual.readFileSync) }
})

/**
 * 起进程 = 当场记一笔并抛。
 *
 * 今天 sshConfig 根本不 import child_process，所以这两个假件是**回归闸门**：
 * 哪天有人为了「解析得更准」改成 `ssh -G`，`Match exec` 里的 shell 命令就会真的被执行，
 * 而那一改在返回值上看起来只是「解析变好了」。
 */
const cp = vi.hoisted(() => {
  const calls: string[] = []
  const rec =
    (name: string) =>
    (...args: unknown[]): never => {
      calls.push(`${name}(${String(args[0])})`)
      throw new Error(`ssh 别名枚举不该起进程：${name}`)
    }
  const api = {
    spawn: rec('spawn'),
    spawnSync: rec('spawnSync'),
    exec: rec('exec'),
    execSync: rec('execSync'),
    execFile: rec('execFile'),
    execFileSync: rec('execFileSync'),
    fork: rec('fork')
  }
  return { calls, factory: (): Record<string, unknown> => ({ ...api, default: api }) }
})
vi.mock('child_process', cp.factory)
vi.mock('node:child_process', cp.factory)

import { listSshHosts, type SshHostEntry } from '../sshConfig'

// ─── 素材 ────────────────────────────────────────────────────────────────

const roots: string[] = []
let sshDir = ''
let configPath = ''

beforeEach(() => {
  // 每个用例一份独立的「家目录」：~/ 开头的 Include 与相对路径的落点都由它决定
  const root = mkdtempSync(join(tmpdir(), 'shuvix-sshcfg-'))
  roots.push(root)
  home.dir = root
  sshDir = join(root, '.ssh')
  mkdirSync(sshDir, { recursive: true })
  configPath = join(sshDir, 'config')
  vi.mocked(readFileSync).mockClear()
  cp.calls.length = 0
})

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** 往 ~/.ssh 下写一份文件（相对路径，自动建父目录），返回绝对路径 */
function put(rel: string, text: string): string {
  const p = join(sshDir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  return p
}

/** 写主配置并枚举 */
function hosts(text: string): SshHostEntry[] {
  writeFileSync(configPath, text)
  return listSshHosts(configPath)
}

const aliases = (text: string): string[] => hosts(text).map((h) => h.alias)

/** 某个绝对路径被读了几次（环 / 重复 Include 用） */
const readsOf = (path: string): number =>
  vi.mocked(readFileSync).mock.calls.filter((c) => c[0] === path).length

// ─── 一个块里写着什么就是什么 ────────────────────────────────────────────

describe('listSshHosts 块与别名', () => {
  it('SSHC-U-42: 单个 Host 块的三个字段原样带出', () => {
    expect(
      hosts(`Host web
  HostName 1.2.3.4
  User bob
  Port 2222
`)
    ).toEqual([{ alias: 'web', hostname: '1.2.3.4', user: 'bob', port: 2222 }])
  })

  it('SSHC-U-43: 一个块里的多个别名共享同一份值', () => {
    expect(
      hosts(`Host web api
  HostName 1.2.3.4
  User bob
`)
    ).toEqual([
      { alias: 'web', hostname: '1.2.3.4', user: 'bob' },
      { alias: 'api', hostname: '1.2.3.4', user: 'bob' }
    ])
  })

  it('SSHC-U-44: `Host *` 不是可连的别名', () => {
    expect(
      aliases(`Host *
  User root
Host web
  HostName a
`)
    ).toEqual(['web'])
  })

  it('SSHC-U-45: 通配别名剔除，同块里的具体别名保留', () => {
    expect(
      aliases(`Host bastion *.internal 10.0.?.*
  HostName a
`)
    ).toEqual(['bastion'])
  })

  it('SSHC-U-46: 否定项剔除，同块里的兄弟保留', () => {
    expect(
      aliases(`Host !bad good
  HostName a
`)
    ).toEqual(['good'])
  })

  it('SSHC-U-47: 整行都是模式 → 这个块一个别名也不产出', () => {
    expect(
      aliases(`Host * !nope
  User root
`)
    ).toEqual([])
  })

  it('SSHC-U-48: `Host *` 的缺省**不合并**进具体别名', () => {
    // 合并就等于在 JS 里重写一份 OpenSSH 的求值 —— 用户以为在看自己的配置，
    // 实际看到的是我们的仿制品。这里只报「这个块里写了什么」
    expect(
      hosts(`Host *
  User root
  Port 22
Host web
  HostName 1.2.3.4
`)
    ).toEqual([{ alias: 'web', hostname: '1.2.3.4' }])
  })
})

// ─── 词法 ────────────────────────────────────────────────────────────────

describe('listSshHosts 词法', () => {
  it('SSHC-U-49: 关键字大小写不敏感', () => {
    expect(
      hosts(`HOST web
  hostname 1.2.3.4
  USER bob
  PoRt 2222
`)
    ).toEqual([{ alias: 'web', hostname: '1.2.3.4', user: 'bob', port: 2222 }])
  })

  it('SSHC-U-50: `=` 也是合法分隔符', () => {
    expect(
      hosts(`Host=web
  HostName=1.2.3.4
  User = bob
`)
    ).toEqual([{ alias: 'web', hostname: '1.2.3.4', user: 'bob' }])
  })

  it('SSHC-U-51: 注释行与空行跳过（含缩进后的注释）', () => {
    expect(
      hosts(`# 我的配置

Host web
   # 这台是网站
  HostName 1.2.3.4

`)
    ).toEqual([{ alias: 'web', hostname: '1.2.3.4' }])
  })

  it('SSHC-U-52: 带引号的值去引号（引号里的空格是值的一部分）', () => {
    expect(
      hosts(`Host "web"
  HostName "1.2.3.4"
  User 'bo b'
`)
    ).toEqual([{ alias: 'web', hostname: '1.2.3.4', user: 'bo b' }])
  })

  it('SSHC-U-53: Host 行的行尾注释不是别名（刻意不忠实于 OpenSSH）', () => {
    // OpenSSH 只认行首注释：这一行在它眼里定义了 `#` / `my` / `web` / `box` 四个别名。
    // 那四个不是机器，而这份清单是给模型挑机器用的
    expect(aliases('Host web # my web box\n  HostName a\n')).toEqual(['web'])
  })

  it('SSHC-U-54: 单值指令的行尾注释不进值里', () => {
    expect(hosts('Host web\n  HostName example.com # prod\n')[0].hostname).toBe('example.com')
  })
})

// ─── Match：不属于任何别名，且不起进程 ───────────────────────────────────

describe('listSshHosts 与 Match 块', () => {
  it('SSHC-U-55: Match 块里的内容不归任何别名', () => {
    // 它是条件求值的产物，枚举阶段无从判断条件成不成立
    expect(
      hosts(`Host web
  HostName 1.2.3.4
Match host web
  User root
`)
    ).toEqual([{ alias: 'web', hostname: '1.2.3.4' }])
  })

  it('SSHC-U-56: Match 之后的 Host 重新接管归属', () => {
    expect(
      hosts(`Match host anything
  User root
Host web
  HostName 1.2.3.4
`)
    ).toEqual([{ alias: 'web', hostname: '1.2.3.4' }])
  })

  it('SSHC-U-57: `Match exec` 不被执行 —— 枚举没有副作用', () => {
    const sentinel = join(sshDir, 'pwned')
    const result = hosts(`Host web
  HostName 1.2.3.4
Match exec "touch ${sentinel}"
  User root
`)

    expect(existsSync(sentinel)).toBe(false)
    expect(cp.calls).toEqual([])
    expect(result.map((h) => h.alias)).toEqual(['web'])
  })
})

// ─── Include ─────────────────────────────────────────────────────────────

describe('listSshHosts 的 Include', () => {
  it('SSHC-U-58: 跟进被包含的文件', () => {
    put('extra.conf', 'Host inc\n  HostName 9.9.9.9\n')
    expect(hosts('Include extra.conf\nHost web\n  HostName a\n')).toEqual([
      { alias: 'inc', hostname: '9.9.9.9' },
      { alias: 'web', hostname: 'a' }
    ])
  })

  it('SSHC-U-59: 相对路径落在 ~/.ssh 下，而不是当前文件所在目录', () => {
    // 用户配置里的 `Include conf.d/*` 指的就是 `~/.ssh/conf.d/*`；诱饵证明这一点
    put('conf.d/nested.conf', 'Include other.conf\n')
    put('conf.d/other.conf', 'Host decoy\n')
    put('other.conf', 'Host real\n')

    expect(aliases('Include conf.d/nested.conf\n')).toEqual(['real'])
  })

  it('SSHC-U-60: 绝对路径照用', () => {
    const abs = put('abs.conf', 'Host abs\n')
    expect(aliases(`Include ${abs}\n`)).toEqual(['abs'])
  })

  it('SSHC-U-61: `~/` 展开到家目录', () => {
    writeFileSync(join(home.dir, 'outside.conf'), 'Host tilde\n')
    expect(aliases('Include ~/outside.conf\n')).toEqual(['tilde'])
  })

  it('SSHC-U-62: 最后一段的 `*` 通配，结果按文件名排序', () => {
    // 先写 b 再写 a：顺序不能由 readdir 决定，否则同一份配置在两台机器上列出的顺序不同
    put('conf.d/b.conf', 'Host b\n')
    put('conf.d/a.conf', 'Host a\n')
    expect(aliases('Include conf.d/*.conf\n')).toEqual(['a', 'b'])
  })

  it('SSHC-U-63: `?` 只匹配一个字符', () => {
    put('conf.d/host1.conf', 'Host one\n')
    put('conf.d/host22.conf', 'Host two\n')
    expect(aliases('Include conf.d/host?.conf\n')).toEqual(['one'])
  })

  it('SSHC-U-64: 文件名里的正则元字符被转义', () => {
    // 不转义时 `a+b*.conf` 会编译成 `a+b.*\.conf`，把 `aab1.conf` 也吃进来
    put('conf.d/a+b1.conf', 'Host plus\n')
    put('conf.d/aab1.conf', 'Host regexleak\n')
    expect(aliases('Include conf.d/a+b*.conf\n')).toEqual(['plus'])
  })

  it('SSHC-U-65: 通配只支持最后一段，中间段带通配就是找不到（不抛）', () => {
    put('conf.d/sub/deep.conf', 'Host deep\n')
    expect(aliases('Host web\nInclude conf.d/*/deep.conf\n')).toEqual(['web'])
  })

  it('SSHC-U-66: 通配也能找到符号链接（stow / chezmoi 管理的配置）', () => {
    // readdir 的 isFile() 对符号链接是 false（lstat 语义）—— 少了 isSymbolicLink() 这一支，
    // 这类配置会静默消失
    const target = put('real-linked.conf', 'Host linked\n')
    mkdirSync(join(sshDir, 'conf.d'), { recursive: true })
    symlinkSync(target, join(sshDir, 'conf.d', 'link.conf'))
    expect(aliases('Include conf.d/*.conf\n')).toEqual(['linked'])
  })

  it('SSHC-U-67: 不带通配地包含同一个符号链接也走得通（两条分支口径一致）', () => {
    const target = put('real-linked.conf', 'Host linked\n')
    mkdirSync(join(sshDir, 'conf.d'), { recursive: true })
    symlinkSync(target, join(sshDir, 'conf.d', 'link.conf'))
    expect(aliases('Include conf.d/link.conf\n')).toEqual(['linked'])
  })

  it('SSHC-U-68: 目标不存在就跳过', () => {
    expect(aliases('Include nope.conf\nHost web\n')).toEqual(['web'])
  })

  it('SSHC-U-69: 目标是目录就跳过（读不动只是跳过，不是抛）', () => {
    put('conf.d/a.conf', 'Host a\n')
    expect(aliases('Include conf.d\nHost web\n')).toEqual(['web'])
  })

  it('SSHC-U-70: 成环也能终止，每个文件只读一次', () => {
    const a = put('a.conf', 'Host a\nInclude b.conf\n')
    const b = put('b.conf', 'Host b\nInclude a.conf\n')

    expect(aliases('Include a.conf\nHost web\n')).toEqual(['a', 'b', 'web'])
    expect(readsOf(a)).toBe(1)
    expect(readsOf(b)).toBe(1)
  })

  it('SSHC-U-71: 同一个文件被包含两次也只读一次', () => {
    const x = put('x.conf', 'Host x\n')
    expect(aliases('Include x.conf\nInclude x.conf\nHost web\n')).toEqual(['x', 'web'])
    expect(readsOf(x)).toBe(1)
  })

  it('SSHC-U-72: 深度上限 8 层 —— 更深的不再跟进（不抛）', () => {
    // 环已经由 visited 挡住了，这一层只防病态深度
    for (let d = 1; d <= 10; d++) {
      const next = d < 10 ? `Include d${d + 1}.conf\n` : ''
      put(`d${d}.conf`, `Host d${d}\n${next}`)
    }
    const listed = aliases('Include d1.conf\n')
    expect(listed).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'])
  })

  it('SSHC-U-73: 被包含的别名出现在「包含发生的那一点」上', () => {
    put('mid.conf', 'Host m\n')
    expect(aliases('Host a\nInclude mid.conf\nHost z\n')).toEqual(['a', 'm', 'z'])
  })

  it('SSHC-U-74: 一行 Include 多个路径', () => {
    put('one.conf', 'Host one\n')
    put('two.conf', 'Host two\n')
    expect(aliases('Include one.conf two.conf\n')).toEqual(['one', 'two'])
  })

  it('SSHC-U-75: Include 不夺走当前块 —— 返回后指令仍归**本文件**上一个 Host', () => {
    // OpenSSH 是纯文本展开的，被包含文件末尾的 Host 会漏进父文件；这里刻意不跟随 ——
    // 一份配置的归属被另一份的结尾改写，读起来没有任何道理
    put('inner.conf', 'Host inner\n  HostName inner-host\n')
    const result = hosts(`Host a
  Include inner.conf
  HostName after
`)
    expect(result).toEqual([
      { alias: 'a', hostname: 'after' },
      { alias: 'inner', hostname: 'inner-host' }
    ])
  })
})

// ─── 先到先得与取值范围 ──────────────────────────────────────────────────

describe('listSshHosts 的先到先得', () => {
  it('SSHC-U-76: 同名块重复出现时，先出现的值胜出', () => {
    expect(
      hosts(`Host web
  HostName first
Host web
  HostName second
`)
    ).toEqual([{ alias: 'web', hostname: 'first' }])
  })

  it('SSHC-U-77: 先到先得按**键**算 —— 后面的块能补上前面没写的键', () => {
    expect(
      hosts(`Host web
  HostName first
Host web
  HostName second
  User bob
`)
    ).toEqual([{ alias: 'web', hostname: 'first', user: 'bob' }])
  })

  it('SSHC-U-78: 同一个块里重复的键也是先到先得', () => {
    expect(
      hosts(`Host web
  HostName a
  HostName b
`)
    ).toEqual([{ alias: 'web', hostname: 'a' }])
  })

  it('SSHC-U-79: 端口必须是 1…65535 的整数，读不出来就当没写', () => {
    expect(
      hosts(`Host web
  Port abc
  Port 22
Host zero
  Port 0
Host huge
  Port 70000
Host neg
  Port -1
`)
    ).toEqual([{ alias: 'web', port: 22 }, { alias: 'zero' }, { alias: 'huge' }, { alias: 'neg' }])
  })
})

// ─── 边界 ────────────────────────────────────────────────────────────────

describe('listSshHosts 的边界', () => {
  it('SSHC-U-80: 配置不存在 = 空列表（这不是错误，只是还没配过 ssh）', () => {
    expect(listSshHosts(join(sshDir, 'no-such-config'))).toEqual([])
  })

  it('SSHC-U-81: 读不动（路径是目录）也只是空列表，不抛', () => {
    expect(listSshHosts(sshDir)).toEqual([])
  })

  it('SSHC-U-82: 首次出现顺序（跨文件也一样），不是字母序', () => {
    put('mid.conf', 'Host m\n')
    expect(
      aliases(`Host z
Include mid.conf
Host a
Host z
`)
    ).toEqual(['z', 'm', 'a'])
  })

  it('SSHC-U-83: CRLF 行尾', () => {
    expect(hosts('Host web\r\n  HostName 1.2.3.4\r\n  Port 2222\r\n')).toEqual([
      { alias: 'web', hostname: '1.2.3.4', port: 2222 }
    ])
  })

  it('SSHC-U-84: 一个 Host 块都没有 = 空列表', () => {
    expect(
      hosts(`# 只有全局设置
ServerAliveInterval 60
Compression yes
`)
    ).toEqual([])
  })
})

// ─── `-` 开头的记号不是别名 ──────────────────────────────────────────────
//
// 这一组测的不是解析的准确性，而是**这份清单会被原样交给 `ssh` 的 argv**。
// `Host -oProxyCommand=…` 是 OpenSSH 允许写出的东西（它在自己那边只是个永远匹配不上的
// 主机名），可一旦它成了我们清单里的一个「别名」，`ssh -oProxyCommand=touch X -- <cmd>`
// 就会在**本地**执行那条命令，而安全门看到的是 `<cmd>` —— 卡片上写着一条无害的命令，
// 跑的却是别的。所以判据是记号的形状，不是它像不像一台机器。

describe('listSshHosts 的 argv 防线', () => {
  it('SSHC-U-85: `Host -oProxyCommand=…` 不是别名，同块里的兄弟照常产出', () => {
    expect(
      aliases(`Host -oProxyCommand=id good
  HostName 1.2.3.4
`)
    ).toEqual(['good'])
  })

  it('SSHC-U-86: 带引号因而含空格 / 管道的 `-` 记号同样不是别名', () => {
    // 引号让一个记号可以装下一整条 shell 命令；判据仍然只看首字符
    expect(
      aliases(`Host "-oProxyCommand=sh -c 'touch /tmp/pwned | id'" good
  HostName 1.2.3.4
`)
    ).toEqual(['good'])
  })

  it('SSHC-U-87: 裸 `--` 不是别名 —— 它在 argv 里是选项终止符', () => {
    expect(
      aliases(`Host -- good
  HostName 1.2.3.4
`)
    ).toEqual(['good'])
  })

  it('SSHC-U-88: 单个 `-` 也不是别名', () => {
    expect(
      aliases(`Host - good
  HostName 1.2.3.4
`)
    ).toEqual(['good'])
  })

  it('SSHC-U-89: 非行首的 `-` 照常 —— 拦的是位置，不是这个字符', () => {
    // 连字符是别名里最常见的写法，把它整个拉黑会让多数人的配置凭空少掉一半机器
    expect(
      aliases(`Host my-box a-b-c
  HostName 1.2.3.4
`)
    ).toEqual(['my-box', 'a-b-c'])
  })
})
