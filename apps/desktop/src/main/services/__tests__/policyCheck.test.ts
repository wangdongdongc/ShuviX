/**
 * `services/policyCheck.ts` —— `shuvix policy check`（2026-10-19）。真实引擎（agent-runtime 的 createSecurityContext +
 * 内置策略原文），只把策略列表、网络状态、网卡表换成夹具：
 *
 *   PC-1  不给文件、只有内置：本机全放、外网全拒（标 network-admission#0）；列出生效的网络策略
 *   PC-2  草稿当作装进去之后算（新文件）：放了手机、漏了笔记本 —— 表上那一行全拒；草稿不影响别的文件
 *   PC-3  草稿顶替同文件名的那份：按草稿算、不按旧的；就是装着的那份 → 写明 installed
 *   PC-4  只读策略：写 / 管理两列拒、标出是哪条规则；读与页面放
 *   PC-5  单个请求：逐个点位列出、结果；--expect 对得上 → 0，对不上 → 1 并说是哪条规则在哪一步拒的
 *   PC-6  通道：分组与读写级别由通道表补；拼错的通道名 → 2、给相近的名字
 *   PC-7  用法错误一律 2、带用法：不认识的参数（列全部）、重复、地址 / 设备 ID 不合法、两个客体、expect ask、
 *         有客体没有发起方、文件不是 .md；--help → 0
 *   PC-8  文件非法 → 2、解析器的原因原样列出
 *   PC-9  另起名字写 network allow 规则、内置准入还在 → 提示改名为 network-admission
 *   PC-10 求值出错的规则：格子标 ERROR、表下列出原因（连本机也拒）
 *   PC-11 --read：socket → /ws → files:read → path（tool files/read），path 规则拒在最后一步
 *   PC-12 本机地址按对端网段挑：subject.localAddress / interface 是那块网卡的
 *   PC-13 设备：cookie 带上设备 ID → subject.device；只放某台设备的策略分得开两台
 *   PC-14 写入回执的那一句（policyCheckHint）：管网络的合法策略才有、带路径；agent 主体的、非法的、不是策略的 → null
 *   PC-15 --scopes：行是 scope、列是设备，格子三档逐条判（全放 = 字母、全拒 = -、部分 = ~ 并列在表下、没有这一档 = .）；
 *         被准入拒掉的设备整列 -、写明拒在哪一步；--scopes 不带请求参数
 *   PC-16 --setting：settings:set 按 key 定 scope 与 access（主题 preferences / write，沙箱 security / admin），
 *         规则按 scope 写就分得开
 */
import { describe, expect, it } from 'vitest'
import type { networkInterfaces } from 'node:os'
import {
  buildBuiltinPolicies,
  createSecurityContext,
  parsePolicyDefinitionFile,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '../../../../../../packages/agent-runtime/src/security/builtinPolicies/inlineSources'
import type { NetworkStatus } from '../../../shared/network'
import {
  runPolicyCheck,
  type PolicyCheckDeps,
  type PolicyCheckParams,
  type PolicyCheckResult
} from '../policyCheck'
import { networkPolicyCheckHint } from '../policyCheckHint'

type Interfaces = ReturnType<typeof networkInterfaces>

const HOME = '/Users/u'
const POLICIES = `${HOME}/.shuvix/policies`
const READ_MD = createInlinePolicyMdReader()
const PHONE = 'PhonePhonePhonePhone01'
const LAPTOP = 'LaptopLaptopLaptopLap2'

const IFACES = {
  en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false, cidr: '192.168.1.5/24' }],
  utun3: [{ address: '10.8.0.2', family: 'IPv4', internal: false, cidr: '10.8.0.2/24' }],
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, cidr: '127.0.0.1/8' }]
} as unknown as Interfaces

type Status = Pick<NetworkStatus, 'port' | 'clients' | 'denials'>

const EMPTY_STATUS: Status = { port: 7766, clients: [], denials: [] }

