/**
 * 沙箱拒绝的说明（classify.ts）—— 纯函数：命令失败后，输出里的拒绝能对上沙箱规则才说话。
 *
 *  - CL-1 成功 / 被杀的命令什么都不说；
 *  - CL-2/CL-3 对得上规则的拒绝：说明的形状、各类被拦的位置、措辞与引号变体、去重与封顶；
 *  - CL-4 对不上规则的 EPERM（工作区里、tmp 里、放回的位置……）什么都不说；
 *  - CL-5 输出里没有路径、但沙箱一定会拦的几类事（签名）；
 *  - CL-6 isWriteBlocked / isReadBlocked / writeBlockReason 与 profile 的层同义；
 *  - CL-7 计划时的缺口（带空格的路径、git 打印的相对路径、TCC 拒绝的读）——实现已跟进，这里钉住；
 *  - FU-13..FU-20 跟进（classify 的五处修正）：带空格的裸路径只列完整的那条（B1）、行首的程序名不是
 *    被拒的对象（B2）、系统程序目录里的 EPERM 是 setuid 被拒（B3，读类工具除外）、启动应用 /
 *    AppleScript 的签名（B4）、末尾的 / 不占名额（B5）。
 *
 * 夹具规格：工作区 /Users/u/proj，一个写授权 ~/.shuvix/widgets/w。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', isPackaged: false } }))

import { explainSandboxDenial, isReadBlocked, isWriteBlocked, writeBlockReason } from '../classify'
import { buildSandboxSpec } from '../spec'
import type { SandboxHostPaths, SandboxSessionInput, SandboxSpec } from '../types'

const HOME = '/Users/u'
const USER_DATA = '/Users/u/Library/Application Support/ShuviX'
const SHUVIX = '/Users/u/.shuvix'
const WS = '/Users/u/proj'
const WIDGET = `${SHUVIX}/widgets/w`

const PATHS: SandboxHostPaths = {
  home: HOME,
  userData: USER_DATA,
  shuvixHome: SHUVIX,
  uid: 501,
  cliSocket: `${SHUVIX}/cli.sock`,
  tmpRoot: '/private/tmp/shuvix-501'
}

function specOf(
  over: Partial<SandboxSessionInput> = {},
  paths: SandboxHostPaths = PATHS
): SandboxSpec {
  const result = buildSandboxSpec(
    paths,
    {
      sessionId: 'sess-1',
      workingDirectory: WS,
      grantedWrite: [WIDGET],
      grantedRead: [],
      ...over
    },
    (p) => p
  )
  if (!result.ok) throw new Error(result.reason)
  return result.spec
}

const SPEC = specOf()

function explain(
  outputTail: string,
  exitCode: number | null = 1,
  opts: { spec?: SandboxSpec; offerEscalation?: boolean } = {}
): string | null {
  return explainSandboxDenial({
    spec: opts.spec ?? SPEC,
    outputTail,
    exitCode,
    offerEscalation: opts.offerEscalation ?? true
  })
}

/** 说明里列出来的条目（`  - ` 开头的行） */
const entries = (note: string | null): string[] =>
  (note ?? '')
    .split('\n')
    .filter((l) => l.startsWith('  - '))
    .map((l) => l.slice(4))

describe('CL-1 成功 / 被杀的命令什么都不说', () => {
  const noisy = [
    'touch: /Users/u/.shuvix/x: Operation not permitted',
    'cat: /Users/u/.ssh/id_ed25519: Operation not permitted',
    'LSOpenURLsWithRole() failed with error -10827',
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    'sandbox-exec: sandbox_apply: Operation not permitted',
    'sudo: effective uid is not 0'
  ].join('\n')

  it.each([0, null])('CL-1 退出码 %s → null（输出里什么都有也不说）', (code) => {
    expect(explain(noisy, code)).toBeNull()
  })
})

