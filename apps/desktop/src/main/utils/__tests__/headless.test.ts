/**
 * `utils/headless.ts` —— 无头模式的纯函数那一半（docs/headless/design.md §1）：命令行解析、用法、stdout 的几行、
 * 进程级的模式开关、开窗时的错误、同步写 stdout 的小工具；外加一组跨文件的措辞守卫（安装脚本、Linux 工作流、
 * e2e 的 harness 按这些行找，措辞一变它们就悄悄失灵）。
 *
 *   HL-P1  空 argv、空 env → 恰是 {headless:false, lan:false, help:false}（没有 port / error 键）
 *   HL-P2  '--headless'（argv 里还有可执行文件）→ headless
 *   HL-P3  SHUVIX_HEADLESS：1 / true / TRUE / Yes / yes（及两边带空格）→ 开；0 / false / no / on / '' / 缺 → 关
 *   HL-P4  开关与环境变量取「或」
 *   HL-P5  --port 8123 / --port=8123 / --network-port 8123 / --network-port=8123
 *   HL-P6  1024 / 65535 收；1023、65536、0、80.5、8e3、0x1F90、+8123、' 8123' → 固定措辞的错误（别名报别名）
 *   HL-P7  缺值：--port 在末尾、--port=、--port 后面跟着开关（不吃掉它）、--port=-1
 *   HL-P8  给了多次：最后一个合法值为准；错误只记第一个
 *   HL-P9  --help / -h；--help 与错误并存
 *   HL-P10 Chromium 开关、引导脚本、md 文件原样放过；--portable / --ports=1 / --network-ports=2 / --HEADLESS 不认
 *   HL-P11 没有 --headless 时坏端口照样记错误（主入口只在无头时据此退出）
 *   HL-P12 --lan / SHUVIX_LAN；--lan=1 / --LAN / --lan-only 不认；['--port','--lan'] → 缺值且 lan
 *   HL-P13 只有 --lan → {headless:false, lan:true, help:false}
 *   HL-P14 --bind eth1 / --bind=eth1 → bind，隐含 lan（没有 --headless 也照样解析）
 *   HL-P15 不合法的 --bind 值（空白、shell 元字符、`/`、换行、`%`、超过 64 字符）→ 固定措辞的错误、没有 bind、lan 仍 false；
 *          64 字符与 IPv4 地址收
 *   HL-P16 缺值：--bind 在末尾、--bind=、后面跟着开关（--lan 不被吃掉）、--bind -x
 *   HL-P17 SHUVIX_BIND：去空白、空串不算；命令行没给 --bind 时不合法的值记错误；命令行的 --bind 优先（此时环境变量里
 *          的错不算数）
 *   HL-P18 --bind 给了多次：最后一个合法值；错误只记第一个（与端口错误之间也是先到先记）
 *   HL-P19 --BIND / --bind-to / --binds= 不认；--lan --bind 并存；--help 与 --bind 的错误并存
 *   HL-U1  用法：第一行、提到的开关与环境变量、ssh -L 例子、Chromium 开关、风险那句；只提这几个 --开关；每行 ≤ 80 列
 *   HL-L1  就绪那一行（em dash、每个地址以 / 结尾、已有 / 不重复）
 *   HL-L2  监听失败那一行（EADDRINUSE / EACCES 带解释，其余原样）
 *   HL-L2b ENOINTERFACE：无头运行给了 --bind → 带网卡名；没给 → 不带（不出现两个空格）
 *   HL-L3  三句固定的行
 *   HL-L4  已经在跑：有地址 / 还在启动
 *   HL-L5  参数错误那一行；每个构造出来的行都以前缀开头、没有换行
 *   HL-M1  模式开关：缺省桌面；enableHeadlessMode() / {port}；reset 回去
 *   HL-M2  headlessWindowError：Error、code 'headless'、固定措辞
 *   HL-M3  headlessLan：缺省 false；{lan:true} → true；非布尔的 lan 不算
 *   HL-M4  headlessBind：{bind} → bind，隐含 lan（{lan:false, bind} 也是）；没给 / reset → undefined
 *   HL-W1  printHeadlessLine 只在缺换行时补一个；写到给定的 fd（缺省 1）
 *   HL-W2  每次只写进 7 字节：按字节拼回恰好 line + '\n'（含多字节的 —）
 *   HL-W3  EAGAIN 两次后成功 → 全部写完
 *   HL-W4  EPIPE → 静默返回，不再写
 *   HL-W5  一直 EAGAIN → 恰 50 次后放弃，不抛
 *   HL-X1  跨文件措辞守卫：install-linux.sh 的 READY_PREFIX 与 case 模式、linux-headless.yml 的 grep / test 字面量、
 *          e2e harness 的 HEADLESS_READY_PREFIX
 *   HL-X2  electron-builder.yml 的 AppImage / deb 产物名与包名（安装脚本按它拼下载地址）
 *   HL-X3  RELEASE_REPO 与 electron-builder.yml 的 publish（owner/repo）、install-linux.sh 的缺省 REPO 一致
 *   HL-X4  release.yml 的 publish job 把 install-linux.sh 拷进 dist/，Release 那一步上传 dist/*（升级命令按它下载脚本）
 *   HL-UP1 headlessUpdateCommand 在 linux 上收的形状：x.y.z / vx.y.z（不重复 v）/ 预发布后缀 / 多位数 → 固定的那条命令
 *   HL-UP2 收下的每条命令都恰是「curl 那个版本的脚本 | bash -s -- --version 同一个 tag」，不带 --service / --port / --lan
 *   HL-UP3 不是 x.y.z[-pre] 的一律 null：空串、latest、段数不对、空的 / 带 + 的后缀、大写 V、vv、两边空白、换行、全角数字、
 *          非 ASCII 后缀；shell 元字符出现在后缀中间 / 开头 / 结尾；命令替换 / 管道 / && 的写法
 *   HL-UP4 darwin / win32 / freebsd 上合法版本号也 → null
 *   HL-UP5 缺省平台 = process.platform（linux → 命令，darwin → null）
 *   HL-UP6 headlessUpdateError：Error、code 'headless'、固定措辞、每次新的对象
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  enableHeadlessMode,
  HEADLESS_DESKTOP_RUNNING_LINE,
  HEADLESS_LINE_PREFIX,
  HEADLESS_SHUTTING_DOWN_LINE,
  HEADLESS_STOPPED_LINE,
  headlessAlreadyRunningLine,
  headlessArgsErrorLine,
  headlessBind,
  headlessLan,
  headlessListenErrorLine,
  headlessPortOverride,
  headlessReadyLine,
  headlessUpdateCommand,
  headlessUpdateError,
  headlessUsage,
  headlessWindowError,
  isHeadless,
  parseHeadlessArgs,
  printHeadlessLine,
  RELEASE_REPO,
  resetHeadlessModeForTests
} from '../headless'

const DESKTOP_ROOT = resolve(__dirname, '../../../..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..')
const read = (path: string): string => readFileSync(path, 'utf-8')

const ELECTRON = '/x/Electron'
const parse = (
  args: string[],
  env: Record<string, string | undefined> = {}
): ReturnType<typeof parseHeadlessArgs> => parseHeadlessArgs([ELECTRON, ...args], env)

const PORT_RANGE = 'an integer between 1024 and 65535'

afterEach(() => {
  resetHeadlessModeForTests()
})

describe('HL-P parseHeadlessArgs', () => {
  it('HL-P1 空 argv、空 env → 恰是三个 false', () => {
    expect(parseHeadlessArgs([], {})).toStrictEqual({ headless: false, lan: false, help: false })
    expect(parseHeadlessArgs([])).toStrictEqual({ headless: false, lan: false, help: false })
  })

  it('HL-P2 --headless → headless', () => {
    expect(parse(['--headless'])).toStrictEqual({ headless: true, lan: false, help: false })
  })

  it('HL-P3 SHUVIX_HEADLESS 的取值', () => {
    for (const yes of ['1', 'true', 'TRUE', 'Yes', 'yes', ' yes ']) {
      expect(parse([], { SHUVIX_HEADLESS: yes }).headless, JSON.stringify(yes)).toBe(true)
    }
    for (const no of ['0', 'false', 'no', 'on', '', undefined]) {
      expect(parse([], { SHUVIX_HEADLESS: no }).headless, JSON.stringify(no)).toBe(false)
    }
  })

  it('HL-P4 开关与环境变量取「或」', () => {
    expect(parse(['--headless'], { SHUVIX_HEADLESS: '0' }).headless).toBe(true)
    expect(parse([], { SHUVIX_HEADLESS: '1' }).headless).toBe(true)
  })

  it('HL-P5 --port / --network-port 的两种写法', () => {
    for (const args of [
      ['--port', '8123'],
      ['--port=8123'],
      ['--network-port', '8123'],
      ['--network-port=8123']
    ]) {
      const parsed = parse(['--headless', ...args])
      expect(parsed.port, args.join(' ')).toBe(8123)
      expect('error' in parsed, args.join(' ')).toBe(false)
    }
  })

  it('HL-P6 端口的边界与不合法的写法', () => {
    expect(parse(['--port', '1024']).port).toBe(1024)
    expect(parse(['--port', '65535']).port).toBe(65535)
    for (const bad of ['1023', '65536', '0', '80.5', '8e3', '0x1F90', '+8123', ' 8123']) {
      const parsed = parse(['--headless', '--port', bad])
      expect(parsed.error, JSON.stringify(bad)).toBe(
        `invalid --port value "${bad}": use ${PORT_RANGE}`
      )
      expect('port' in parsed, JSON.stringify(bad)).toBe(false)
    }
    expect(parse(['--port', '1023']).error).toBe(
      'invalid --port value "1023": use an integer between 1024 and 65535'
    )
    expect(parse(['--network-port', 'abc']).error).toBe(
      'invalid --network-port value "abc": use an integer between 1024 and 65535'
    )
  })

  it('HL-P7 缺值', () => {
    const needs = `--port needs a value (${PORT_RANGE})`
    expect(parse(['--headless', '--port'])).toStrictEqual({
      headless: true,
      lan: false,
      help: false,
      error: needs
    })
    expect(parse(['--headless', '--port=']).error).toBe(needs)
    // 后面跟着开关：缺值，且那个开关照样认（没被当成端口吃掉）
    const swallowed = parse(['--port', '--headless'])
    expect(swallowed.error).toBe(needs)
    expect(swallowed.headless).toBe(true)
    expect(parse(['--port=-1']).error).toBe(needs)
    expect(parse(['--network-port']).error).toBe(`--network-port needs a value (${PORT_RANGE})`)
  })

  it('HL-P8 给了多次：最后一个合法值；错误只记第一个', () => {
    expect(parse(['--port', '2000', '--port', '3000']).port).toBe(3000)
    const mixed = parse(['--port', 'abc', '--port', '3000'])
    expect(mixed.port).toBe(3000)
    expect(mixed.error).toContain('"abc"')
    const both = parse(['--port', 'abc', '--port', 'xyz'])
    expect(both.error).toContain('"abc"')
    expect(both.error).not.toContain('xyz')
  })

  it('HL-P9 --help / -h；与错误并存', () => {
    expect(parse(['--help']).help).toBe(true)
    expect(parse(['-h']).help).toBe(true)
    const parsed = parse(['--help', '--headless', '--port', 'abc'])
    expect(parsed.help).toBe(true)
    expect(parsed.headless).toBe(true)
    expect(parsed.error).toBe(`invalid --port value "abc": use ${PORT_RANGE}`)
  })

  it('HL-P10 不认得的参数原样放过', () => {
    expect(
      parseHeadlessArgs(
        [
          ELECTRON,
          '/x/bootstrap.cjs',
          '--remote-debugging-port=9223',
          '--ozone-platform=headless',
          '--disable-gpu',
          '--no-sandbox',
          'notes.md',
          '--headless'
        ],
        {}
      )
    ).toStrictEqual({ headless: true, lan: false, help: false })
    expect(parse(['--portable', '--ports=1', '--network-ports=2', '--HEADLESS'])).toStrictEqual({
      headless: false,
      lan: false,
      help: false
    })
  })

  it('HL-P11 没有 --headless 时坏端口照样记错误', () => {
    const parsed = parse(['--port', 'abc'])
    expect(parsed.headless).toBe(false)
    expect(parsed.error).toBe(`invalid --port value "abc": use ${PORT_RANGE}`)
  })

  it('HL-P12 --lan / SHUVIX_LAN', () => {
    expect(parse(['--headless', '--lan']).lan).toBe(true)
    for (const yes of ['1', 'true', 'YES', ' yes ']) {
      expect(parse([], { SHUVIX_LAN: yes }).lan, JSON.stringify(yes)).toBe(true)
    }
    for (const no of ['0', 'no', '', undefined]) {
      expect(parse([], { SHUVIX_LAN: no }).lan, JSON.stringify(no)).toBe(false)
    }
    expect(parse(['--lan'], { SHUVIX_LAN: '0' }).lan).toBe(true)
    for (const ignored of ['--lan=1', '--LAN', '--lan-only']) {
      expect(parse([ignored]), ignored).toStrictEqual({ headless: false, lan: false, help: false })
    }
    const both = parse(['--port', '--lan'])
    expect(both.error).toBe(`--port needs a value (${PORT_RANGE})`)
    expect(both.lan).toBe(true)
  })

  it('HL-P13 只有 --lan', () => {
    expect(parse(['--lan'])).toStrictEqual({ headless: false, lan: true, help: false })
  })

  const BIND_NEEDS =
    '--bind needs a value (a network interface name such as eth1, or an address of this computer)'
  const bindInvalid = (raw: string): string =>
    `invalid --bind value "${raw}": use a network interface name such as eth1, or an address of this computer`

  it('HL-P14 --bind 的两种写法；隐含 lan', () => {
    expect(parse(['--headless', '--bind', 'eth1'])).toStrictEqual({
      headless: true,
      lan: true,
      help: false,
      bind: 'eth1'
    })
    expect(parse(['--headless', '--bind=eth1'])).toStrictEqual({
      headless: true,
      lan: true,
      help: false,
      bind: 'eth1'
    })
    expect(parse(['--bind', 'eth1'])).toStrictEqual({
      headless: false,
      lan: true,
      help: false,
      bind: 'eth1'
    })
  })

  it('HL-P15 不合法的值 → 固定措辞的错误、没有 bind；64 字符与地址收', () => {
    for (const bad of [
      'eth 1',
      'eth1;rm -rf /',
      '$(id)',
      'a/b',
      'eth1\n',
      'fe80::1%eth0',
      'a'.repeat(65)
    ]) {
      const parsed = parse(['--headless', '--bind', bad])
      expect(parsed.error, JSON.stringify(bad)).toBe(bindInvalid(bad))
      expect('bind' in parsed, JSON.stringify(bad)).toBe(false)
      expect(parsed.lan, JSON.stringify(bad)).toBe(false)
    }
    const long = 'a'.repeat(64)
    expect(parse(['--bind', long]).bind).toBe(long)
    expect('error' in parse(['--bind', long])).toBe(false)
    const address = parse(['--headless', '--bind', '192.168.50.10'])
    expect(address.bind).toBe('192.168.50.10')
    expect('error' in address).toBe(false)
  })

  it('HL-P16 缺值：末尾、--bind=、后面跟着开关（不吃掉它）、-x', () => {
    expect(parse(['--headless', '--bind'])).toStrictEqual({
      headless: true,
      lan: false,
      help: false,
      error: BIND_NEEDS
    })
    expect(parse(['--headless', '--bind='])).toStrictEqual({
      headless: true,
      lan: false,
      help: false,
      error: BIND_NEEDS
    })
    const swallowed = parse(['--bind', '--lan'])
    expect(swallowed.error).toBe(BIND_NEEDS)
    expect(swallowed.lan).toBe(true)
    expect('bind' in swallowed).toBe(false)
    const dash = parse(['--bind', '-x'])
    expect(dash.error).toBe(BIND_NEEDS)
    expect('bind' in dash).toBe(false)
  })

  it('HL-P17 SHUVIX_BIND', () => {
    expect(parse([], { SHUVIX_BIND: 'eth1' })).toStrictEqual({
      headless: false,
      lan: true,
      help: false,
      bind: 'eth1'
    })
    expect(parse([], { SHUVIX_BIND: ' eth1 ' }).bind).toBe('eth1')
    for (const empty of ['', '   ']) {
      expect(parse([], { SHUVIX_BIND: empty }), JSON.stringify(empty)).toStrictEqual({
        headless: false,
        lan: false,
        help: false
      })
    }
    const bad = parse([], { SHUVIX_BIND: 'a b' })
    expect(bad.error).toBe(
      'invalid SHUVIX_BIND value "a b": use a network interface name or an address of this computer'
    )
    expect('bind' in bad).toBe(false)
    expect(bad.lan).toBe(false)
    // 命令行优先
    expect(parse(['--bind', 'eth2'], { SHUVIX_BIND: 'eth1' }).bind).toBe('eth2')
    // 命令行给了 --bind：环境变量里的错不算数
    const argvWins = parse(['--bind', 'eth2'], { SHUVIX_BIND: 'a b' })
    expect(argvWins).toStrictEqual({ headless: false, lan: true, help: false, bind: 'eth2' })
  })

  it('HL-P18 --bind 给了多次：最后一个合法值；错误只记第一个', () => {
    expect(parse(['--bind', 'eth1', '--bind', 'eth2']).bind).toBe('eth2')
    const mixed = parse(['--bind', 'a b', '--bind', 'eth2'])
    expect(mixed.bind).toBe('eth2')
    expect(mixed.error).toBe(bindInvalid('a b'))
    const both = parse(['--bind', 'a;b', '--bind', 'c;d'])
    expect(both.error).toBe(bindInvalid('a;b'))
    expect(parse(['--bind', 'a b', '--port', 'abc']).error).toBe(bindInvalid('a b'))
    expect(parse(['--bind', 'eth1', '--port', 'abc']).error).toBe(
      `invalid --port value "abc": use ${PORT_RANGE}`
    )
  })

  it('HL-P19 不认得的写法；与 --lan、--help 并存', () => {
    for (const args of [['--BIND', 'eth1'], ['--bind-to', 'eth1'], ['--binds=x']]) {
      expect(parse(args), args.join(' ')).toStrictEqual({
        headless: false,
        lan: false,
        help: false
      })
    }
    expect(parse(['--lan', '--bind', 'eth1'])).toStrictEqual({
      headless: false,
      lan: true,
      help: false,
      bind: 'eth1'
    })
    const help = parse(['--help', '--bind', 'a b'])
    expect(help.help).toBe(true)
    expect(help.error).toBe(bindInvalid('a b'))
  })
})

describe('HL-U headlessUsage', () => {
  it('HL-U1 用法的内容与宽度', () => {
    const usage = headlessUsage()
    const lines = usage.split('\n')
    expect(lines[0]).toBe(
      'Usage: shuvix --headless [--port <n>] [--lan | --bind <interface or address>]'
    )
    for (const needle of [
      '--headless',
      '--port <n>',
      '--network-port',
      '--lan',
      '--bind <name>',
      '--help, -h',
      'SHUVIX_HEADLESS=1',
      'SHUVIX_LAN=1',
      'SHUVIX_BIND=<name>',
      'ssh -L 7766:127.0.0.1:7766',
      '--ozone-platform=headless --disable-gpu'
    ]) {
      expect(usage, needle).toContain(needle)
    }
    expect(
      lines.some((line) => line.startsWith('Network access has no password: with --lan or --bind,'))
    ).toBe(true)
    const flags = new Set(usage.match(/--[A-Za-z][\w=-]*/g) ?? [])
    expect([...flags].sort()).toStrictEqual(
      [
        '--bind',
        '--disable-gpu',
        '--headless',
        '--help',
        '--lan',
        '--network-port',
        '--ozone-platform=headless',
        '--port'
      ].sort()
    )
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(80)
  })
})