function status(
  clients: Array<{ address: string; device?: string }>,
  denials: Array<{ address: string; device?: string }> = []
): Status {
  return {
    port: 7766,
    clients: clients.map((c, i) => ({
      id: `ws:${i}`,
      remoteAddress: c.address,
      userAgent: 'Mozilla/5.0',
      device: c.device ?? '',
      connectedAt: 0
    })),
    denials: denials.map((d) => ({
      at: 0,
      lastAt: 0,
      count: 1,
      stage: 'request' as const,
      summary: 'GET /',
      scope: 'app',
      address: d.address,
      device: d.device ?? '',
      rule: 'network-admission#0',
      policies: [],
      downgraded: false
    }))
  }
}

function policyText(name: string, rules: string, scope = '{ subject.kind: [network] }'): string {
  return [
    '---',
    'shuvix: policy v1',
    `name: ${name}`,
    `shuvix-policy-scope: ${scope}`,
    'shuvix-policy-rules:',
    rules,
    '---',
    '',
    'Test policy.',
    ''
  ].join('\n')
}

function userFile(text: string, fileName: string): UserPolicyFile {
  const parsed = parsePolicyDefinitionFile(text, fileName.replace(/\.md$/, ''))
  expect(parsed, text).not.toBeNull()
  return { ...parsed!, fileName }
}

/** 准入：本机 + 给定网段 */
function admission(cidrs: string[]): string {
  const list = ["'127.0.0.0/8'", "'::1'", ...cidrs.map((c) => `'${c}'`)].join(', ')
  return policyText(
    'network-admission',
    [
      '  - effect: deny',
      '    object.type: [request]',
      `    match: "!inCidr(subject.address, [${list}])"`,
      '    prompt: Not on the list.'
    ].join('\n')
  )
}

function deps(
  opts: { users?: UserPolicyFile[]; status?: Status; disabled?: string[] } = {}
): PolicyCheckDeps {
  return {
    policiesDir: POLICIES,
    home: HOME,
    userPolicies: () => opts.users ?? [],
    builtinPolicies: () => buildBuiltinPolicies({ language: 'en', readMd: READ_MD }),
    isDisabled: (policy) => (opts.disabled ?? []).includes(policy.name),
    contextFor: (userPolicies, logger) => (subject) =>
      createSecurityContext(
        subject,
        { host: 'desktop', platform: 'darwin' },
        {
          host: 'desktop',
          pathSep: '/',
          getVars: () => ({ home: HOME }),
          readBuiltinPolicyMd: READ_MD,
          getUserPolicies: () => userPolicies,
          isPolicyDisabled: (policy) => (opts.disabled ?? []).includes(policy.name),
          logger
        }
      ),
    status: () => opts.status ?? EMPTY_STATUS,
    interfaces: () => IFACES
  }
}

function run(params: Partial<PolicyCheckParams>, d: PolicyCheckDeps = deps()): PolicyCheckResult {
  return runPolicyCheck({ flags: [], ...params }, d)
}

/** 表里某一行（按第二列地址找）→ 拆成格子 */
function row(stdout: string, label: string): string {
  const line = stdout.split('\n').find((l) => l.startsWith(label))
  expect(line, `row ${label} in\n${stdout}`).toBeDefined()
  return line!.replace(/\s+/g, ' ').trim()
}