describe('CL-2 写入被拒的说明', () => {
  const LINE = 'touch: /Users/u/.shuvix/x: Operation not permitted'

  it('CL-2 [sandbox] 开头、列出被拦的路径、教模型用 dangerouslyDisableSandbox', () => {
    const note = explain(LINE)
    expect(note).not.toBeNull()
    expect(note!.startsWith('[sandbox]')).toBe(true)
    expect(entries(note)).toEqual(['cannot write: /Users/u/.shuvix/x'])
    expect(note).toContain('dangerouslyDisableSandbox')
    expect(note).not.toContain('tell the user what the command needs')
  })

  it('CL-2 offerEscalation=false：不提 dangerouslyDisableSandbox，改说「告诉用户这条命令需要什么」', () => {
    const note = explain(LINE, 1, { offerEscalation: false })
    expect(note).not.toBeNull()
    expect(note).not.toContain('dangerouslyDisableSandbox')
    expect(note).toContain('tell the user what the command needs')
  })
})

describe('CL-3 各类被拦的位置 + 说明的形状 + 去重 / 封顶', () => {
  const cases: Array<[string, string, string]> = [
    [
      '可写根之外（带写入迹象）',
      'touch: /Users/u/other: Operation not permitted',
      'cannot write: /Users/u/other'
    ],
    [
      '工作区顶层的 .vscode',
      'cp: /Users/u/proj/.vscode/settings.json: Operation not permitted',
      'cannot write: /Users/u/proj/.vscode/settings.json'
    ],
    [
      // FU-16：只有路径的一行 —— 行首那段后面没有别的 `…: <EPERM 短语>`，它就是被拒的路径，不是程序名
      'git hooks（只有路径的一行）',
      '/Users/u/proj/.git/hooks/pre-commit: Operation not permitted',
      'cannot write: /Users/u/proj/.git/hooks/pre-commit'
    ],
    [
      'git hooks（cp 报的）',
      'cp: /Users/u/proj/.git/hooks/pre-commit: Operation not permitted',
      'cannot write: /Users/u/proj/.git/hooks/pre-commit'
    ],
    [
      'git hooks（shell 重定向报的相对路径 → 按工作区解析）',
      '/bin/bash: .git/hooks/pre-commit: Operation not permitted',
      'cannot write: /Users/u/proj/.git/hooks/pre-commit'
    ],
    [
      '.GIT/config（大小写不敏感）+ EPERM 措辞',
      'fatal: cannot lock /Users/u/proj/.GIT/config: EPERM',
      'cannot write: /Users/u/proj/.GIT/config'
    ],
    [
      '~/.zshrc（shell 重定向报错）',
      'zsh: operation not permitted: /Users/u/.zshrc',
      'cannot write: /Users/u/.zshrc'
    ],
    [
      'ssh 控制 socket 目录（按 /private/tmp 报）',
      'mkdir: /tmp/shuvix-ssh-501/x: Operation not permitted',
      'cannot write: /private/tmp/shuvix-ssh-501/x'
    ],
    [
      'launchd 临时目录',
      'touch: /private/tmp/com.apple.launchd.x/y: Operation not permitted',
      'cannot write: /private/tmp/com.apple.launchd.x/y'
    ],
    [
      '个人资料目录的读',
      'cat: /Users/u/Documents/a.txt: Operation not permitted',
      'cannot read: /Users/u/Documents/a.txt'
    ],
    [
      '凭据的读',
      'cat: /Users/u/.ssh/id_ed25519: Operation not permitted',
      'cannot read: /Users/u/.ssh/id_ed25519'
    ],
    [
      "userData/data（node 的 EPERM + '…' 引号）",
      "Error: EPERM: operation not permitted, open '/Users/u/Library/Application Support/ShuviX/data/x'",
      `cannot read: ${USER_DATA}/data/x`
    ],
    [
      'Permission denied 措辞',
      'bash: /Users/u/other3: Permission denied',
      'cannot write: /Users/u/other3'
    ],
    [
      'Read-only file system 措辞',
      'touch: /Users/u/other2: Read-only file system',
      'cannot write: /Users/u/other2'
    ],
    [
      '"…" 引号',
      'error: unable to write "/Users/u/proj/.mcp.json": Operation not permitted',
      'cannot write: /Users/u/proj/.mcp.json'
    ],
    [
      '‘…’ 引号（python PermissionError）',
      'PermissionError: [Errno 1] Operation not permitted: ‘/Users/u/Library/Application Support/ShuviX/x’',
      `cannot read: ${USER_DATA}/x`
    ]
  ]

  it.each(cases)('CL-3 %s', (_label, line, entry) => {
    const note = explain(`some output\n${line}\nmore output`)
    expect(note).not.toBeNull()
    expect(note!.startsWith('[sandbox]')).toBe(true)
    expect(entries(note)).toContain(entry)
  })

  it('CL-3 同一路径出现三次只列一次；/tmp 与 /private/tmp 写法算同一条', () => {
    const note = explain(
      [
        'touch: /Users/u/other: Operation not permitted',
        'touch: /Users/u/other: Operation not permitted',
        'touch: /Users/u/other: Operation not permitted',
        'mkdir: /tmp/shuvix-ssh-501/x: Operation not permitted',
        'mkdir: /private/tmp/shuvix-ssh-501/x: Operation not permitted'
      ].join('\n')
    )
    expect(entries(note)).toEqual([
      'cannot write: /Users/u/other',
      'cannot write: /private/tmp/shuvix-ssh-501/x'
    ])
  })

  it('CL-3 末尾的 / 去掉', () => {
    const note = explain('mkdir: /Users/u/other/: Operation not permitted')
    expect(entries(note)).toEqual(['cannot write: /Users/u/other'])
  })

  it('CL-3 七个不同的被拦路径 → 只列前五个', () => {
    const lines = [1, 2, 3, 4, 5, 6, 7].map(
      (i) => `touch: /Users/u/other${i}: Operation not permitted`
    )
    const note = explain(lines.join('\n'))
    expect(entries(note)).toEqual([1, 2, 3, 4, 5].map((i) => `cannot write: /Users/u/other${i}`))
  })
})