describe('HL-L stdout 的几行', () => {
  it('HL-L1 就绪那一行', () => {
    expect(headlessReadyLine(['http://192.168.1.10:8123', 'http://127.0.0.1:8123'])).toBe(
      'ShuviX headless: ready — open one of: http://192.168.1.10:8123/ http://127.0.0.1:8123/'
    )
    expect(headlessReadyLine(['http://127.0.0.1:8123/'])).toBe(
      'ShuviX headless: ready — open one of: http://127.0.0.1:8123/'
    )
  })

  it('HL-L2 监听失败那一行', () => {
    expect(headlessListenErrorLine(7766, 'EADDRINUSE')).toBe(
      'ShuviX headless: cannot listen on port 7766: EADDRINUSE (the port is already in use)'
    )
    expect(headlessListenErrorLine(7766, 'EACCES')).toBe(
      'ShuviX headless: cannot listen on port 7766: EACCES (permission denied)'
    )
    expect(headlessListenErrorLine(7766, 'EADDRNOTAVAIL')).toBe(
      'ShuviX headless: cannot listen on port 7766: EADDRNOTAVAIL'
    )
    expect(headlessListenErrorLine(8123, 'not listening')).toBe(
      'ShuviX headless: cannot listen on port 8123: not listening'
    )
  })

  it('HL-L2b ENOINTERFACE：有 --bind 带网卡名，没有不带', () => {
    expect(headlessListenErrorLine(7766, 'ENOINTERFACE')).toBe(
      'ShuviX headless: cannot listen on port 7766: ENOINTERFACE (no network interface or local address on this computer)'
    )
    enableHeadlessMode({ bind: 'eth9' })
    expect(headlessListenErrorLine(7766, 'ENOINTERFACE')).toBe(
      'ShuviX headless: cannot listen on port 7766: ENOINTERFACE (no network interface or local address eth9 on this computer)'
    )
    enableHeadlessMode({ port: 8123 })
    const noBind = headlessListenErrorLine(8123, 'ENOINTERFACE')
    expect(noBind).toBe(
      'ShuviX headless: cannot listen on port 8123: ENOINTERFACE (no network interface or local address on this computer)'
    )
    expect(noBind).not.toContain('  ')
  })

  it('HL-L3 固定的三句', () => {
    expect(HEADLESS_SHUTTING_DOWN_LINE).toBe('ShuviX headless: shutting down')
    expect(HEADLESS_STOPPED_LINE).toBe('ShuviX headless: stopped')
    expect(HEADLESS_DESKTOP_RUNNING_LINE).toBe(
      'ShuviX headless: the ShuviX desktop app is already running for this user; quit it first, then start ShuviX headless'
    )
  })

  it('HL-L4 已经在跑', () => {
    expect(headlessAlreadyRunningLine(['http://a:1', 'http://b:1/'])).toBe(
      'ShuviX headless: already running — open one of: http://a:1/ http://b:1/'
    )
    expect(headlessAlreadyRunningLine([])).toBe('ShuviX headless: already running (still starting)')
  })

  it('HL-L5 参数错误那一行；每一行都带前缀、没有换行', () => {
    expect(headlessArgsErrorLine('x')).toBe('ShuviX headless: x (see shuvix --help)')
    const lines = [
      headlessReadyLine(['http://127.0.0.1:1']),
      headlessReadyLine([]),
      headlessListenErrorLine(1, 'EADDRINUSE'),
      headlessListenErrorLine(1, 'X'),
      headlessListenErrorLine(1, 'ENOINTERFACE'),
      headlessAlreadyRunningLine(['http://a:1']),
      headlessAlreadyRunningLine([]),
      headlessArgsErrorLine('x'),
      HEADLESS_SHUTTING_DOWN_LINE,
      HEADLESS_STOPPED_LINE,
      HEADLESS_DESKTOP_RUNNING_LINE
    ]
    for (const line of lines) {
      expect(line.startsWith(HEADLESS_LINE_PREFIX), line).toBe(true)
      expect(line.includes('\n'), line).toBe(false)
    }
    expect(HEADLESS_LINE_PREFIX).toBe('ShuviX headless:')
  })
})

