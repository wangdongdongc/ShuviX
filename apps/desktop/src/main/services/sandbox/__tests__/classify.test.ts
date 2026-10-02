/**
 * 沙箱拒绝的说明（classify.ts）—— 纯函数：命令失败后，输出里的拒绝能对上沙箱规则才说话。
 *
 * 2026-10-01 起沙箱只把命令的文件访问收进本会话的目录：家目录里只有可读根（会话目录、只读会话目录、
 * 授权、ShuviX 自己的程序）与 cli-token 可读，可写的只有会话目录与写授权。所以：
 *
 *  - CL-1 成功 / 被杀的命令什么都不说；
 *  - CL-2 说明的形状：开头、条目、末尾两句（能 / 不能越界时各一句）；
 *  - CL-3 对得上规则的拒绝：带写入迹象、落在可写根以外的 → cannot write（家目录里外都是）；家目录里
 *    可读根以外、没有写入迹象的 → cannot read（那里既不可读也不可写，看行里的迹象说是哪一样）；
 *    措辞与引号变体、去重与封顶；
 *  - CL-4 对不上规则的 EPERM（会话目录里、授权里、家目录以外的读……）什么都不说；
 *  - CL-5 输出里没有路径、但沙箱一定会拦的几类事（签名）；
 *  - CL-6 isWriteBlocked / isReadBlocked 与 profile 同义；
 *  - CL-7 路径抽取的缺口（带空格的路径、相对路径、TCC 拒绝的读）；
 *  - FU-13..FU-20 classify 的几处修正（行首的程序名、setuid、启动应用 / AppleScript、末尾的 /）；
 *  - CL-T 说明末尾那句概括的措辞。
 *
 * 夹具规格：工作目录 /Users/u/proj，写授权 ~/.shuvix/widgets/w，读授权 ~/ref，勾选的知识库 ~/.shuvix/knowledge/b，
 * 只读的技能目录 ~/.shuvix/skills，ShuviX 自己的程序在 ~/dev/ShuviX/out/main（开发态：在家目录里）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', isPackaged: false } }))

import { explainSandboxDenial, isReadBlocked, isWriteBlocked } from '../classify'
import { buildSandboxSpec, sessionTmpName } from '../spec'
import type { SandboxHostPaths, SandboxSessionInput, SandboxSpec } from '../types'

const HOME = '/Users/u'
const USER_DATA = '/Users/u/Library/Application Support/ShuviX'
const SHUVIX = '/Users/u/.shuvix'
const WS = '/Users/u/proj'
const SID = 'sess-1'
const WIDGET = `${SHUVIX}/widgets/w`
const REF = `${HOME}/ref`
const KB = `${SHUVIX}/knowledge/b`
const SKILLS = `${SHUVIX}/skills`
const APP_DIR = `${HOME}/dev/ShuviX/out/main`
const TMP_ROOT = '/private/tmp/shuvix-501'
const TMP_DIR = `${TMP_ROOT}/${sessionTmpName(SID)}`

const PATHS: SandboxHostPaths = {
  home: HOME,
  userData: USER_DATA,
  shuvixHome: SHUVIX,
  toolResultsBase: `${USER_DATA}/tool_results`,
  uid: 501,
  cliSocket: `${SHUVIX}/cli.sock`,
  cliToken: `${SHUVIX}/cli-token`,
  appPaths: [APP_DIR],
  tmpRoot: TMP_ROOT
}

function specOf(
  over: Partial<SandboxSessionInput> = {},
  paths: SandboxHostPaths = PATHS
): SandboxSpec {
  const result = buildSandboxSpec(
    paths,
    {
      sessionId: SID,
      workingDirectory: WS,
      grantedWrite: [WIDGET],
      grantedRead: [REF],
      extras: { readWrite: [KB], readOnly: [SKILLS] },
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

const HEAD =
  '[sandbox] This command runs confined, and the failure looks like the sandbox refusing it:'
const SUMMARY =
  'Confined commands can read and write only the working directory and $TMPDIR (they can also read system locations outside the home folder); ' +
  'nothing else in the home folder — config files such as ~/.gitconfig, caches, other projects — and no apps, Docker or other local services.'
const ESCALATE =
  'Rerun it with `dangerouslyDisableSandbox: true` — an automatic reviewer checks the command, and the user may be asked to approve.'
const NO_ESCALATE = 'Tell the user what the command needs.'

describe('CL-1 成功 / 被杀的命令什么都不说', () => {
  const noisy = [
    'touch: /private/tmp/x: Operation not permitted',
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

describe('CL-2 说明的形状', () => {
  const LINE = 'touch: /private/tmp/x: Operation not permitted'

  it('CL-2 能越界：开头一行、条目、概括、教模型用 dangerouslyDisableSandbox（逐行钉住）', () => {
    expect(explain(LINE)).toBe(
      [HEAD, '  - cannot write: /private/tmp/x', SUMMARY, ESCALATE].join('\n')
    )
  })

  it('CL-2 不能越界（offerEscalation=false）：末句换成「告诉用户这条命令需要什么」，不提 dangerouslyDisableSandbox', () => {
    const note = explain(LINE, 1, { offerEscalation: false })
    expect(note).toBe([HEAD, '  - cannot write: /private/tmp/x', SUMMARY, NO_ESCALATE].join('\n'))
    expect(note).not.toContain('dangerouslyDisableSandbox')
    expect(note).not.toContain('reviewer')
  })
})

describe('CL-3 对得上规则的拒绝', () => {
  const cases: Array<[string, string, string]> = [
    // 家目录以外、可写根以外（带写入迹象）
    [
      '/private/tmp 不再可写',
      'touch: /private/tmp/x: Operation not permitted',
      'cannot write: /private/tmp/x'
    ],
    [
      '/tmp 写法按 /private/tmp 报',
      'rm: /tmp/x: Operation not permitted',
      'cannot write: /private/tmp/x'
    ],
    [
      '别的会话的临时目录',
      `touch: ${TMP_ROOT}/0000aaaa/x: Operation not permitted`,
      `cannot write: ${TMP_ROOT}/0000aaaa/x`
    ],
    ['外接卷', 'cp: /Volumes/data/x: Operation not permitted', 'cannot write: /Volumes/data/x'],
    [
      '/usr/local/bin（不是系统程序目录）',
      'touch: /usr/local/bin/foo: Operation not permitted',
      'cannot write: /usr/local/bin/foo'
    ],
    ['zsh 重定向报错', 'zsh: operation not permitted: /Volumes/x/y', 'cannot write: /Volumes/x/y'],
    [
      'Permission denied 措辞',
      'bash: /Volumes/x/other3: Permission denied',
      'cannot write: /Volumes/x/other3'
    ],
    [
      'Read-only file system 措辞',
      'touch: /Volumes/x/other2: Read-only file system',
      'cannot write: /Volumes/x/other2'
    ],
    [
      '"…" 引号（git 在家目录以外的 clone 里）',
      'error: unable to write "/private/tmp/r/.git/config": Operation not permitted',
      'cannot write: /private/tmp/r/.git/config'
    ],
    // 家目录里、可读根以外：不可读也不可写 —— 行里有写入的迹象就说写，没有就说读
    [
      '家目录里的写（带写入迹象 → 说写）',
      'touch: /Users/u/other: Operation not permitted',
      'cannot write: /Users/u/other'
    ],
    [
      '~/.shuvix 里的写',
      'touch: /Users/u/.shuvix/x: Operation not permitted',
      'cannot write: /Users/u/.shuvix/x'
    ],
    [
      'shell 重定向写进家目录（bash 前缀算写入迹象）',
      'bash: /Users/u/notes.txt: Operation not permitted',
      'cannot write: /Users/u/notes.txt'
    ],
    [
      '凭据的读',
      'cat: /Users/u/.ssh/id_ed25519: Operation not permitted',
      'cannot read: /Users/u/.ssh/id_ed25519'
    ],
    [
      '个人资料目录的读',
      'cat: /Users/u/Documents/a.txt: Operation not permitted',
      'cannot read: /Users/u/Documents/a.txt'
    ],
    [
      "git 读 ~/.gitconfig（'…' 引号）",
      "fatal: unable to access '/Users/u/.gitconfig': Operation not permitted",
      'cannot read: /Users/u/.gitconfig'
    ],
    [
      '包缓存（npm 的 EPERM）',
      "npm ERR! Error: EPERM: operation not permitted, mkdir '/Users/u/.npm/_cacache'",
      'cannot write: /Users/u/.npm/_cacache'
    ],
    [
      // node 的 `EPERM … open` 算写入迹象（看不出是读还是写地打开）
      "userData 里（node 的 EPERM, open + '…' 引号）",
      "Error: EPERM: operation not permitted, open '/Users/u/Library/Application Support/ShuviX/data/x'",
      `cannot write: ${USER_DATA}/data/x`
    ],
    [
      'userData 里（node 的 EPERM, scandir —— 不是写入迹象）',
      "Error: EPERM: operation not permitted, scandir '/Users/u/Library/Application Support/ShuviX/data'",
      `cannot read: ${USER_DATA}/data`
    ],
    [
      '别的会话的工具结果',
      `cat: ${USER_DATA}/tool_results/other/r.txt: Operation not permitted`,
      `cannot read: ${USER_DATA}/tool_results/other/r.txt`
    ],
    [
      '‘…’ 引号（python PermissionError）',
      'PermissionError: [Errno 1] Operation not permitted: ‘/Users/u/.aws/credentials’',
      'cannot read: /Users/u/.aws/credentials'
    ],
    // 家目录里、可读却不可写的：读授权、只读的技能目录、ShuviX 自己的程序、cli-token
    [
      '读授权里的写',
      'touch: /Users/u/ref/x: Operation not permitted',
      'cannot write: /Users/u/ref/x'
    ],
    [
      '只读技能目录里的写',
      `cp: ${SKILLS}/s/SKILL.md: Operation not permitted`,
      `cannot write: ${SKILLS}/s/SKILL.md`
    ],
    [
      'ShuviX 程序目录里的写',
      `touch: ${APP_DIR}/x: Operation not permitted`,
      `cannot write: ${APP_DIR}/x`
    ],
    [
      'cli-token 的写',
      'bash: /Users/u/.shuvix/cli-token: Operation not permitted',
      'cannot write: /Users/u/.shuvix/cli-token'
    ]
  ]

  it.each(cases)('CL-3 %s', (_label, line, entry) => {
    const note = explain(`some output\n${line}\nmore output`)
    expect(note).not.toBeNull()
    expect(note!.startsWith(HEAD)).toBe(true)
    expect(entries(note)).toEqual([entry])
  })

  it('CL-3 同一路径出现三次只列一次；/tmp 与 /private/tmp 写法算同一条', () => {
    const note = explain(
      [
        'touch: /Users/u/other: Operation not permitted',
        'touch: /Users/u/other: Operation not permitted',
        'touch: /Users/u/other: Operation not permitted',
        'mkdir: /tmp/q/x: Operation not permitted',
        'mkdir: /private/tmp/q/x: Operation not permitted'
      ].join('\n')
    )
    expect(entries(note)).toEqual([
      'cannot write: /Users/u/other',
      'cannot write: /private/tmp/q/x'
    ])
  })

  it('CL-3 末尾的 / 去掉', () => {
    expect(entries(explain('mkdir: /Volumes/x/other/: Operation not permitted'))).toEqual([
      'cannot write: /Volumes/x/other'
    ])
  })

  it('CL-3 七个不同的被拦路径 → 只列前五个', () => {
    const lines = [1, 2, 3, 4, 5, 6, 7].map(
      (i) => `touch: /private/tmp/other${i}: Operation not permitted`
    )
    expect(entries(explain(lines.join('\n')))).toEqual(
      [1, 2, 3, 4, 5].map((i) => `cannot write: /private/tmp/other${i}`)
    )
  })
})

describe('CL-4 不是沙箱拦的 → null', () => {
  it.each([
    ['工作目录里的文件', 'touch: /Users/u/proj/src/a.ts: Operation not permitted'],
    // git 元数据不再受保护：工作目录里的 .git/hooks、.git/config 都可写
    ['工作目录里的 git hooks', '/Users/u/proj/.git/hooks/pre-commit: Operation not permitted'],
    [
      '工作目录里的 .git/config（大小写不同）',
      'fatal: cannot lock /Users/u/proj/.GIT/config: EPERM'
    ],
    [
      'git 打印的相对路径（落在工作目录里）',
      'error: could not lock config file .git/config: Operation not permitted'
    ],
    ['工作目录顶层的 .vscode', 'cp: /Users/u/proj/.vscode/settings.json: Operation not permitted'],
    ['本会话临时目录', `touch: ${TMP_DIR}/x: Operation not permitted`],
    ['本会话 artifacts', `touch: ${SHUVIX}/artifacts/${SID}/f: Operation not permitted`],
    ['本会话工具结果（写）', `touch: ${USER_DATA}/tool_results/${SID}/x: Operation not permitted`],
    ['本会话工具结果（读）', `cat: ${USER_DATA}/tool_results/${SID}/x: Operation not permitted`],
    ['勾选的知识库（写）', `touch: ${KB}/a.md: Operation not permitted`],
    ['写授权里', `touch: ${WIDGET}/f: Operation not permitted`],
    ['读授权的读', 'cat: /Users/u/ref/a.txt: Operation not permitted'],
    ['只读技能目录的读', `cat: ${SKILLS}/s/SKILL.md: Operation not permitted`],
    ['ShuviX 程序目录的读', `cat: ${APP_DIR}/cli.js: Operation not permitted`],
    ['cli-token 的读', 'cat: /Users/u/.shuvix/cli-token: Operation not permitted'],
    [
      '家目录以外的读（TCC 之类，读类工具）',
      'cat: /Volumes/Ext/notes.txt: Operation not permitted'
    ],
    ['被拦的路径、但行里没有 EPERM 措辞', 'touch: /private/tmp/x: No such file or directory']
  ])('CL-4 %s', (_label, line) => {
    expect(explain(line)).toBeNull()
  })

  it('CL-4 工作目录在 ~/Documents/proj：那里的读写都不拦', () => {
    const spec = specOf({ workingDirectory: `${HOME}/Documents/proj` })
    expect(
      explain('touch: /Users/u/Documents/proj/x: Operation not permitted', 1, { spec })
    ).toBeNull()
    expect(
      explain('cat: /Users/u/Documents/proj/x: Operation not permitted', 1, { spec })
    ).toBeNull()
  })

  it('CL-4 家目录以外、不带写入迹象的 EPERM（cat 一个不可写的位置）不说：读不受限', () => {
    expect(explain('cat: /private/tmp/x: Operation not permitted')).toBeNull()
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
    expect(note!.startsWith(HEAD)).toBe(true)
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

  it('CL-5 签名与路径条目一起出现：路径条目在前、原因在后', () => {
    const note = explain(
      [
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
        'touch: /private/tmp/x: Operation not permitted'
      ].join('\n')
    )
    expect(entries(note)).toEqual([
      'cannot write: /private/tmp/x',
      expect.stringContaining('Docker daemon')
    ])
  })
})

describe('CL-6 isWriteBlocked / isReadBlocked 与 profile 同义', () => {
  it.each([
    // [路径, 写被拦, 读被拦]
    [`${WS}/src/a.ts`, false, false],
    [`${WS}/.git/hooks/pre-commit`, false, false],
    [`${TMP_DIR}/x`, false, false],
    [`${SHUVIX}/artifacts/${SID}/f`, false, false],
    [`${USER_DATA}/tool_results/${SID}/x`, false, false],
    [`${KB}/a.md`, false, false],
    [`${WIDGET}/f`, false, false],
    [`${REF}/a.txt`, true, false],
    [`${SKILLS}/s/SKILL.md`, true, false],
    [`${APP_DIR}/cli.js`, true, false],
    [`${SHUVIX}/cli-token`, true, false],
    // cli-token 是一个文件，不是根：它旁边与它「里面」都不可读
    [`${SHUVIX}/cli-token2`, true, true],
    [`${SHUVIX}/cli-token/x`, true, true],
    [`${SHUVIX}/artifacts/other/f`, true, true],
    [`${SHUVIX}/knowledge/other/a.md`, true, true],
    [`${SHUVIX}/policies/p.md`, true, true],
    [`${USER_DATA}/data/db`, true, true],
    [`${USER_DATA}/tool_results/other/r.txt`, true, true],
    [`${HOME}/.ssh/config`, true, true],
    [`${HOME}/.gitconfig`, true, true],
    [`${HOME}/.npm/x`, true, true],
    [`${HOME}/Documents/a.txt`, true, true],
    // 上级目录只放行元数据：照旧算拦下（输出里出现它只可能是列内容被拒）
    [HOME, true, true],
    [SHUVIX, true, true],
    // 家目录以外：读不受限，写只在会话目录与写授权里
    ['/etc/hosts', true, false],
    ['/private/tmp/x', true, false],
    ['/tmp/x', true, false],
    [`${TMP_ROOT}/0000aaaa/x`, true, false],
    ['/Volumes/x', true, false],
    ['/', true, false]
  ] as const)('CL-6 %s：写被拦 %s、读被拦 %s', (path, write, read) => {
    expect(isWriteBlocked(SPEC, path)).toBe(write)
    expect(isReadBlocked(SPEC, path)).toBe(read)
  })

  it('CL-6 写法对齐：/tmp、/var、/etc 按真实路径比；末尾的 / 不影响', () => {
    const spec = specOf({ workingDirectory: '/private/tmp/ws' })
    expect(isWriteBlocked(spec, '/tmp/ws/a')).toBe(false)
    expect(isWriteBlocked(spec, '/tmp/ws/')).toBe(false)
    expect(isWriteBlocked(spec, '/tmp/other')).toBe(true)
    const varSpec = specOf({ workingDirectory: '/private/var/folders/x/ws' })
    expect(isWriteBlocked(varSpec, '/var/folders/x/ws/a')).toBe(false)
  })

  it('CL-6 e2e 布局：家目录在 /private/tmp 里 —— 家目录里的读被拦，/private/tmp 别处的读不拦', () => {
    const e2eHome = '/private/tmp/shuvix-e2e-x'
    const e2e = specOf(
      { workingDirectory: `${e2eHome}/proj`, grantedWrite: [], grantedRead: [], extras: undefined },
      {
        ...PATHS,
        home: e2eHome,
        userData: `${e2eHome}/Library/Application Support/ShuviX`,
        shuvixHome: `${e2eHome}/.shuvix`,
        toolResultsBase: `${e2eHome}/Library/Application Support/ShuviX/tool_results`,
        cliSocket: `${e2eHome}/.shuvix/cli.sock`,
        cliToken: `${e2eHome}/.shuvix/cli-token`,
        appPaths: []
      }
    )
    expect(isReadBlocked(e2e, `${e2eHome}/notes.txt`)).toBe(true)
    expect(isReadBlocked(e2e, '/tmp/shuvix-e2e-x/notes.txt')).toBe(true)
    expect(isReadBlocked(e2e, `${e2eHome}/proj/a`)).toBe(false)
    expect(isReadBlocked(e2e, '/private/tmp/other')).toBe(false)
    expect(isWriteBlocked(e2e, `${e2eHome}/.shuvix/x`)).toBe(true)
    expect(isWriteBlocked(e2e, `${e2eHome}/.shuvix/artifacts/${SID}/f`)).toBe(false)
  })
})

describe('CL-7 路径抽取的缺口', () => {
  it('CL-7a BSD 工具不加引号、路径带空格：说明里是完整路径（家目录里外都一样）', () => {
    expect(entries(explain(`touch: ${USER_DATA}/x: Operation not permitted`))).toEqual([
      `cannot write: ${USER_DATA}/x`
    ])
    expect(entries(explain(`cat: ${USER_DATA}/x: Operation not permitted`))).toEqual([
      `cannot read: ${USER_DATA}/x`
    ])
    expect(entries(explain('touch: /Volumes/My Disk/x: Operation not permitted'))).toEqual([
      'cannot write: /Volumes/My Disk/x'
    ])
  })

  // FU-13（B1）：裸绝对路径在第一个空格处被截出来的前缀（`/Users/u/Library/Application`、
  // `/Volumes/My`）不再与完整路径并列 —— 只列完整的那条
  it.each([
    ['touch: /Volumes/My Disk/x: Operation not permitted', 'cannot write: /Volumes/My Disk/x'],
    ['/bin/bash: /Volumes/My Disk/x: Operation not permitted', 'cannot write: /Volumes/My Disk/x'],
    ['touch: /Users/u/My Folder/x: Operation not permitted', 'cannot write: /Users/u/My Folder/x'],
    ['cat: /Users/u/My Folder/x: Operation not permitted', 'cannot read: /Users/u/My Folder/x']
  ])('CL-7a FU-13 带空格的裸路径只列完整的一条：%s', (line, entry) => {
    expect(entries(explain(line))).toEqual([entry])
  })

  it('CL-7a FU-13 截断只按行判断：上一行真被拒的 /Volumes/My 照列，与下一行的完整路径按出现顺序', () => {
    const note = explain(
      [
        'touch: /Volumes/My: Operation not permitted',
        'touch: /Volumes/My Disk/x: Operation not permitted'
      ].join('\n')
    )
    expect(entries(note)).toEqual(['cannot write: /Volumes/My', 'cannot write: /Volumes/My Disk/x'])
  })

  it('CL-7b 相对路径按工作目录解析：../sibling/x 落在家目录里（写 → cannot write，读 → cannot read）；工作目录里的相对路径不说', () => {
    expect(entries(explain('touch: ../sibling/x: Operation not permitted'))).toEqual([
      'cannot write: /Users/u/sibling/x'
    ])
    expect(entries(explain('cat: ../sibling/x: Operation not permitted'))).toEqual([
      'cannot read: /Users/u/sibling/x'
    ])
    expect(explain('/bin/bash: .git/hooks/pre-commit: Operation not permitted')).toBeNull()
  })

  it('CL-7c TCC 拒绝的读（家目录以外、读类工具前缀）→ null，不去教模型申请完全访问', () => {
    expect(explain('ls: /Volumes/Ext: Operation not permitted')).toBeNull()
    expect(explain('cat: /Volumes/Ext/notes.txt: Operation not permitted')).toBeNull()
  })

  it('CL-7c 家目录里同样的读类报错：现在就是沙箱拦的（家目录里可读根以外都不可读）', () => {
    expect(entries(explain(`ls: ${HOME}/Library/Safari: Operation not permitted`))).toEqual([
      `cannot read: ${HOME}/Library/Safari`
    ])
  })
})

/** B3 的原因条目（系统程序目录里的 EPERM = 沙箱里执行 setuid 程序被拒） */
const SETUID_REASON = 'running sudo or another setuid program'
/** B4 的原因条目 */
const APPS_REASON = 'opening apps or sending AppleScript'