describe('CL-4 不是沙箱拦的 → null', () => {
  it.each([
    ['工作区里的文件', 'touch: /Users/u/proj/src/a.ts: Operation not permitted'],
    ['/private/tmp 里', 'touch: /private/tmp/x: Operation not permitted'],
    ['/tmp 写法', 'rm: /tmp/x: Operation not permitted'],
    [
      '本会话自己的 tool_results 的读（放回了）',
      `cat: ${USER_DATA}/tool_results/sess-1/x: Operation not permitted`
    ],
    [
      '工作区之外的 clone 里的 .git/config（git 保护只在 git 根里）',
      'error: could not lock config file /private/tmp/r/.git/config: Operation not permitted'
    ],
    ['被拦的路径、但行里没有 EPERM 措辞', 'touch: /Users/u/.shuvix/x: No such file or directory']
  ])('CL-4 %s', (_label, line) => {
    expect(explain(line)).toBeNull()
  })

  it('CL-4 工作区在 ~/Documents/proj：那里的读写都放回了', () => {
    const spec = specOf({ workingDirectory: `${HOME}/Documents/proj` })
    expect(
      explain('touch: /Users/u/Documents/proj/x: Operation not permitted', 1, { spec })
    ).toBeNull()
    expect(
      explain('cat: /Users/u/Documents/proj/x: Operation not permitted', 1, { spec })
    ).toBeNull()
  })

  it('CL-4 对照：写本会话的 tool_results 确实会被拦（userData 整片拒写、它不是可写根）→ 带写入迹象时照说', () => {
    const note = explain(`touch: ${USER_DATA}/tool_results/sess-1/x: Operation not permitted`)
    expect(entries(note)).toContain(`cannot write: ${USER_DATA}/tool_results/sess-1/x`)
  })
})