describe('HL-M 进程级的模式开关', () => {
  it('HL-M1 缺省桌面；打开；带端口；reset', () => {
    expect(isHeadless()).toBe(false)
    expect(headlessPortOverride()).toBeUndefined()
    enableHeadlessMode()
    expect(isHeadless()).toBe(true)
    expect(headlessPortOverride()).toBeUndefined()
    enableHeadlessMode({ port: 8123 })
    expect(isHeadless()).toBe(true)
    expect(headlessPortOverride()).toBe(8123)
    resetHeadlessModeForTests()
    expect(isHeadless()).toBe(false)
    expect(headlessPortOverride()).toBeUndefined()
  })

  it('HL-M2 headlessWindowError', () => {
    const error = headlessWindowError('x')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('headless')
    expect(error.message).toBe(
      'ShuviX is running headless and does not open windows on this computer (x). Use ShuviX from a browser instead.'
    )
  })

  it('HL-M3 headlessLan', () => {
    expect(headlessLan()).toBe(false)
    enableHeadlessMode()
    expect(headlessLan()).toBe(false)
    enableHeadlessMode({ lan: true })
    expect(headlessLan()).toBe(true)
    expect(headlessPortOverride()).toBeUndefined()
    enableHeadlessMode({ port: 8123, lan: true })
    expect(headlessLan()).toBe(true)
    expect(headlessPortOverride()).toBe(8123)
    enableHeadlessMode({ lan: 'yes' as unknown as boolean })
    expect(headlessLan()).toBe(false)
    resetHeadlessModeForTests()
    expect(headlessLan()).toBe(false)
  })

  it('HL-M4 headlessBind：隐含 lan；没给 / reset → undefined', () => {
    expect(headlessBind()).toBeUndefined()
    enableHeadlessMode({ bind: 'eth1' })
    expect(headlessBind()).toBe('eth1')
    expect(headlessLan()).toBe(true)
    enableHeadlessMode({ lan: false, bind: 'eth1' })
    expect(headlessBind()).toBe('eth1')
    expect(headlessLan()).toBe(true)
    enableHeadlessMode({})
    expect(headlessBind()).toBeUndefined()
    expect(headlessLan()).toBe(false)
    enableHeadlessMode({ bind: 'eth1' })
    resetHeadlessModeForTests()
    expect(headlessBind()).toBeUndefined()
    expect(headlessLan()).toBe(false)
  })
})