describe('policyCheck', () => {
  it('PC-1 builtin only: this computer in, outside refused by network-admission#0', () => {
    const r = run({})
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Checked the policies in effect now.')
    expect(r.stdout).toContain('Network policies: network-admission (built-in)')
    expect(row(r.stdout, 'this computer')).toBe('this computer 127.0.0.1 allow allow allow allow')
    expect(row(r.stdout, 'outside')).toBe(
      'outside 203.0.113.9 deny deny deny deny ← network-admission#0'
    )
    expect(r.stdout).not.toContain('failed to evaluate')
    expect(r.stdout).not.toContain('Policy engine warnings')
  })

  it('PC-2 a draft checked as if installed: the forgotten laptop shows up refused', () => {
    const r = run(
      {
        file: { path: '/tmp/s1/draft/network-admission.md', text: admission(['192.168.1.23/32']) }
      },
      deps({
        status: status(
          [{ address: '192.168.1.23', device: PHONE }],
          [{ address: '192.168.1.40', device: LAPTOP }]
        )
      })
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(
      'Checked /tmp/s1/draft/network-admission.md as if installed at ~/.shuvix/policies/network-admission.md (a new file there).'
    )
    expect(r.stdout).toContain(
      'Network policies: network-admission (your file network-admission.md)'
    )
    expect(row(r.stdout, 'this computer')).toBe('this computer 127.0.0.1 allow allow allow allow')
    expect(row(r.stdout, 'connected')).toBe(
      `connected ${PHONE.slice(0, 6)}… 192.168.1.23 allow allow allow allow`
    )
    expect(row(r.stdout, 'refused')).toBe(
      `refused ${LAPTOP.slice(0, 6)}… 192.168.1.40 deny deny deny deny ← network-admission#0`
    )
  })

  it('PC-3 the draft replaces the file of the same name; the installed file says so', () => {
    const old = userFile(admission(['192.168.1.0/24']), 'network-admission.md')
    const draft = admission([])
    const r = run(
      { file: { path: '/tmp/draft/network-admission.md', text: draft } },
      deps({ users: [old], status: status([{ address: '192.168.1.23' }]) })
    )
    expect(r.stdout).toContain('(it replaces the file there).')
    // 旧的放整个网段，草稿只放本机 —— 按草稿算
    expect(row(r.stdout, 'connected')).toContain('deny deny deny deny')

    const installed = run(
      { file: { path: `${POLICIES}/network-admission.md`, text: draft } },
      deps({ users: [old] })
    )
    expect(installed.stdout).toContain(
      'Checked ~/.shuvix/policies/network-admission.md (installed).'
    )
  })

  it('PC-4 a read-only policy: write and admin refused by its rule, page and read allowed', () => {
    const readonly = userFile(
      policyText(
        'network-readonly',
        [
          '  - effect: deny',
          '    object.type: [channel]',
          "    match: \"subject.address != '127.0.0.1' && object.access != 'read'\"",
          '    prompt: Read-only.'
        ].join('\n')
      ),
      'network-readonly.md'
    )
    const r = run(
      {},
      deps({
        users: [userFile(admission(['192.168.1.0/24']), 'network-admission.md'), readonly],
        status: status([{ address: '192.168.1.23' }])
      })
    )
    expect(r.stdout).toContain(
      'Network policies: network-admission (your file network-admission.md), network-readonly (your file network-readonly.md)'
    )
    expect(row(r.stdout, 'connected')).toBe(
      'connected 192.168.1.23 allow allow deny deny ← network-readonly#0'
    )
    expect(row(r.stdout, 'this computer')).toBe('this computer 127.0.0.1 allow allow allow allow')
  })

  it('PC-5 one request: every step, the result, and --expect', () => {
    const d = deps({ users: [userFile(admission(['192.168.1.23/32']), 'network-admission.md')] })
    const ok = run(
      {
        flags: [
          ['from', '192.168.1.23'],
          ['expect', 'allow']
        ]
      },
      d
    )
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toContain('Request: 192.168.1.23 → open /')
    expect(ok.stdout).toMatch(/socket\s+allow {2}connect/)
    expect(ok.stdout).toMatch(/request\s+allow {2}GET \//)
    expect(ok.stdout).toMatch(/request\s+allow {2}GET \/ws/)
    expect(ok.stdout).toContain('Result: allow')
    expect(ok.stdout).toContain('As expected (allow).')

    const bad = run(
      {
        flags: [
          ['from', '192.168.1.40'],
          ['expect', 'allow']
        ]
      },
      d
    )
    expect(bad.exitCode).toBe(1)
    expect(bad.stdout).toMatch(/request\s+deny {3}GET \/ — network-admission#0: Not on the list\./)
    expect(bad.stdout).toContain('Result: deny')
    expect(bad.stdout).toContain(
      'NOT as expected: expected allow, got deny — network-admission#0 refused it at the request step.'
    )
  })

  it('PC-6 channels: group and access come from the channel table; a typo gets suggestions', () => {
    const r = run({
      flags: [
        ['from', '127.0.0.1'],
        ['channel', 'settings:set']
      ]
    })
    expect(r.exitCode).toBe(0)
    // 没给 key 的 settings:set 按最严（system + admin）
    expect(r.stdout).toContain('invoke settings:set (group settings, scope system, access admin)')

    const typo = run({
      flags: [
        ['from', '127.0.0.1'],
        ['channel', 'sesion:list']
      ]
    })
    expect(typo.exitCode).toBe(2)
    expect(typo.stderr).toContain("Unknown channel 'sesion:list'. Did you mean session:list")
    expect(typo.stderr).toContain('Usage: shuvix policy check')
  })

  it('PC-7 usage errors exit 2 with the usage; --help exits 0', () => {
    const cases: Array<[Array<[string, string]>, string]> = [
      [
        [['ip', '1.2.3.4']],
        'Unknown option --ip. Options: --from, --device, --page, --channel, --setting, --read, --write, --expect, --scopes, ' +
          '--redaction, --provider, --model, --category, --value, --bot.'
      ],
      [
        [
          ['from', '1.2.3.4'],
          ['from', '1.2.3.5']
        ],
        '--from is given twice'
      ],
      [[['from', 'phone']], "--from must be an IP address such as 192.168.1.23 (got 'phone')."],
      [[['device', 'abc']], '--device must be a ShuviX device ID'],
      [
        [
          ['from', '1.2.3.4'],
          ['page', '/'],
          ['channel', 'session:list']
        ],
        'Give one of --page, --channel, --setting, --read, --write'
      ],
      [
        [
          ['from', '1.2.3.4'],
          ['expect', 'ask']
        ],
        'network checks cannot ask anyone'
      ],
      [[['channel', 'session:list']], 'Say who is asking: --from <ip>'],
      [
        [
          ['from', '1.2.3.4'],
          ['read', 'notes.md']
        ],
        "--read takes an absolute path (got 'notes.md')."
      ]
    ]
    for (const [flags, message] of cases) {
      const r = run({ flags })
      expect(r.exitCode, message).toBe(2)
      expect(r.stderr).toContain(message)
      expect(r.stdout).toBe('')
    }
    const notMd = run({ file: { path: '/tmp/draft.txt', text: admission([]) } })
    expect(notMd.exitCode).toBe(2)
    expect(notMd.stderr).toContain('policy files must end in .md')

    const help = run({ flags: [['help', '']] })
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('Usage: shuvix policy check')
  })

  it('PC-8 an invalid file: exit 2 with the parser reasons', () => {
    const r = run({
      file: {
        path: '/tmp/bad.md',
        text: policyText('bad', '  - effect: deny\n    match: "subject.address ==="')
      }
    })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('/tmp/bad.md is not a valid policy file, so ShuviX would ignore it:')
    expect(r.stderr).toMatch(/^- /m)
  })

  it('PC-9 allow rules under another name while the builtin admission is on → rename hint', () => {
    const text = policyText(
      'lan-devices',
      [
        '  - effect: allow',
        '    object.type: [request]',
        '    match: "inCidr(subject.address, [\'192.168.1.0/24\'])"'
      ].join('\n')
    )
    const r = run(
      { file: { path: '/tmp/lan-devices.md', text } },
      deps({ status: status([{ address: '192.168.1.23' }]) })
    )
    expect(r.stdout).toContain(
      'Note: allow rules cannot override a deny, and the built-in network-admission still refuses every address but this computer.'
    )
    expect(row(r.stdout, 'connected')).toContain('deny deny deny deny ← network-admission#0')
    // 内置准入停用了就不提示
    const off = run(
      { file: { path: '/tmp/lan-devices.md', text } },
      deps({ disabled: ['network-admission'] })
    )
    expect(off.stdout).not.toContain('Note: allow rules')
    expect(off.stdout).toContain('network-admission (built-in, turned off)')
  })

  it('PC-10 a rule that fails to evaluate: ERROR cells and the reason under the table', () => {
    const text = policyText(
      'network-admission',
      [
        '  - effect: deny',
        '    object.type: [request]',
        "    match: \"subject.headers['x-token'] != 'secret'\""
      ].join('\n')
    )
    const r = run({ file: { path: '/tmp/network-admission.md', text } })
    expect(r.exitCode).toBe(0)
    expect(row(r.stdout, 'this computer')).toBe(
      'this computer 127.0.0.1 ERROR ERROR ERROR ERROR ← network-admission#0'
    )
    expect(r.stdout).toContain(
      'Rules that failed to evaluate (a failing deny counts as matched, so it refuses every such request):'
    )
    expect(r.stdout).toMatch(/- security rule 'network-admission#0': match evaluation failed/)
  })

  it('PC-11 --read walks socket, /ws, files:read, then the path with tool files/read', () => {
    const noSecrets = userFile(
      policyText(
        'network-files',
        [
          '  - effect: deny',
          '    object.type: [path]',
          "    match: \"tool.name == 'files' && tool.operation == 'read' && object.path.startsWith('/Users/u/secret')\"",
          '    prompt: No secrets.'
        ].join('\n')
      ),
      'network-files.md'
    )
    const r = run(
      {
        flags: [
          ['from', '127.0.0.1'],
          ['read', '/Users/u/secret/key.txt'],
          ['expect', 'deny']
        ]
      },
      deps({ users: [noSecrets] })
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Request: 127.0.0.1 → read /Users/u/secret/key.txt')
    expect(r.stdout).toMatch(
      /channel\s+allow {2}invoke files:read \(group files, scope files, access read\)/
    )
    expect(r.stdout).toMatch(
      /path\s+deny {3}read \/Users\/u\/secret\/key\.txt — network-files#0: No secrets\./
    )
    expect(r.stdout).toContain('As expected (deny).')
  })

  it('PC-12 the local address is the interface on the peer’s network', () => {
    const viaVpn = userFile(
      policyText(
        'network-admission',
        [
          '  - effect: deny',
          '    object.type: [request]',
          "    match: \"!inCidr(subject.address, ['127.0.0.0/8']) && !(subject.interface == 'utun3' && subject.localAddress == '10.8.0.2')\""
        ].join('\n')
      ),
      'network-admission.md'
    )
    const d = deps({ users: [viaVpn] })
    expect(
      run(
        {
          flags: [
            ['from', '10.8.0.9'],
            ['expect', 'allow']
          ]
        },
        d
      ).exitCode
    ).toBe(0)
    expect(
      run(
        {
          flags: [
            ['from', '192.168.1.23'],
            ['expect', 'deny']
          ]
        },
        d
      ).exitCode
    ).toBe(0)
  })

  it('PC-13 devices: the cookie carries the device ID, so a device-only policy tells two devices apart', () => {
    const phoneOnly = userFile(
      policyText(
        'network-admission',
        [
          '  - effect: deny',
          '    object.type: [request]',
          `    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && subject.device != '${PHONE}'"`
        ].join('\n')
      ),
      'network-admission.md'
    )
    const r = run(
      {},
      deps({
        users: [phoneOnly],
        status: status([
          { address: '192.168.1.23', device: PHONE },
          { address: '192.168.1.40', device: LAPTOP }
        ])
      })
    )
    expect(row(r.stdout, `connected ${PHONE.slice(0, 6)}`)).toContain('allow allow allow allow')
    expect(row(r.stdout, `connected ${LAPTOP.slice(0, 6)}`)).toContain('deny deny deny deny')
    expect(
      run(
        {
          flags: [
            ['device', PHONE],
            ['expect', 'allow']
          ]
        },
        deps({ users: [phoneOnly] })
      ).exitCode
    ).toBe(0)
  })

  /** 局域网的设备只能碰 app / sessions / preferences，且不能删会话 */
  const scoped = userFile(
    policyText(
      'network-admission',
      [
        '  - effect: deny',
        '    object.type: [request]',
        `    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1', '192.168.1.0/24'])"`,
        '  - effect: deny',
        '    object.type: [request, channel]',
        `    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && !(object.scope in ['app', 'sessions', 'preferences'])"`,
        '    prompt: Not this part.',
        '  - effect: deny',
        '    object.type: [channel]',
        `    match: "!inCidr(subject.address, ['127.0.0.0/8', '::1']) && object.channel == 'session:delete'"`
      ].join('\n')
    ),
    'network-admission.md'
  )

  it('PC-15 --scopes: scope × device matrix, every call checked', () => {
    const r = run({ flags: [['scopes', '']] }, deps({ users: [scoped] }))
    expect(r.exitCode, r.stderr).toBe(0)
    const header = r.stdout.split('\n').find((l) => l.includes('this computer'))!
    expect(header).toContain('outside')
    // 本机全放；外网被准入拒掉，整列 -
    expect(row(r.stdout, 'app')).toBe('app rw. --.')
    expect(row(r.stdout, 'security')).toBe('security rwa ---')
    expect(r.stdout).toContain('Refused before any call:')
    expect(r.stdout).toMatch(/- outside: refused at the request step by network-admission#0/)

    const lan = run(
      {
        flags: [
          ['scopes', ''],
          ['from', '192.168.1.23']
        ]
      },
      deps({ users: [scoped] })
    )
    expect(lan.exitCode, lan.stderr).toBe(0)
    expect(row(lan.stdout, 'app')).toBe('app rw.')
    // 会话里 write 部分被拒（session:delete），列在表下；admin 是 settings:set session.*
    expect(row(lan.stdout, 'sessions')).toBe('sessions r~a')
    expect(lan.stdout).toMatch(
      /- 192\.168\.1\.23 · sessions write: 1 of \d+ refused \(network-admission#2\): session:delete/
    )
    expect(row(lan.stdout, 'preferences')).toBe('preferences rwa')
    expect(row(lan.stdout, 'security')).toBe('security ---')
    expect(row(lan.stdout, 'files')).toBe('files --.')
    expect(row(lan.stdout, 'terminal')).toBe('terminal .-.')
    expect(lan.stdout).not.toContain('Refused before any call:')

    const bad = run({
      flags: [
        ['scopes', ''],
        ['channel', 'session:list']
      ]
    })
    expect(bad.exitCode).toBe(2)
    expect(bad.stderr).toContain(
      '--scopes checks every call of every scope; it does not take --channel.'
    )
  })

  it('PC-16 --setting: settings:set takes the scope and access of the key', () => {
    const theme = run(
      {
        flags: [
          ['from', '192.168.1.23'],
          ['setting', 'general.theme'],
          ['expect', 'allow']
        ]
      },
      deps({ users: [scoped] })
    )
    expect(theme.exitCode, theme.stdout).toBe(0)
    expect(theme.stdout).toContain('Request: 192.168.1.23 → change setting general.theme')
    expect(theme.stdout).toContain(
      'invoke settings:set key general.theme (group settings, scope preferences, access write)'
    )
    const sandbox = run(
      {
        flags: [
          ['from', '192.168.1.23'],
          ['setting', 'sandbox.enabled'],
          ['expect', 'deny']
        ]
      },
      deps({ users: [scoped] })
    )
    expect(sandbox.exitCode, sandbox.stdout).toBe(0)
    expect(sandbox.stdout).toContain('scope security, access admin')
    expect(sandbox.stdout).toContain('network-admission#1: Not this part.')
  })

  it('PC-14 the write receipt line: only for a valid policy with network rules, with the path', () => {
    const path = `${POLICIES}/network-admission.md`
    expect(networkPolicyCheckHint(path, admission([]))).toBe(
      'This policy decides network access. Before telling the user it is done, check it: ' +
        `\`shuvix policy check ${path}\` shows which devices get in and what each may do, as if it were installed.`
    )
    const agentOnly = policyText(
      'my-asks',
      ['  - effect: ask', '    action: [write]', '    object.type: [path]'].join('\n'),
      '{ subject.kind: [agent] }'
    )
    expect(networkPolicyCheckHint(`${POLICIES}/my-asks.md`, agentOnly)).toBeNull()
    expect(networkPolicyCheckHint(path, policyText('bad', '  - effect: nope'))).toBeNull()
    expect(networkPolicyCheckHint('/tmp/notes.md', '# notes\n')).toBeNull()
  })
})