describe('CL-5 没有路径的签名', () => {
  it.each([
    [
      'LSOpenURLsWithRole() failed with error -10827 for the file /Applications/Calculator.app.',
      'opening apps or sending AppleScript'
    ],
    [
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      'talking to the Docker daemon'
    ],
    ['sandbox-exec: sandbox_apply: Operation not permitted', 'a tool that tries to sandbox itself'],
    [
      "sudo: effective uid is not 0, is /usr/bin/sudo on a file system with the 'nosuid' option set?",
      'running sudo or another setuid program'
    ]
  ])('CL-5 %s', (line, reason) => {
    const note = explain(line)
    expect(note).not.toBeNull()
    expect(note!.startsWith('[sandbox]')).toBe(true)
    expect(entries(note)).toEqual([expect.stringContaining(reason)])
  })

  it('CL-5 几个签名一起、各出现两次 → 每个原因只说一次', () => {
    const out = [
      'LSOpenURLsWithRole() failed with error -10827',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      'LSOpenURLsWithRole() failed with error -10827',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'
    ].join('\n')
    const listed = entries(explain(out))
    expect(listed).toHaveLength(2)
    expect(listed[0]).toContain('opening apps')
    expect(listed[1]).toContain('Docker daemon')
  })
})

describe('CL-6 isWriteBlocked / isReadBlocked / writeBlockReason 与 profile 的层同义', () => {
  it('CL-6 本会话 artifacts 可写；别的会话的不可写（不在任何根里）', () => {
    expect(isWriteBlocked(SPEC, `${SHUVIX}/artifacts/sess-1/f`)).toBe(false)
    expect(writeBlockReason(SPEC, `${SHUVIX}/artifacts/sess-1/f`)).toBeNull()
    expect(isWriteBlocked(SPEC, `${SHUVIX}/artifacts/other/f`)).toBe(true)
    expect(writeBlockReason(SPEC, `${SHUVIX}/artifacts/other/f`)).toBe('outside')
  })

  it('CL-6 临时工作区会话：工作区里的文件可写（放回），userData 别处不可写', () => {
    const tempWs = `${USER_DATA}/temp_workspace/sess-1`
    const spec = specOf({ workingDirectory: tempWs, grantedWrite: [] })
    expect(isWriteBlocked(spec, `${tempWs}/a.txt`)).toBe(false)
    expect(isWriteBlocked(spec, `${USER_DATA}/x`)).toBe(true)
    expect(writeBlockReason(spec, `${USER_DATA}/x`)).toBe('outside')
  })

  it('CL-6 写授权 ~/.shuvix/widgets/w：里面可写，但根顶层的 .claude 是受保护的位置', () => {
    expect(isWriteBlocked(SPEC, `${WIDGET}/f`)).toBe(false)
    expect(isWriteBlocked(SPEC, `${WIDGET}/.claude/x`)).toBe(true)
    expect(writeBlockReason(SPEC, `${WIDGET}/.claude/x`)).toBe('protected')
  })

  it('CL-6 writeBlockReason 的三种答案：在根外 / 根里受保护（最后一层、正则、git、整片拒写）/ 允许', () => {
    expect(writeBlockReason(SPEC, '/Users/u/other')).toBe('outside')
    expect(writeBlockReason(SPEC, `${WS}/.git/config`)).toBe('protected')
    expect(writeBlockReason(SPEC, `${WS}/.git`)).toBe('protected')
    expect(writeBlockReason(SPEC, '/tmp/shuvix-ssh-501/x')).toBe('protected')
    expect(writeBlockReason(SPEC, '/private/tmp/com.apple.launchd.q/Listeners')).toBe('protected')
    expect(writeBlockReason(SPEC, '/private/tmp/r/.git/config')).toBeNull()
    expect(writeBlockReason(SPEC, `${WS}/.git/info/exclude`)).toBeNull()
    expect(writeBlockReason(SPEC, `${WS}/sub/.vscode/x`)).toBeNull()
    expect(writeBlockReason(SPEC, '/tmp/x')).toBeNull()

    // e2e 布局：家目录落在 /private/tmp 这个根里，~/.shuvix 是「根里的整片拒写」
    const e2eHome = '/private/tmp/shuvix-e2e-x'
    const e2e = specOf(
      { workingDirectory: `${e2eHome}/proj`, grantedWrite: [] },
      {
        ...PATHS,
        home: e2eHome,
        userData: `${e2eHome}/Library/Application Support/ShuviX`,
        shuvixHome: `${e2eHome}/.shuvix`,
        cliSocket: `${e2eHome}/.shuvix/cli.sock`
      }
    )
    expect(writeBlockReason(e2e, `${e2eHome}/.shuvix/x`)).toBe('protected')
    expect(writeBlockReason(e2e, `${e2eHome}/.shuvix/artifacts/sess-1/f`)).toBeNull()
    expect(writeBlockReason(e2e, `${e2eHome}/notes.txt`)).toBeNull()
  })

  it('CL-6 读：最后一层压过放回（读授权 ~/.ssh 也读不到私钥）；个人资料目录经读授权放回', () => {
    const spec = specOf({ grantedRead: [`${HOME}/.ssh`, `${HOME}/Documents/ref`] })
    expect(isReadBlocked(spec, `${HOME}/.ssh/config`)).toBe(true)
    expect(isReadBlocked(spec, `${HOME}/Documents/ref/a.txt`)).toBe(false)
    expect(isReadBlocked(spec, `${HOME}/Documents/other.txt`)).toBe(true)
    expect(isReadBlocked(spec, '/etc/hosts')).toBe(false)
    expect(isReadBlocked(spec, `${SHUVIX}/.session-state/k`)).toBe(true)
    expect(isReadBlocked(spec, `${SHUVIX}/cli-token`)).toBe(false)
    expect(isReadBlocked(spec, `${USER_DATA}/data/db`)).toBe(true)
    expect(isReadBlocked(spec, `${USER_DATA}/tool_results/sess-1/r.txt`)).toBe(false)
    expect(isReadBlocked(spec, `${USER_DATA}/tool_results/other/r.txt`)).toBe(true)
  })
})