describe('HL-W printHeadlessLine', () => {
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code }) as NodeJS.ErrnoException

  it('HL-W1 只在缺换行时补一个；写到给定的 fd（缺省 1）', () => {
    const write = vi.fn((_fd: number, data: Buffer) => data.length)
    printHeadlessLine('a', write)
    printHeadlessLine('b\n', write, 2)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[0][0]).toBe(1)
    expect(write.mock.calls[0][1].toString()).toBe('a\n')
    expect(write.mock.calls[1][0]).toBe(2)
    expect(write.mock.calls[1][1].toString()).toBe('b\n')
  })

  it('HL-W2 每次只写进 7 字节：按字节拼回恰好 line + 换行', () => {
    const line = headlessReadyLine(['http://127.0.0.1:8123'])
    const expected = Buffer.from(`${line}\n`)
    expect(Math.ceil(expected.length / 7)).toBeLessThan(50)
    const chunks: Buffer[] = []
    const write = vi.fn((_fd: number, data: Buffer) => {
      const n = Math.min(7, data.length)
      chunks.push(Buffer.from(data.subarray(0, n)))
      return n
    })
    printHeadlessLine(line, write)
    expect(Buffer.concat(chunks).equals(expected)).toBe(true)
    expect(write).toHaveBeenCalledTimes(Math.ceil(expected.length / 7))
  })

  it('HL-W3 EAGAIN 两次后成功 → 全部写完', () => {
    let calls = 0
    const written: Buffer[] = []
    const write = vi.fn((_fd: number, data: Buffer) => {
      calls++
      if (calls <= 2) throw errno('EAGAIN')
      written.push(Buffer.from(data))
      return data.length
    })
    printHeadlessLine('hello', write)
    expect(write).toHaveBeenCalledTimes(3)
    expect(Buffer.concat(written).toString()).toBe('hello\n')
  })

  it('HL-W4 EPIPE → 静默返回，不再写', () => {
    const write = vi.fn(() => {
      throw errno('EPIPE')
    })
    expect(() => printHeadlessLine('hello', write)).not.toThrow()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('HL-W5 一直 EAGAIN → 恰 50 次后放弃，不抛', () => {
    const write = vi.fn(() => {
      throw errno('EAGAIN')
    })
    expect(() => printHeadlessLine('hello', write)).not.toThrow()
    expect(write).toHaveBeenCalledTimes(50)
  })
})