describe('FU-14 (B2) 行首的程序名不是被拒的对象', () => {
  it.each([
    ['/bin/bash: /Users/u/.zshrc: Operation not permitted', 'cannot write: /Users/u/.zshrc'],
    ['/bin/bash: line 1: /Volumes/x/y: Operation not permitted', 'cannot write: /Volumes/x/y'],
    [
      '/usr/bin/touch: /private/tmp/other: Operation not permitted',
      'cannot write: /private/tmp/other'
    ]
  ])('FU-14 %s → 只列被拒的对象', (line, entry) => {
    // 恰好这一条：没有 /bin/bash、/usr/bin/touch，也没有（B3 会给系统程序目录的）setuid 原因
    expect(entries(explain(line))).toEqual([entry])
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
    expect(entries(explain(line))).toEqual([expect.stringContaining(SETUID_REASON)])
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
    expect(entries(explain(line))).toEqual([expect.stringContaining(APPS_REASON)])
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
        'mkdir: /tmp/q/x/: Operation not permitted',
        'mkdir: /tmp/q/x: Operation not permitted'
      ].join('\n')
    )
    expect(entries(note)).toEqual(['cannot write: /private/tmp/q/x'])
  })

  it('FU-20 连续好几个 / 也去掉', () => {
    expect(entries(explain('mkdir: /Volumes/x/other//: Operation not permitted'))).toEqual([
      'cannot write: /Volumes/x/other'
    ])
  })

  it('FU-20 五个不同的被拦路径、各跟一个带 / 的孪生：五个都列出（孪生不占名额）', () => {
    const lines = [1, 2, 3, 4, 5].flatMap((i) => [
      `mkdir: /private/tmp/other${i}: Operation not permitted`,
      `mkdir: /private/tmp/other${i}/: Operation not permitted`
    ])
    expect(entries(explain(lines.join('\n')))).toEqual(
      [1, 2, 3, 4, 5].map((i) => `cannot write: /private/tmp/other${i}`)
    )
  })

  it('FU-20 工作目录里的 sub/ → 仍然 null', () => {
    expect(explain('touch: /Users/u/proj/sub/: Operation not permitted')).toBeNull()
  })
})

describe('CL-T 说明末尾那句概括', () => {
  it('CL-T 概括说范围：只有工作目录与 $TMPDIR、家目录以外可读、家目录里别的都不行（举 ~/.gitconfig、缓存）、没有应用 / Docker', () => {
    for (const offerEscalation of [true, false]) {
      const note = explain('touch: /private/tmp/x: Operation not permitted', 1, { offerEscalation })
      const summary = note!.split('\n').find((l) => l.startsWith('Confined commands'))
      expect(summary).toBe(SUMMARY)
      expect(summary).toContain('working directory and $TMPDIR')
      expect(summary).toContain('outside the home folder')
      expect(summary).toContain('~/.gitconfig')
    }
  })

  it('CL-T 不再提已经不成立的东西：凭据清单、git hooks、ShuviX 自己的文件、包缓存可写、「改在工作目录里做」', () => {
    for (const offerEscalation of [true, false]) {
      const note = explain(
        'touch: /private/tmp/x: Operation not permitted\ncat: /Users/u/.ssh/id: Operation not permitted',
        1,
        { offerEscalation }
      )
      expect(note).not.toMatch(
        /credential|git hooks|ShuviX's own files|package[- ]manager caches|\/tmp,|inside the working directory instead/i
      )
    }
  })
})