describe('CL-7 计划时的缺口（实现已跟进）', () => {
  it('CL-7a BSD 工具不加引号、路径带空格：说明里是完整路径', () => {
    const note = explain(`touch: ${USER_DATA}/x: Operation not permitted`)
    expect(note).not.toBeNull()
    expect(entries(note).some((e) => e.endsWith(`${USER_DATA}/x`))).toBe(true)

    const outside = explain('touch: /Users/u/My Folder/x: Operation not permitted')
    expect(entries(outside)).toContain('cannot write: /Users/u/My Folder/x')
  })

  // FU-13（B1）：裸绝对路径在第一个空格处被截出来的前缀（`/Users/u/Library/Application`、
  // `/Users/u/My`）不再与完整路径并列 —— 只列完整的那条
  it.each([
    'touch: /Users/u/My Folder/x: Operation not permitted',
    '/bin/bash: /Users/u/My Folder/x: Operation not permitted'
  ])('CL-7a FU-13 带空格的裸路径只列完整的一条：%s', (line) => {
    expect(entries(explain(line))).toEqual(['cannot write: /Users/u/My Folder/x'])
  })

  it('CL-7a FU-13 userData（Application Support）下的路径：恰好一条、是完整路径，没有截断的前缀', () => {
    const listed = entries(explain(`touch: ${USER_DATA}/x: Operation not permitted`))
    expect(listed).toHaveLength(1)
    expect(listed[0].endsWith(`${USER_DATA}/x`)).toBe(true)
    expect(listed.some((e) => e.endsWith('/Users/u/Library/Application'))).toBe(false)
  })

  it('CL-7a FU-13 截断只按行判断：上一行真被拒的 /Users/u/My 照列，与下一行的完整路径按出现顺序', () => {
    const note = explain(
      [
        'touch: /Users/u/My: Operation not permitted',
        'touch: /Users/u/My Folder/x: Operation not permitted'
      ].join('\n')
    )
    expect(entries(note)).toEqual([
      'cannot write: /Users/u/My',
      'cannot write: /Users/u/My Folder/x'
    ])
  })

  it('CL-7b git 打印相对于工作区的路径：按工作区解析', () => {
    const note = explain('error: could not lock config file .git/config: Operation not permitted')
    expect(note).not.toBeNull()
    expect(entries(note)).toEqual(['cannot write: /Users/u/proj/.git/config'])
  })

  it('CL-7c TCC 拒绝的读（可写根之外、读类工具前缀）→ null，不去教模型申请完全访问', () => {
    expect(explain('ls: /Volumes/Ext: Operation not permitted')).toBeNull()
    expect(explain(`ls: ${HOME}/Library/Safari2: Operation not permitted`)).toBeNull()
    expect(explain('cat: /Volumes/Ext/notes.txt: Operation not permitted')).toBeNull()
  })
})