describe('HL-X 跨文件的措辞守卫', () => {
  const READY_PREFIX = headlessReadyLine([])

  it('HL-X1a install-linux.sh：READY_PREFIX 与按措辞认失败的 case 模式', () => {
    expect(READY_PREFIX).toBe('ShuviX headless: ready — open one of: ')
    const script = read(join(REPO_ROOT, 'scripts/install-linux.sh'))
    const prefix = /^READY_PREFIX="([^"]*)"$/m.exec(script)
    expect(prefix, 'READY_PREFIX="…" in install-linux.sh').not.toBeNull()
    expect(prefix![1]).toBe(READY_PREFIX)

    const patterns = [...script.matchAll(/\*"(ShuviX [^"]*)"\*/g)].map((m) => m[1])
    expect(patterns).toContain('ShuviX headless: cannot listen')
    expect(patterns).toContain('ShuviX desktop app is already running')
    expect(headlessListenErrorLine(1, 'X').startsWith('ShuviX headless: cannot listen')).toBe(true)
    expect(HEADLESS_DESKTOP_RUNNING_LINE).toContain('ShuviX desktop app is already running')
  })

  it('HL-X1b linux-headless.yml：grep / test 的字面量都是某一行的前缀（127.0.0.1 是缺省）', () => {
    const workflow = read(join(REPO_ROOT, '.github/workflows/linux-headless.yml'))
    const N = 7766
    const sub = (literal: string, quote: string): string =>
      quote === '"' ? literal.replaceAll('$PORT', String(N)) : literal
    const greps = [...workflow.matchAll(/grep -q?F (?:'([^']*)'|"([^"]*)")/g)].flatMap((m) => {
      const literal = m[1] ?? m[2]
      return literal.includes('ShuviX headless')
        ? [sub(literal, m[1] === undefined ? '"' : "'")]
        : []
    })
    const loopback = [`http://127.0.0.1:${N}`]
    const candidates = [
      headlessReadyLine(loopback),
      headlessAlreadyRunningLine(loopback),
      HEADLESS_SHUTTING_DOWN_LINE,
      HEADLESS_STOPPED_LINE
    ]
    // 至少有就绪 / 已经在跑 / 开始退出 / 退出完这四种（防止正则什么也没抽到就空过）
    expect(new Set(greps).size).toBeGreaterThanOrEqual(5)
    for (const literal of greps) {
      expect(
        candidates.some((c) => c.startsWith(literal)),
        `workflow grep literal ${JSON.stringify(literal)}`
      ).toBe(true)
    }
    const already = greps.filter((l) => l.startsWith('ShuviX headless: already running'))
    expect(already).toStrictEqual([headlessAlreadyRunningLine([`http://127.0.0.1:${N}`])])
    expect(greps).toContain(HEADLESS_SHUTTING_DOWN_LINE)
    expect(greps).toContain(HEADLESS_STOPPED_LINE)
    expect(greps).toContain(READY_PREFIX)

    const tests = [...workflow.matchAll(/test "\$line" = "([^"]*)"/g)].map((m) =>
      m[1].replaceAll('$PORT', String(N))
    )
    expect(tests).toStrictEqual([headlessReadyLine([`http://127.0.0.1:${N}`])])
  })

  it('HL-X1c e2e harness 的 HEADLESS_READY_PREFIX', () => {
    const launch = read(join(DESKTOP_ROOT, 'e2e/harness/launch.ts'))
    const m = /export const HEADLESS_READY_PREFIX = '([^']*)'/.exec(launch)
    expect(m, 'HEADLESS_READY_PREFIX in e2e/harness/launch.ts').not.toBeNull()
    expect(m![1]).toBe(READY_PREFIX)
  })

  it('HL-X2 electron-builder.yml 的 AppImage / deb 产物名与包名', () => {
    const builder = parseYaml(read(join(DESKTOP_ROOT, 'electron-builder.yml'))) as {
      appImage?: { artifactName?: string }
      deb?: { artifactName?: string }
    }
    expect(builder.appImage?.artifactName).toBe('${name}-${version}-${arch}.${ext}')
    expect(builder.deb?.artifactName).toBe('${name}-${version}-${arch}.${ext}')
    const pkg = JSON.parse(read(join(DESKTOP_ROOT, 'package.json'))) as { name: string }
    expect(pkg.name).toBe('shuvix')
  })

  it('HL-X3 RELEASE_REPO 与 electron-builder.yml 的 publish、install-linux.sh 的缺省 REPO 一致', () => {
    const builder = parseYaml(read(join(DESKTOP_ROOT, 'electron-builder.yml'))) as {
      publish?: { provider?: string; owner?: string; repo?: string }
    }
    expect(builder.publish?.provider).toBe('github')
    expect(typeof builder.publish?.owner).toBe('string')
    expect(typeof builder.publish?.repo).toBe('string')
    expect(RELEASE_REPO).toBe(`${builder.publish!.owner}/${builder.publish!.repo}`)

    const script = read(join(REPO_ROOT, 'scripts/install-linux.sh'))
    const m = /^REPO="\$\{SHUVIX_INSTALL_REPO:-([^}"]*)\}"$/m.exec(script)
    expect(m, 'REPO="${SHUVIX_INSTALL_REPO:-…}" in install-linux.sh').not.toBeNull()
    expect(m![1]).toBe(RELEASE_REPO)
  })

  it('HL-X4 release.yml：publish job 把 install-linux.sh 拷进 dist/，之后的 Release 那一步上传 dist/*', () => {
    const text = read(join(REPO_ROOT, '.github/workflows/release.yml'))
    expect(text).toContain('cp scripts/install-linux.sh dist/install-linux.sh')

    type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> }
    const workflow = parseYaml(text) as { jobs?: Record<string, { steps?: Step[] }> }
    const jobs = Object.values(workflow.jobs ?? {})
    const job = jobs.find((j) =>
      (j.steps ?? []).some((s) => (s.uses ?? '').startsWith('softprops/action-gh-release'))
    )
    expect(job, 'the job that creates the GitHub Release').toBeDefined()
    const steps = job!.steps ?? []
    const copyAt = steps.findIndex((s) =>
      (s.run ?? '')
        .split('\n')
        .some((line) => line.trim() === 'cp scripts/install-linux.sh dist/install-linux.sh')
    )
    const releaseAt = steps.findIndex((s) =>
      (s.uses ?? '').startsWith('softprops/action-gh-release')
    )
    expect(copyAt, 'the cp step is in the release job').toBeGreaterThanOrEqual(0)
    expect(copyAt).toBeLessThan(releaseAt)
    expect(steps[releaseAt].with?.files).toBe('dist/*')
  })
})