/** B3 的原因条目（系统程序目录里的 EPERM = 沙箱里执行 setuid 程序被拒） */
const SETUID_REASON = 'running sudo or another setuid program'
/** B4 的原因条目 */
const APPS_REASON = 'opening apps or sending AppleScript'

describe('FU-14 (B2) 行首的程序名不是被拒的对象', () => {
  it.each([
    ['/bin/bash: /Users/u/.zshrc: Operation not permitted', 'cannot write: /Users/u/.zshrc'],
    [
      '/bin/bash: line 1: /Users/u/.zshrc: Operation not permitted',
      'cannot write: /Users/u/.zshrc'
    ],
    ['/usr/bin/touch: /Users/u/other: Operation not permitted', 'cannot write: /Users/u/other']
  ])('FU-14 %s → 只列被拒的对象', (line, entry) => {
    const listed = entries(explain(line))
    // 恰好这一条：没有 /bin/bash、/usr/bin/touch，也没有（B3 会给系统程序目录的）setuid 原因
    expect(listed).toEqual([entry])
  })

  // bash 的 kill 报错里 EPERM 短语前是 ` - ` 而不是 `: `：行首的 `/bin/bash` 照样是程序名，不能被读成
  // 系统程序目录里被拒的路径（那会给出 setuid 的原因、教模型申请完全访问）。被拒的是跨沙箱实例发信号，
  // 说明指向宿主代停
  it.each([
    '/bin/bash: line 1: kill: (-12345) - Operation not permitted',
    '/bin/bash: line 0: kill: (12345) - Operation not permitted',
    'bash: line 1: kill: (-12345) - Operation not permitted'
  ])('FU-14 %s → 只给「跨命令发信号」的原因，指向 shuvix task stop', (line) => {
    const note = explain(line)
    expect(note).not.toBeNull()
    expect(note).toContain('shuvix task stop <pid>')
    expect(note).not.toContain('setuid')
    expect(entries(note).filter((e) => e.startsWith('cannot'))).toEqual([])
  })
})

describe('FU-15 (B3) 系统程序目录里的 EPERM = setuid 被拒', () => {
  it.each([
    '/bin/bash: /bin/ps: Operation not permitted',
    '/bin/bash: line 1: /usr/bin/top: Operation not permitted',
    'env: /usr/sbin/x: Operation not permitted',
    'sh: /sbin/x: Operation not permitted',
    '/bin/bash: /usr/libexec/x: Operation not permitted',
    '/bin/bash: /System/Library/x: Operation not permitted'
  ])('FU-15 %s → 只有 setuid 的原因，不说 cannot write', (line) => {
    const note = explain(line)
    expect(note).not.toBeNull()
    // 恰好这一条原因：没有 `cannot write: /bin/ps` 这类条目
    expect(entries(note)).toEqual([expect.stringContaining(SETUID_REASON)])
  })

  it('FU-15 边界：/usr/local/bin 不是系统程序目录 → 照常 cannot write', () => {
    expect(entries(explain('touch: /usr/local/bin/foo: Operation not permitted'))).toEqual([
      'cannot write: /usr/local/bin/foo'
    ])
  })

  it('FU-15 sudo 的签名 + 两条系统程序 EPERM → setuid 的原因只说一次', () => {
    const note = explain(
      [
        "sudo: effective uid is not 0, is /usr/bin/sudo on a file system with the 'nosuid' option set?",
        '/bin/bash: /bin/ps: Operation not permitted',
        '/bin/bash: /usr/bin/top: Operation not permitted'
      ].join('\n')
    )
    expect(entries(note)).toEqual([expect.stringContaining(SETUID_REASON)])
  })
})