describe('HL-UP 无头运行时的更新命令', () => {
  const CMD = (tag: string): string =>
    'curl -fsSL https://github.com/wangdongdongc/ShuviX/releases/download/' +
    tag +
    '/install-linux.sh | bash -s -- --version ' +
    tag
  const SHAPE =
    /^curl -fsSL https:\/\/github\.com\/wangdongdongc\/ShuviX\/releases\/download\/(v[0-9A-Za-z.-]+)\/install-linux\.sh \| bash -s -- --version \1$/
  const ACCEPTED: Array<[string, string]> = [
    ['0.2.13', 'v0.2.13'],
    ['v0.2.13', 'v0.2.13'],
    ['0.2.12-beta.1', 'v0.2.12-beta.1'],
    ['v1.0.0-rc1', 'v1.0.0-rc1'],
    ['10.20.30', 'v10.20.30']
  ]

  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value })
  }
  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
  })

  it('HL-UP1 linux 上收的形状 → 固定的那条命令（tag 恰带一个 v）', () => {
    for (const [version, tag] of ACCEPTED) {
      expect(headlessUpdateCommand(version, 'linux'), version).toBe(CMD(tag))
    }
    expect(headlessUpdateCommand('v0.2.13', 'linux')).not.toContain('vv')
  })

  it('HL-UP2 每条收下的命令都合固定的形状：同一个 tag 下载、同一个 tag 安装，不带别的开关', () => {
    for (const [version] of ACCEPTED) {
      const command = headlessUpdateCommand(version, 'linux')
      expect(command, version).not.toBeNull()
      expect(command!, version).toMatch(SHAPE)
      for (const flag of ['--service', '--port', '--lan', '--uninstall', '--dry-run']) {
        expect(command!, `${version} ${flag}`).not.toContain(flag)
      }
    }
  })

  it('HL-UP3 不是 x.y.z[-pre] 的一律 null', () => {
    const rejected = [
      '',
      'latest',
      '1.2',
      '1.2.3.4',
      '1.2.3-',
      '1.2.3+build.5',
      'V1.2.3',
      'vv1.2.3',
      ' 1.2.3',
      '1.2.3 ',
      '1.2.3\n',
      '1.2.3\nrm -rf ~',
      '\uFF11.2.3',
      '1.2.3-\u03B2',
      '1.2.3-$(id)',
      '1.2.3-`id`',
      '1.2.3&&id',
      '1.2.3-beta|sh'
    ]
    const SHELL_CHARS = [
      ';',
      '|',
      '&',
      '$',
      '`',
      "'",
      '"',
      '\\',
      '<',
      '>',
      '(',
      ')',
      '{',
      '}',
      '*',
      '?',
      '!',
      '~',
      '#',
      ' ',
      '\t',
      '\r',
      '\n'
    ]
    for (const c of SHELL_CHARS) rejected.push(`1.2.3-a${c}b`, `${c}1.2.3`, `1.2.3${c}`)
    expect(rejected).toContain('1.2.3-a;b')
    for (const version of rejected) {
      expect(headlessUpdateCommand(version, 'linux'), JSON.stringify(version)).toBeNull()
    }
  })

  it('HL-UP4 不是 linux：合法版本号也 → null', () => {
    for (const platform of ['darwin', 'win32', 'freebsd'] as const) {
      for (const [version] of ACCEPTED) {
        expect(headlessUpdateCommand(version, platform), `${platform} ${version}`).toBeNull()
      }
    }
  })

  it('HL-UP5 缺省平台 = process.platform', () => {
    setPlatform('linux')
    expect(headlessUpdateCommand('0.2.13')).toBe(CMD('v0.2.13'))
    setPlatform('darwin')
    expect(headlessUpdateCommand('0.2.13')).toBeNull()
  })

  it('HL-UP6 headlessUpdateError：Error、code headless、固定措辞、每次新的对象', () => {
    const error = headlessUpdateError()
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('headless')
    expect(error.message).toBe(
      'ShuviX is running headless and does not install updates itself. Update it on the computer running it (on Linux: rerun install-linux.sh).'
    )
    const again = headlessUpdateError()
    expect(again).not.toBe(error)
    expect(again.message).toBe(error.message)
    expect(again.code).toBe('headless')
  })
})