describe('FU-17 (B3) 读类工具在 /System 下被拒不是 setuid', () => {
  // `find /` 这类命令不套沙箱也会打出这样的行：说成 setuid 只会教模型去申请它不需要的完全访问
  it.each([
    'find: /System/Volumes/Data/.Spotlight-V100: Operation not permitted',
    'ls: /usr/libexec/x: Operation not permitted',
    'du: /System/Library/x: Operation not permitted'
  ])('FU-17 %s → null', (line) => {
    expect(explain(line)).toBeNull()
  })
})

describe('FU-18 (B4) 启动应用 / AppleScript 的签名', () => {
  const SIGNATURES = [
    "Unable to find application named 'Calculator'",
    '0:36: execution error: Not authorized to send Apple events to Finder. (-1743)',
    'execution error: An error of type -600 has occurred. (-600)',
    'execution error: Connection is invalid. (-10827)'
  ]

  it.each(SIGNATURES)('FU-18 单独一行 %s → 恰好一条「启动应用」的原因', (line) => {
    const note = explain(line)
    expect(note).not.toBeNull()
    expect(entries(note)).toEqual([expect.stringContaining(APPS_REASON)])
  })

  it('FU-18 四条签名 + LSOpenURLsWithRole → 仍然只有一条', () => {
    const out = [
      ...SIGNATURES,
      'LSOpenURLsWithRole() failed with error -10827 for the file /Applications/Calculator.app.'
    ].join('\n')
    expect(entries(explain(out))).toEqual([expect.stringContaining(APPS_REASON)])
  })

  it.each([
    ['普通的脚本错误（-2753）', '26:40: execution error: The variable x is not defined. (-2753)'],
    ['没有 execution error: 的 -600', 'error -600']
  ])('FU-18 反例：%s → null', (_label, line) => {
    expect(explain(line)).toBeNull()
  })

  it('FU-18 反例：-1743 那一行、但命令退出 0 → null', () => {
    expect(
      explain('0:36: execution error: Not authorized to send Apple events to Finder. (-1743)', 0)
    ).toBeNull()
  })

  // FU-19 的决定：osascript 在沙箱里实报的 -1728（Can't get application）刻意不算签名 ——
  // 一个裸的 -1728 也是普通脚本错误（对象不存在），认它会把用户自己的脚本错误说成沙箱拦的
  it('FU-19 osascript 的 -1728 不是签名 → null（刻意：与普通 AppleScript 错误分不开）', () => {
    expect(
      explain(
        '0:40: execution error: Can’t get application "Finder". (-1728)\n26:31: execution error: Can\'t get item 1 of {}. (-1728)'
      )
    ).toBeNull()
  })
})

describe('FU-20 (B5) 末尾的 /', () => {
  it('FU-20 带 / 与不带 / 的同一路径只列一次（按 /private/tmp 报）', () => {
    const note = explain(
      [
        'mkdir: /tmp/shuvix-ssh-501/x/: Operation not permitted',
        'mkdir: /tmp/shuvix-ssh-501/x: Operation not permitted'
      ].join('\n')
    )
    expect(entries(note)).toEqual(['cannot write: /private/tmp/shuvix-ssh-501/x'])
  })

  it('FU-20 连续好几个 / 也去掉', () => {
    expect(entries(explain('mkdir: /Users/u/other//: Operation not permitted'))).toEqual([
      'cannot write: /Users/u/other'
    ])
  })

  it('FU-20 五个不同的被拦路径、各跟一个带 / 的孪生：五个都列出（孪生不占名额）', () => {
    const lines = [1, 2, 3, 4, 5].flatMap((i) => [
      `mkdir: /Users/u/other${i}: Operation not permitted`,
      `mkdir: /Users/u/other${i}/: Operation not permitted`
    ])
    expect(entries(explain(lines.join('\n')))).toEqual(
      [1, 2, 3, 4, 5].map((i) => `cannot write: /Users/u/other${i}`)
    )
  })

  it('FU-20 工作区里的 sub/ → 仍然 null', () => {
    expect(explain('touch: /Users/u/proj/sub/: Operation not permitted')).toBeNull()
  })
})
