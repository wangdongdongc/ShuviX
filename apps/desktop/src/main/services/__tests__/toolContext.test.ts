/**
 * toolContext —— agentActorOf：本工具实例所属 agent 的 OKF actor 字符串
 * （`shuvix-<profile>/<model>`）。模型惰性取（会话中途换模型也跟得上）；元数据缺失时回落
 * `shuvix-agent/unknown` —— 章要盖，但不能编。dao / 服务 / paths 全部 mock（同 askPolicy.test）。
 *
 * resolveProjectConfig —— 工具每次执行时读的工作目录。口径只有一处（sessionService.getById 的
 * 「项目根 → 无项目会话自带的目录 → 临时工作区」），这里只能照抄它、不能另算：
 *   TC-WD1 项目会话 → getById 给的（即项目根，哪怕 settings 里另有一个目录），envVars 取项目的
 *   TC-WD2 无项目、自带目录 → 那个目录，不去问临时工作区
 *   TC-WD3 无项目、没有自带目录 → getById 给的临时工作区
 *   TC-WD4 会话不存在 → 临时工作区（按 sessionId 取）
 *
 * resolveSessionDocument / isSessionDocument —— 笔记本会话自己那份文档（doc_* 的磁盘回落读写它，write / edit
 * 不许碰它）：settings.notebookPath 按上面那个工作目录解析；比较时跟过链接、按文件系统的大小写规则：
 *   TC-DOC1 不是笔记本会话（notebookPath 缺 / null）→ null；isSessionDocument 恒 false
 *   TC-DOC2 项目会话的相对 notebookPath → <项目根>/<notebookPath>；同一路径与带 `..` 的写法都认，兄弟文件不认
 *   TC-DOC3 绝对 notebookPath → 原样
 *   TC-DOC4 无项目、自带工作目录 → 按那个目录拼
 *   TC-DOC5 会话不存在 → null / false
 *   TC-DOC6 真实临时目录、父目录是符号链接：经链接的写法与真实写法两个方向都认
 *   TC-DOC7 已存在文件的大小写变体 → 认（只在大小写不敏感的文件系统上跑）
 *
 * 会话权限表的宿主胶水（HG-1）：
 *   getVars 的 `aclRead` / `aclWrite` 来自 sessionAcl.pathView(ctx.sessionId)（与命令沙箱的 sandboxEntries
 *     同一张表）—— 外部目录访问策略（ask-on-external-path）的免询问范围与命令实际能碰的范围是同一份。
 *     services/acl 在这里换成可控的替身（表本身的对账 / 授予 / 继承见 acl/__tests__/sessionAcl.test.ts，
 *     派生行见 acl/__tests__/derive.test.ts，旧 allowList 条目的搬迁见 dao/__tests__/migrationV33.test.ts）；
 *     每次评估现取（会话中途「允许并记住」立即可见）；表是空的（会话不在 / 算不出来）→ 两张表都空，
 *     工作区里的写也要问（多问，绝不因此放行）；旧的 sessionDirs / grantedRead 等键不再给。
 *   persistGrant（询问卡片上的「允许并记住」）→ sessionAcl.grantPath(ctx.sessionId, 路径, 读 / 写)。
 *
 * 询问点的自动审查带来的桌面接线（设计稿 docs/permission-review-design.md）：
 *   SEC-9 shuvixConfigDirs —— policies / agents / hooks / skills 四个目录（事实变量：引用它的出厂
 *     protect-shuvix-config 已于 2026-10-01 退役，留给用户自写的策略）；
 *   SEC-10 skillsDirs —— 默认 → 内置 → 外部目录 → 在列的共用目录（~/.claude/skills、~/.agents/skills）；
 *   TC-SUBJ 桌面 subject 带上 ctx.agent 的档案名与 root / spawned（审查员的防递归与用户策略都读它）；
 *   TC-RV onPermissionRequest 每次现取注入的审查者（setPermissionReviewer），被动判定从不走到它。
 *   TC-CC classifyCommand 每次现取注入的命令分类（setCommandClassifier，带上本会话的 sessionId）：
 *     没注入 → null；注入的分类经真实的桌面 SecurityContext 挂成 object.risk，内置 ask-on-command 对
 *     很有把握的 read_only 不问（也不经审查），决策记录带 commandRisk。
 * 需要真实评估的用例读仓库里那份内置策略 md（同 askPolicy.test）；用户策略由 tc.userPolicies 喂。
 * reviewState / 决策日志是进程级表：这些用例各用独立 sessionId，afterEach 清掉。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const tc = vi.hoisted(() => ({
  getById: vi.fn((_id: string): unknown => undefined),
  projectPick: vi.fn((_id: string, _cols: string[]): unknown => undefined),
  pickSettings: vi.fn((_id: string, _keys: string[]): unknown => undefined),
  getTempWorkspace: vi.fn((_sid: string) => '/tmp/shuvix-actor-ws'),
  getSessionArtifactsDir: vi.fn((id: string) => `/tmp/shuvix-artifacts/${id}`),
  /** services/acl 的 sessionAcl.pathView：本会话权限表的可读 / 可写目录（缺省空表；用例按需换） */
  pathView: vi.fn((_sid: string): { read: string[]; write: string[] } => ({ read: [], write: [] })),
  /** services/acl 的 sessionAcl.grantPath：「允许并记住」写进权限表 */
  grantPath: vi.fn((_sid: string, _path: string, _access: 'read' | 'write'): unknown => null),
  /** skillService.listExternalDirs / listSharedDirs：变量表 skillsDirs 的后两段（SEC-10 换） */
  externalSkillDirs: [] as Array<{ name: string; path: string }>,
  sharedSkillDirs: [] as Array<{ name: string; path: string }>,
  /** policyService.getUserPolicies 交出的用户策略（TC-SUBJ2 / TC-RV3 换） */
  userPolicies: [] as UserPolicyFile[],
  // 内置策略的事实源 —— 运行时读随包发布的目录，这里直接读仓库里那一份（同一批文件）。
  // src/main/services/__tests__ 往上六级是仓库根
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: tc.projectPick } }))
vi.mock('../../dao/sessionDao', () => ({ sessionDao: { pickSettings: tc.pickSettings } }))
// 会话权限表换成替身：getVars 读 pathView、persistGrant 写 grantPath（表本身另有单测）
vi.mock('../acl', () => ({
  sessionAcl: { pathView: tc.pathView, grantPath: tc.grantPath }
}))
vi.mock('../sessionService', () => ({
  sessionService: { getById: tc.getById }
}))
vi.mock('../skillService', () => ({
  skillService: {
    listExternalDirs: () => tc.externalSkillDirs,
    listSharedDirs: () => tc.sharedSkillDirs
  }
}))
vi.mock('../policyService', () => ({
  policyService: {
    getUserPolicies: () => tc.userPolicies,
    // 内置安全策略的禁用开关（ShuviX 扩展元数据）：这里一律不禁用
    isDisabled: () => false,
    // 与 policyService.readBuiltinPolicyMd 同形，只是基准目录直接钉在仓库那份上
    readBuiltinPolicyMd: (fileName: string) => {
      try {
        return readFileSync(join(tc.builtinDir, fileName), 'utf-8')
      } catch {
        return null
      }
    }
  }
}))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: tc.getTempWorkspace,
  getToolResultsBase: () => '/tmp/shuvix-actor-tool-results',
  getDefaultSkillsDir: () => '/tmp/shuvix-actor-skills',
  getBuiltinSkillsDir: () => '/tmp/shuvix-actor-builtin-skills',
  getSharedSkillsDirs: () => ({
    claude: '/tmp/shuvix-actor-home/.claude/skills',
    agents: '/tmp/shuvix-actor-home/.agents/skills'
  }),
  getDefaultBotsDir: () => '/tmp/shuvix-bots',
  // getVars 的 shuvixConfigDirs 的四个目录（退役的 protect-shuvix-config 引用它们）
  getDefaultPoliciesDir: () => '/tmp/shuvix-policies',
  getDefaultAgentsDir: () => '/tmp/shuvix-agents',
  getDefaultHooksDir: () => '/tmp/shuvix-hooks',
  getBuiltinKnowledgeDir: () => '/tmp/shuvix-builtin-knowledge',
  getSessionArtifactsDir: tc.getSessionArtifactsDir,
  // 与 utils/paths 的真实判定逐字相同（含单独的 '.'）—— SEC-8 判的就是它挡不挡得住
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..'),
  getShuvixKnowledgeRootDir: () => '/tmp/shuvix-knowledge-shuvix'
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  agentActorOf,
  getDesktopSecurityContext,
  isPathReadAllowed,
  isSessionDocument,
  isPathWriteAllowed,
  makeDesktopSecurityProvider,
  resolveProjectConfig,
  resolveSessionDocument,
  setCommandClassifier,
  setPermissionReviewer,
  withCallAgent,
  type ProjectConfig,
  type ToolContext
} from '../toolContext'
import type { ToolAgentIdentity } from '../toolAgent'
import { pathAclView, type AclEntry } from '@shuvix/chat-protocol/sessionAcl'
import {
  clearReviewState,
  clearSessionDecisions,
  getSessionDecisions,
  parsePolicyDefinitionFile,
  type CommandObjectInput,
  type CommandRisk,
  type PermissionRequestEvent,
  type PermissionReviewAnswer,
  type SecurityDecision,
  type SecuritySubject,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import type { AskInputRequest, InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

describe('agentActorOf', () => {
  it('TC-1 `shuvix-<profile>/<model>`：模型惰性取；缺元数据回落 shuvix-agent/unknown；取模型抛错或空白 → unknown；档案名空白归一为 -', () => {
    expect(
      agentActorOf({
        agent: {
          profileName: 'work',
          kind: 'root',
          getModelConfig: () => ({ provider: 'p', model: 'gpt-5', capabilities: {} })
        }
      })
    ).toBe('shuvix-work/gpt-5')
    expect(agentActorOf({})).toBe('shuvix-agent/unknown')
    expect(
      agentActorOf({
        agent: {
          profileName: 'work',
          kind: 'root',
          getModelConfig: () => {
            throw new Error('model gone')
          }
        }
      })
    ).toBe('shuvix-work/unknown')
    expect(agentActorOf({ agent: { profileName: 'work', kind: 'spawned' } })).toBe(
      'shuvix-work/unknown'
    )
    expect(
      agentActorOf({
        agent: {
          profileName: 'my agent',
          kind: 'spawned',
          getModelConfig: () => ({ provider: 'p', model: ' ', capabilities: {} })
        }
      })
    ).toBe('shuvix-my-agent/unknown')
  })

  it('TC-1 惰性：同一个 ctx 在模型切换后给出新的 actor', () => {
    let model = 'm1'
    const ctx = {
      agent: {
        profileName: 'coding',
        kind: 'spawned' as const,
        getModelConfig: () => ({ provider: 'p', model, capabilities: {} })
      }
    }
    expect(agentActorOf(ctx)).toBe('shuvix-coding/m1')
    model = 'm2'
    expect(agentActorOf(ctx)).toBe('shuvix-coding/m2')
  })
})

/**
 * 桌面变量表 —— 内置策略 match 里的 `vars.*` 就是从这里拿值的。
 *
 * 一条指向**未设变量**的策略在 strict 语义下不是「拦不住」而是更糟：match 报错走 fail-safe，
 * force-allow 视为不命中、force-ask 那一族则每次评估刷一条告警 —— 无论哪种，用户都看不出
 * 这道门其实没在工作。所以每加一份引用新变量的内置策略，这张表都得跟着长一项。
 */
describe('makeDesktopSecurityProvider —— 变量表', () => {
  const providerFor = (sessionId: string): ReturnType<typeof makeDesktopSecurityProvider> =>
    makeDesktopSecurityProvider(
      { sessionId, requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' }) as never
    )
  const vars = (sessionId = 's1'): Record<string, string | string[]> =>
    providerFor(sessionId).getVars() as Record<string, string | string[]>

  it('SEC-6 botsDir 由 getDefaultBotsDir() 填 —— 退役的 protect-bot-files 指的就是它（事实变量，留给用户策略）', () => {
    // 漏填 botsDir 的后果是引用它的策略静默失效，而那种策略守的是「bot 改写自己那份文件」这条
    // 会话中途、没人看着的写入
    expect(vars().botsDir).toBe('/tmp/shuvix-bots')
    // 工作区来自 getConfig()（每次评估现读），不是构造时的快照
    expect(vars().workspace).toBe('/ws')
  })

  // sessionArtifactsDir —— 本会话认领下来的图与交互块所在（事实变量；免询问靠的是会话权限表
  // vars.aclWrite 里同一个目录，见 HG-1）。用户策略拿它当范围时两件事都得钉：取的是哪一个会话的目录（SEC-7），
  // 以及坏 id 不能把这个范围放大（SEC-8：空 id = 所有会话的 artifacts 根，`..` = ~/.shuvix，里面有 policies/）。

  it('SEC-7 sessionArtifactsDir 由 getSessionArtifactsDir(ctx.sessionId) 填：一会话一个目录，子会话不继承父会话的', () => {
    tc.getSessionArtifactsDir.mockClear()
    expect(vars('s1').sessionArtifactsDir).toBe('/tmp/shuvix-artifacts/s1')
    // 取目录用的正是 ctx.sessionId —— artifact 工具落盘用的也是这个 id
    expect(tc.getSessionArtifactsDir).toHaveBeenCalledWith('s1')
    expect(tc.getSessionArtifactsDir.mock.calls.every(([id]) => id === 's1')).toBe(true)

    tc.getSessionArtifactsDir.mockClear()
    expect(vars('child').sessionArtifactsDir).toBe('/tmp/shuvix-artifacts/child')
    expect(tc.getSessionArtifactsDir.mock.calls.every(([id]) => id === 'child')).toBe(true)

    // 同一个 provider 反复现取，值不漂
    const provider = providerFor('s1')
    const first = (provider.getVars() as Record<string, unknown>).sessionArtifactsDir
    const second = (provider.getVars() as Record<string, unknown>).sessionArtifactsDir
    expect(first).toBe('/tmp/shuvix-artifacts/s1')
    expect(second).toBe(first)
  })

  it.each(['', '.', '..', '../x', 'a/b', 'a\\b'])(
    'SEC-8 坏会话 id %j 不放大范围：sessionArtifactsDir 给空串（inDir 恒不命中）',
    (id) => {
      expect(vars(id).sessionArtifactsDir).toBe('')
    }
  )

  // shuvixConfigDirs —— 事实变量：用户装回 protect-shuvix-config（force-ask）时守的就是它：漏一项，
  // 那一类规矩文件的写入就回到普通的 ask-on-external-path，于是可以被审查员代答，一次注入就能改掉
  // 审查员自己
  it('SEC-9 shuvixConfigDirs 恰为 policies / agents / hooks / skills 四个默认目录（按这个顺序；内置与外部技能目录不在其中）', () => {
    expect(vars().shuvixConfigDirs).toEqual([
      '/tmp/shuvix-policies',
      '/tmp/shuvix-agents',
      '/tmp/shuvix-hooks',
      '/tmp/shuvix-actor-skills'
    ])
  })

  // skillsDirs —— 事实变量：用户策略拿它圈「技能文件」。共用目录（~/.claude/skills、~/.agents/skills）
  // 里装的同样是技能，漏了它们，一条「技能目录里的写入要问」的用户策略就对那两处失效
  it('SEC-10 skillsDirs = 默认 → 内置 → 外部目录（配置顺序）→ 在列的共用目录（claude、agents），每次现取', () => {
    try {
      expect(vars().skillsDirs).toEqual([
        '/tmp/shuvix-actor-skills',
        '/tmp/shuvix-actor-builtin-skills'
      ])

      tc.externalSkillDirs = [
        { name: 'ext-a', path: '/tmp/shuvix-ext-a' },
        { name: 'ext-b', path: '/tmp/shuvix-ext-b' }
      ]
      tc.sharedSkillDirs = [
        { name: 'claude', path: '/tmp/shuvix-actor-home/.claude/skills' },
        { name: 'agents', path: '/tmp/shuvix-actor-home/.agents/skills' }
      ]
      expect(vars().skillsDirs).toEqual([
        '/tmp/shuvix-actor-skills',
        '/tmp/shuvix-actor-builtin-skills',
        '/tmp/shuvix-ext-a',
        '/tmp/shuvix-ext-b',
        '/tmp/shuvix-actor-home/.claude/skills',
        '/tmp/shuvix-actor-home/.agents/skills'
      ])

      // 被同名 / 同路径的外部目录占着的共用目录不在列：listSharedDirs 不给，这里也不另补（那个目录
      // 已经以外部目录的身份在前面了，不重复）
      tc.sharedSkillDirs = [{ name: 'claude', path: '/tmp/shuvix-actor-home/.claude/skills' }]
      expect(vars().skillsDirs).toEqual([
        '/tmp/shuvix-actor-skills',
        '/tmp/shuvix-actor-builtin-skills',
        '/tmp/shuvix-ext-a',
        '/tmp/shuvix-ext-b',
        '/tmp/shuvix-actor-home/.claude/skills'
      ])
    } finally {
      tc.externalSkillDirs = []
      tc.sharedSkillDirs = []
    }
  })
})

describe('resolveProjectConfig —— 工作目录照抄 getById 的口径', () => {
  beforeEach(() => {
    tc.getById.mockReset()
    tc.projectPick.mockReset()
    tc.getTempWorkspace.mockClear()
  })

  it('TC-WD1 项目会话 → 项目根（settings 里另有目录也不用），envVars 取项目的', () => {
    tc.getById.mockReturnValue({
      id: 's1',
      projectId: 'p1',
      settings: { workingDirectory: '/own/dir' },
      workingDirectory: '/proj/root'
    })
    tc.projectPick.mockReturnValue({
      id: 'p1',
      path: '/proj/root',
      settings: { tool: { envVars: [{ key: 'K', value: 'v' }] } }
    })
    expect(resolveProjectConfig('s1')).toEqual({
      workingDirectory: '/proj/root',
      envVars: { K: 'v' }
    })
    expect(tc.projectPick).toHaveBeenCalledWith('p1', ['id', 'path', 'settings'])
    expect(tc.getTempWorkspace).not.toHaveBeenCalled()
  })

  it('TC-WD2 无项目、自带目录 → 那个目录；不问临时工作区', () => {
    tc.getById.mockReturnValue({
      id: 's2',
      projectId: null,
      settings: { workingDirectory: '/own/dir' },
      workingDirectory: '/own/dir'
    })
    expect(resolveProjectConfig('s2')).toEqual({ workingDirectory: '/own/dir' })
    expect(tc.projectPick).not.toHaveBeenCalled()
    expect(tc.getTempWorkspace).not.toHaveBeenCalled()
  })

  it('TC-WD3 无项目、没有自带目录 → getById 给的临时工作区', () => {
    tc.getById.mockReturnValue({
      id: 's3',
      projectId: null,
      settings: {},
      workingDirectory: '/tmp/temp_workspace/s3'
    })
    expect(resolveProjectConfig('s3')).toEqual({ workingDirectory: '/tmp/temp_workspace/s3' })
  })

  it('TC-WD4 会话不存在 → 临时工作区（按 sessionId 取）', () => {
    tc.getById.mockReturnValue(undefined)
    expect(resolveProjectConfig('gone')).toEqual({ workingDirectory: '/tmp/shuvix-actor-ws' })
    expect(tc.getTempWorkspace).toHaveBeenCalledWith('gone')
  })
})

describe('resolveSessionDocument / isSessionDocument —— 笔记本会话自己那份文档', () => {
  beforeEach(() => {
    tc.getById.mockReset()
    tc.projectPick.mockReset()
    tc.pickSettings.mockReset()
  })

  /** 会话行：settings.notebookPath + getById 给出的工作目录（有项目时项目根即 /proj） */
  const session = (
    notebookPath: string | null,
    where: { projectPath?: string; workingDirectory?: string }
  ): void => {
    tc.pickSettings.mockImplementation((_id, keys) =>
      keys.includes('notebookPath') ? { notebookPath } : undefined
    )
    if (where.projectPath) {
      tc.getById.mockReturnValue({
        id: 's-doc',
        projectId: 'p1',
        settings: {},
        workingDirectory: where.projectPath
      })
      tc.projectPick.mockReturnValue({ id: 'p1', path: where.projectPath, settings: {} })
    } else {
      tc.getById.mockReturnValue({
        id: 's-doc',
        projectId: null,
        settings: { workingDirectory: where.workingDirectory },
        workingDirectory: where.workingDirectory
      })
    }
  }

  it('TC-DOC1 不是笔记本会话 → null；isSessionDocument 恒 false', () => {
    session(null, { projectPath: '/proj' })
    expect(resolveSessionDocument('s-doc')).toBeNull()
    expect(isSessionDocument('s-doc', '/proj/notes/a.md')).toBe(false)
    expect(tc.pickSettings).toHaveBeenCalledWith('s-doc', ['notebookPath'])

    tc.pickSettings.mockReturnValue({})
    expect(resolveSessionDocument('s-doc')).toBeNull()
  })

  it('TC-DOC2 项目会话的相对 notebookPath → 项目根下；`..` 写法也认，兄弟文件不认', () => {
    session('notes/a.md', { projectPath: '/proj' })
    expect(resolveSessionDocument('s-doc')).toBe('/proj/notes/a.md')
    expect(isSessionDocument('s-doc', '/proj/notes/a.md')).toBe(true)
    expect(isSessionDocument('s-doc', '/proj/notes/../notes/a.md')).toBe(true)
    expect(isSessionDocument('s-doc', '/proj/notes/b.md')).toBe(false)
    expect(isSessionDocument('s-doc', '/proj/a.md')).toBe(false)
  })

  it('TC-DOC3 绝对 notebookPath → 原样', () => {
    session('/elsewhere/doc.md', { projectPath: '/proj' })
    expect(resolveSessionDocument('s-doc')).toBe('/elsewhere/doc.md')
    expect(isSessionDocument('s-doc', '/elsewhere/doc.md')).toBe(true)
    expect(isSessionDocument('s-doc', '/proj/elsewhere/doc.md')).toBe(false)
  })

  it('TC-DOC4 无项目、自带工作目录 → 按那个目录拼', () => {
    session('x.md', { workingDirectory: '/own/dir' })
    expect(resolveSessionDocument('s-doc')).toBe('/own/dir/x.md')
    expect(isSessionDocument('s-doc', '/own/dir/x.md')).toBe(true)
    expect(tc.getTempWorkspace).not.toHaveBeenCalledWith('s-doc')
  })

  it('TC-DOC5 会话不存在 → null / false', () => {
    tc.pickSettings.mockReturnValue(undefined)
    tc.getById.mockReturnValue(undefined)
    expect(resolveSessionDocument('gone')).toBeNull()
    expect(isSessionDocument('gone', '/tmp/shuvix-actor-ws/x.md')).toBe(false)
  })

  describe('真实文件系统', () => {
    let root = ''
    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'shuvix-session-doc-')))
      mkdirSync(join(root, 'real', 'notes'), { recursive: true })
      writeFileSync(join(root, 'real', 'notes', 'a.md'), '# a\n')
      symlinkSync(join(root, 'real'), join(root, 'link'))
    })
    afterAll(() => rmSync(root, { recursive: true, force: true }))

    it('TC-DOC6 父目录是符号链接：经链接的写法与真实写法两个方向都认', () => {
      session('notes/a.md', { workingDirectory: join(root, 'link') })
      expect(resolveSessionDocument('s-doc')).toBe(join(root, 'link', 'notes', 'a.md'))
      expect(isSessionDocument('s-doc', join(root, 'real', 'notes', 'a.md'))).toBe(true)
      expect(isSessionDocument('s-doc', join(root, 'real', 'notes', 'b.md'))).toBe(false)

      session('notes/a.md', { workingDirectory: join(root, 'real') })
      expect(isSessionDocument('s-doc', join(root, 'link', 'notes', 'a.md'))).toBe(true)
    })

    it('TC-DOC7 已存在文件的大小写变体 → 认（大小写不敏感的文件系统）', (testCtx) => {
      const insensitive = existsSync(join(root, 'REAL', 'NOTES', 'A.MD'))
      if (!insensitive) testCtx.skip()
      session('notes/a.md', { workingDirectory: join(root, 'real') })
      expect(isSessionDocument('s-doc', join(root, 'real', 'NOTES', 'A.md'))).toBe(true)
      expect(isSessionDocument('s-doc', join(root, 'REAL', 'notes', 'a.MD'))).toBe(true)
    })
  })
})

/**
 * HG-1 会话权限表的宿主胶水 —— 两件事：
 *   - getVars 的 `aclRead` / `aclWrite`：来自 sessionAcl.pathView(ctx.sessionId)。命令沙箱拿的是同一张表
 *     （sandboxEntries），所以文件工具的免询问范围就是命令实际能碰的范围。每次评估现取 —— provider 整会话
 *     复用，会话中途「允许并记住」之后下一次评估就得看见；
 *   - persistGrant：询问卡片上的「允许并记住」写进这张表（sessionAcl.grantPath，来源 user）。
 */
describe('HG-1 getVars —— aclRead / aclWrite 来自会话权限表', () => {
  beforeEach(() => {
    // mockReset 回到 vi.fn(impl) 的缺省实现（空表），顺带清掉没用完的 Once 值
    tc.pathView.mockReset()
    tc.grantPath.mockReset()
  })

  it('HG-1 表给什么，aclRead / aclWrite 就是什么；按 ctx.sessionId 去取；其余变量照旧', () => {
    const view = {
      read: ['/ws', '/Users/u/.shuvix/artifacts/sess-1', '/skills/en', '/kb/notes'],
      write: ['/ws', '/Users/u/.shuvix/artifacts/sess-1', '/kb/notes']
    }
    tc.pathView.mockReturnValueOnce(view)

    const vars = makeDesktopSecurityProvider(
      { sessionId: 'sess-1', requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' })
    ).getVars() as Record<string, unknown>

    expect(tc.pathView.mock.calls).toEqual([['sess-1']])
    expect(vars.aclRead).toEqual(view.read)
    expect(vars.aclWrite).toEqual(view.write)
    // 多出来的是这两个键，不是把整张表换掉：其余变量照旧
    expect(vars.workspace).toBe('/ws')
    expect(vars.botsDir).toBe('/tmp/shuvix-bots')
  })

  it('HG-1 每次评估现取：同一个 provider，表变了（会话中途授予了一条）下一次 getVars 就跟上，不是构造时的快照', () => {
    const provider = makeDesktopSecurityProvider(
      { sessionId: 's2', requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' })
    )
    tc.pathView.mockReturnValueOnce({ read: ['/ws'], write: ['/ws'] })
    expect((provider.getVars() as Record<string, unknown>).aclWrite).toEqual(['/ws'])

    tc.pathView.mockReturnValueOnce({ read: ['/ws', '/granted'], write: ['/ws', '/granted'] })
    expect((provider.getVars() as Record<string, unknown>).aclWrite).toEqual(['/ws', '/granted'])
    expect(tc.pathView.mock.calls).toEqual([['s2'], ['s2']])
  })

  it('HG-1 空表（会话不在 / 算不出来）→ getVars 不抛，aclRead / aclWrite 都是空清单，工作区里的写也问（= 多问，绝不因此放行）；旧的 sessionDirs / granted* / sandbox* / workspace* 键不再给', () => {
    const provider = makeDesktopSecurityProvider(
      { sessionId: 'sess-empty', requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' })
    )
    let vars: Record<string, unknown> = {}
    expect(() => {
      vars = provider.getVars() as Record<string, unknown>
    }).not.toThrow()

    expect(tc.pathView).toHaveBeenCalledWith('sess-empty')
    expect(vars.aclRead).toEqual([])
    expect(vars.aclWrite).toEqual([])
    for (const key of [
      'sessionDirs',
      'sessionReadDirs',
      'grantedRead',
      'grantedWrite',
      'sandboxActive',
      'sandboxWritableRoots',
      'sandboxWriteDenied',
      'sandboxProtectedPatterns',
      'workspaceWritable',
      'workspaceWriteDenied',
      'workspaceProtectedPatterns'
    ]) {
      expect(vars, key).not.toHaveProperty(key)
    }

    // 真实评估：空表下工作区里的写要问；表里有工作区（可写）就不问
    const ctx = getDesktopSecurityContext({ sessionId: 'sess-empty' }, () => ({
      workingDirectory: '/ws'
    }))
    expect(ctx.evaluate('write', { type: 'path', path: '/ws/a.txt' }).effect).toBe('ask')
    tc.pathView.mockReturnValue({ read: ['/ws'], write: ['/ws'] })
    expect(ctx.evaluate('write', { type: 'path', path: '/ws/a.txt' }).effect).toBe('allow')
  })

  it('HG-1 persistGrant（「允许并记住」）→ sessionAcl.grantPath(ctx.sessionId, 路径, 读 / 写)', () => {
    const provider = makeDesktopSecurityProvider(
      { sessionId: 'sess-grant', requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' })
    )
    provider.persistGrant?.('write', '/Users/u/elsewhere')
    provider.persistGrant?.('read', '/Users/u/notes')
    expect(tc.grantPath.mock.calls).toEqual([
      ['sess-grant', '/Users/u/elsewhere', 'write'],
      ['sess-grant', '/Users/u/notes', 'read']
    ])
  })
})

/**
 * 主体（TC-SUBJ）与询问点的审查接缝（TC-RV）。
 *
 * subject 从 ctx.agent 来：档案名 + root / spawned（没有 ctx.agent 的调用点按 root 报，且不带档案名键；
 * 档案名空串同样不带）。审查员的防递归（「审查员自己在要权限」）与用户按主体写的策略都读它。
 * 观察点就是注入的审查者替身收到的 event.request.subject —— 生产里读它的正是那一个接缝。
 *
 * onPermissionRequest 每次调用现取注入的审查者：provider 可整会话复用，注入发生在启动时（index.ts），
 * 两者谁先谁后都得对。被动判定（evaluate / evaluateReadOnly / 预览面板与笔记本的 user 主体判定）
 * 只判不执行，从不走到接缝。
 */
describe('TC-SUBJ / TC-RV 桌面主体与审查接缝', () => {
  const WS = '/ws'
  const ART = '/tmp/shuvix-artifacts'
  /** 会话目录外的普通文件：ask-on-external-path#1（ask 档 —— 审查接缝只管这一档） */
  const OUTSIDE = '/tmp/shuvix-tc-review-outside/a.txt'
  const projectConfig: ProjectConfig = { workingDirectory: WS }
  const cfg = (): ProjectConfig => projectConfig

  const usedSessions = new Set<string>()
  const sid = (id: string): string => {
    usedSessions.add(id)
    return id
  }

  const answer = (decision: 'allow' | 'ask' | 'deny'): PermissionReviewAnswer => ({
    verdict: { decision, risk: 'low', summary: 'Writes a file.', reason: 'test reviewer' },
    source: 'test-reviewer'
  })

  type Reviewer = (
    event: PermissionRequestEvent,
    signal?: AbortSignal
  ) => Promise<PermissionReviewAnswer | null>

  const verdictOf = (d: SecurityDecision): { effect: string; winning: string } => ({
    effect: d.effect,
    winning: d.winning
  })

  /** 用户在 ~/.shuvix/policies 里写的一份（与 policyService 一样：解析结果 + 文件名） */
  function userPolicy(fileName: string, md: string): UserPolicyFile {
    const parsed = parsePolicyDefinitionFile(md, fileName.replace(/\.md$/, ''))
    if (!parsed) throw new Error(`fixture policy ${fileName} does not parse`)
    return { ...parsed, fileName }
  }

  beforeEach(() => {
    tc.pickSettings.mockReset()
    tc.userPolicies = []
    tc.pathView.mockReset()
  })

  afterEach(() => {
    setPermissionReviewer(null)
    for (const id of usedSessions) {
      clearReviewState(id)
      clearSessionDecisions(id)
    }
    usedSessions.clear()
  })

  it.each<[string, string, ToolContext['agent'], Partial<SecuritySubject>]>([
    [
      '派生的 coding',
      'tc-subj1-spawned',
      { profileName: 'coding', kind: 'spawned' },
      { agentKind: 'spawned', profileName: 'coding' }
    ],
    [
      '会话根 work',
      'tc-subj1-root',
      { profileName: 'work', kind: 'root' },
      { agentKind: 'root', profileName: 'work' }
    ],
    [
      '没有 ctx.agent（MCP 能力服务器等自建 ctx 的调用点）',
      'tc-subj1-none',
      undefined,
      { agentKind: 'root' }
    ],
    [
      '档案名为空串',
      'tc-subj1-blank',
      { profileName: '', kind: 'spawned' },
      { agentKind: 'spawned' }
    ]
  ])(
    'TC-SUBJ1 %s → 审查接缝收到的 subject 恰为 agent + 会话 id + agentKind（+ 有名字时的 profileName）',
    async (_label, id, agent, expected) => {
      const sessionId = sid(id)
      const seen: SecuritySubject[] = []
      setPermissionReviewer(async (event) => {
        seen.push(event.request.subject)
        return answer('allow')
      })

      const ctx = getDesktopSecurityContext({ sessionId, ...(agent ? { agent } : {}) }, cfg)
      // 审查员放行 → 不弹卡、直接过门（这里没给询问通道，走到卡片就会被拒）
      await expect(
        ctx.enforcePath('write', OUTSIDE, { toolCallId: `${id}-w`, toolName: 'write' })
      ).resolves.toBeUndefined()

      expect(seen).toHaveLength(1)
      // toStrictEqual：没有档案名时连 profileName 键都不该有（值为 undefined 的键也算多）
      expect(seen[0]).toStrictEqual({ kind: 'agent', sessionId, ...expected })
    }
  )

  it('TC-SUBJ2 用户策略按主体写（subject.profile == coding && subject.agentKind == spawned 的 deny）：只落在派生的 coding 上', () => {
    tc.userPolicies = [
      userPolicy(
        'no-spawned-coding-writes.md',
        [
          '---',
          'shuvix: policy v1',
          'name: no-spawned-coding-writes',
          'description: Spawned coding agents may not write files.',
          'shuvix-policy-scope:',
          '  subject.kind: [agent]',
          '  object.type: [path]',
          'shuvix-policy-rules:',
          '  - effect: deny',
          '    action: [write]',
          "    match: subject.profile == 'coding' && subject.agentKind == 'spawned'",
          '---',
          ''
        ].join('\n')
      )
    ]

    // 会话权限表照生产的形状给（工作区 + 本会话 artifacts，都可写）
    tc.pathView.mockImplementation((id) => ({
      read: [WS, `${ART}/${id}`],
      write: [WS, `${ART}/${id}`]
    }))
    const cases: Array<[ToolContext['agent'], string, string]> = [
      // [ctx.agent, 本会话 artifacts 里的写, 会话目录外的写]
      [{ profileName: 'coding', kind: 'spawned' }, 'deny', 'deny'],
      [{ profileName: 'coding', kind: 'root' }, 'allow', 'ask'],
      [{ profileName: 'work', kind: 'spawned' }, 'allow', 'ask'],
      [{ profileName: '', kind: 'spawned' }, 'allow', 'ask'],
      [undefined, 'allow', 'ask']
    ]
    const sessionId = sid('tc-subj2')
    for (const [agent, artifactEffect, outsideEffect] of cases) {
      const ctx = getDesktopSecurityContext({ sessionId, ...(agent ? { agent } : {}) }, cfg)
      const own = ctx.evaluate('write', { type: 'path', path: `${ART}/${sessionId}/chart.svg` })
      const outside = ctx.evaluate('write', { type: 'path', path: OUTSIDE })
      expect({ agent, own: own.effect, outside: outside.effect }).toEqual({
        agent,
        own: artifactEffect,
        outside: outsideEffect
      })
      if (artifactEffect === 'deny') {
        // 拒绝归因到用户那条规则（deny 压过 ask-on-external-path，也压过本会话 artifacts 的豁免）
        expect(verdictOf(own)).toEqual({ effect: 'deny', winning: 'no-spawned-coding-writes#0' })
        expect(verdictOf(outside)).toEqual({
          effect: 'deny',
          winning: 'no-spawned-coding-writes#0'
        })
      } else {
        expect(own.matched, JSON.stringify(agent)).not.toContain('no-spawned-coding-writes#0')
        expect(outside.winning, JSON.stringify(agent)).toBe('ask-on-external-path#1')
      }
    }
  })

  it('TC-RV1 没注入审查者：provider.onPermissionRequest 交回 null —— 询问照旧走到卡片（卡上没有审查意见）', async () => {
    const sessionId = sid('tc-rv1')
    const provider = makeDesktopSecurityProvider({ sessionId }, cfg)
    const event = { toolCallId: 'rv1', command: 'Write(/x)' } as unknown as PermissionRequestEvent
    expect(provider.onPermissionRequest).toBeTypeOf('function')
    await expect(
      provider.onPermissionRequest!(event, new AbortController().signal)
    ).resolves.toBeNull()
    await expect(provider.onPermissionRequest!(event)).resolves.toBeNull()

    // 端到端：同一次 ask 直接到人
    const asks: InputRequest[] = []
    const ctx = getDesktopSecurityContext(
      {
        sessionId,
        requestUserInput: async (req) => {
          asks.push(req)
          return { kind: 'ask', allowed: true }
        }
      },
      cfg
    )
    await ctx.enforcePath('write', OUTSIDE, { toolCallId: 'rv1-w', toolName: 'write' })
    expect(asks).toHaveLength(1)
    expect((asks[0] as AskInputRequest).review).toBeUndefined()
  })

  it('TC-RV2 注入之前就构造好的 provider，下一次调用也走注入的审查者：(event, signal) 原样交进去、回答原样交回；setPermissionReviewer(null) 之后复原成 null', async () => {
    const provider = makeDesktopSecurityProvider({ sessionId: sid('tc-rv2') }, cfg)
    const event = { toolCallId: 'rv2', command: 'Write(/x)' } as unknown as PermissionRequestEvent
    const signal = new AbortController().signal
    await expect(provider.onPermissionRequest!(event, signal)).resolves.toBeNull()

    const reply = answer('deny')
    const reviewer = vi.fn<Reviewer>(async () => reply)
    setPermissionReviewer(reviewer)
    const got = await provider.onPermissionRequest!(event, signal)
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(reviewer.mock.calls[0][0]).toBe(event)
    expect(reviewer.mock.calls[0][1]).toBe(signal)
    expect(got).toBe(reply)

    // 换一个审查者：同一个 provider 立刻跟上（不是构造时的快照）
    const other = vi.fn<Reviewer>(async () => null)
    setPermissionReviewer(other)
    await expect(provider.onPermissionRequest!(event, signal)).resolves.toBeNull()
    expect(other).toHaveBeenCalledTimes(1)

    setPermissionReviewer(null)
    await expect(provider.onPermissionRequest!(event, signal)).resolves.toBeNull()
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('TC-RV3 被动判定从不调审查者：user 主体的 isPathReadAllowed / isPathWriteAllowed（连用户自己的 ask 策略判出 ask 时也不调）；agent 主体的 evaluate / evaluateReadOnly 同样只判不问', () => {
    const reviewer = vi.fn<Reviewer>(async () => answer('allow'))
    setPermissionReviewer(reviewer)

    // 内置防护只管 agent 主体：用户亲手的 UI 操作默认放行
    expect(isPathReadAllowed(projectConfig, OUTSIDE)).toBe(true)
    expect(isPathWriteAllowed(projectConfig, OUTSIDE)).toBe(true)

    // 用户给自己的 UI 面写了一道 ask 门：被动判定给 false（占位），不会去问审查员
    tc.userPolicies = [
      userPolicy(
        'user-ui-ask-outside.md',
        [
          '---',
          'shuvix: policy v1',
          'name: user-ui-ask-outside',
          'description: My own notebook writes outside the project ask first.',
          'shuvix-policy-scope:',
          '  subject.kind: [user]',
          '  object.type: [path]',
          'shuvix-policy-rules:',
          '  - effect: ask',
          '    action: [write]',
          '    match: >-',
          '      !inDir(object.path, vars.workspace)',
          '---',
          ''
        ].join('\n')
      )
    ]
    expect(isPathWriteAllowed(projectConfig, OUTSIDE)).toBe(false)
    expect(isPathWriteAllowed(projectConfig, `${WS}/in.txt`)).toBe(true)

    // agent 主体：ask 档，但 evaluate / evaluateReadOnly 只是判定
    const ctx = getDesktopSecurityContext({ sessionId: sid('tc-rv3') }, cfg)
    expect(ctx.evaluate('write', { type: 'path', path: OUTSIDE })).toMatchObject({
      effect: 'ask',
      tier: 'ask',
      winning: 'ask-on-external-path#1'
    })
    expect(ctx.evaluateReadOnly('write', { type: 'path', path: OUTSIDE })).toBe(false)

    expect(reviewer).not.toHaveBeenCalled()
  })

  // ─── 各工具族的一次 enforce（H11-53 / P2-06-17 / TC-RVR4 共用）───

  const ALWAYS_ASK = [
    '---',
    'shuvix: policy v1',
    'name: h11-always-ask',
    'description: Every agent operation asks (test).',
    'shuvix-policy-scope:',
    '  subject.kind: [agent]',
    '  object.type: [path, command, gitTool, invocation]',
    'shuvix-policy-rules:',
    '  - effect: ask',
    '    action: [read, write, execute]',
    "    match: 'true'",
    '---',
    ''
  ].join('\n')

  const WORK = { profileName: 'work', kind: 'root' as const }
  const owner = { taskId: 3, conversationId: 1 }

  type Gate = ReturnType<typeof getDesktopSecurityContext>
  /** 每一族的一次调用；拥有者缺省是对话 1（P2-06-17 换成别的对话） */
  type Family = (ctx: Gate, id: string, at?: typeof owner) => Promise<unknown>
  const FAMILIES: Array<[string, Family]> = [
    [
      'write（会话目录外）',
      (ctx, id, at = owner) =>
        ctx.enforcePath('write', OUTSIDE, { toolCallId: id, toolName: 'write', ...at })
    ],
    [
      'ls / grep / glob 读（会话目录外）',
      (ctx, id, at = owner) =>
        ctx.enforcePath('read', OUTSIDE, { toolCallId: id, toolName: 'grep', ...at })
    ],
    [
      '没圈住的 bash 命令',
      (ctx, id, at = owner) =>
        ctx.enforceCommand(
          { channel: 'bash', command: 'make build', cwd: WS },
          { toolCallId: id, toolName: 'bash', ...at }
        )
    ],
    [
      'git 操作',
      (ctx, id, at = owner) =>
        ctx.enforceGitOp(
          { gitAction: 'commit', command: 'git commit', force: false, delete: false },
          { toolCallId: id, toolName: 'git', ...at }
        )
    ],
    [
      'knowledge（create 落盘）',
      (ctx, id, at = owner) =>
        ctx.enforcePath('write', OUTSIDE, {
          toolCallId: id,
          toolName: 'knowledge',
          operation: 'create',
          ...at
        })
    ]
  ]

  /**
   * H11-53（P1-11）—— 会话级装配的工具（ctx 带 agentOf、没有固定的 agent）：每次 enforce 按 opts 里这次
   * 调用的 conversationId 现取主体（withCallAgent）。各工具族的 PEP 落在门面的哪个方法上：
   * write / edit / knowledge create → enforcePath('write')；ls / grep / glob / read / knowledge read →
   * enforcePath('read')；bash → enforceCommand；git → enforceGitOp；L1 门 → enforceInvocation。
   * 一份「agent 主体一律 ask」的用户策略让每一族都走到审查接缝，观察点同 TC-SUBJ1。
   */
  describe('H11-53 会话级 ctx 的主体按调用现取', () => {
    it.each(FAMILIES)(
      'H11-53 %s：对话 1 上锁着 work → subject 带 work / root；认不出（没有锁）→ 不带档案名键',
      async (_label, call) => {
        tc.userPolicies = [userPolicy('h11-always-ask.md', ALWAYS_ASK)]
        const sessionId = sid('h11-53')
        const seen: SecuritySubject[] = []
        setPermissionReviewer(async (event) => {
          seen.push(event.request.subject)
          return answer('allow')
        })
        let locked = true
        const agentOf = vi.fn((conversationId: number) =>
          locked && conversationId === 1 ? WORK : undefined
        )
        const ctx = getDesktopSecurityContext({ sessionId, agentOf }, cfg)

        await call(ctx, 'h11-53-a')
        locked = false
        await call(ctx, 'h11-53-b')

        expect(agentOf.mock.calls).toEqual([[1], [1]])
        expect(seen).toHaveLength(2)
        expect(seen[0]).toStrictEqual({
          kind: 'agent',
          sessionId,
          agentKind: 'root',
          profileName: 'work'
        })
        expect(seen[1]).toStrictEqual({ kind: 'agent', sessionId, agentKind: 'root' })
      }
    )

    it('H11-53 L1 门（enforceInvocation）同样按调用取主体', async () => {
      tc.userPolicies = [userPolicy('h11-always-ask.md', ALWAYS_ASK)]
      const sessionId = sid('h11-53-l1')
      const seen: SecuritySubject[] = []
      setPermissionReviewer(async (event) => {
        seen.push(event.request.subject)
        return answer('allow')
      })
      const ctx = getDesktopSecurityContext({ sessionId, agentOf: () => WORK }, cfg)
      await ctx.enforceInvocation({ toolCallId: 'h11-53-l1', toolName: 'skill', ...owner })
      expect(seen).toStrictEqual([
        { kind: 'agent', sessionId, agentKind: 'root', profileName: 'work' }
      ])
    })

    // ─── P2-06：派生 agent（含 hook agent）的对话上，主体是它自己 ───

    const IDENTITIES: Record<number, ToolAgentIdentity> = {
      1: WORK,
      2: { profileName: 'explore', kind: 'spawned', callerId: 'sub-a1' },
      3: { profileName: 'permission-reviewer', kind: 'spawned', callerId: 'sub-r1' }
    }

    it.each(FAMILIES)(
      'P2-06-17 %s：对话 2 → spawned / explore，对话 1 → root / work（主体里从不带 callerId）',
      async (_label, call) => {
        tc.userPolicies = [userPolicy('h11-always-ask.md', ALWAYS_ASK)]
        const sessionId = sid('p2-06-17')
        const seen: SecuritySubject[] = []
        setPermissionReviewer(async (event) => {
          seen.push(event.request.subject)
          return answer('allow')
        })
        const agentOf = vi.fn((conversationId: number) => IDENTITIES[conversationId])
        const ctx = getDesktopSecurityContext({ sessionId, agentOf }, cfg)

        await call(ctx, 'p2-06-17-a', { taskId: 3, conversationId: 2 })
        await call(ctx, 'p2-06-17-b', { taskId: 3, conversationId: 1 })

        expect(seen).toStrictEqual([
          { kind: 'agent', sessionId, agentKind: 'spawned', profileName: 'explore' },
          { kind: 'agent', sessionId, agentKind: 'root', profileName: 'work' }
        ])
        expect(agentOf.mock.calls).toEqual([[2], [1]])
      }
    )

    it('P2-06-17 L1 门（enforceInvocation）在审查员的对话上：spawned / permission-reviewer', async () => {
      tc.userPolicies = [userPolicy('h11-always-ask.md', ALWAYS_ASK)]
      const sessionId = sid('p2-06-17-l1')
      const seen: SecuritySubject[] = []
      setPermissionReviewer(async (event) => {
        seen.push(event.request.subject)
        return answer('allow')
      })
      const ctx = getDesktopSecurityContext(
        { sessionId, agentOf: (conversationId) => IDENTITIES[conversationId] },
        cfg
      )
      await ctx.enforceInvocation({
        toolCallId: 'p2-06-17-l1',
        toolName: 'skill',
        taskId: 3,
        conversationId: 3
      })
      expect(seen).toStrictEqual([
        { kind: 'agent', sessionId, agentKind: 'spawned', profileName: 'permission-reviewer' }
      ])
    })
  })

  it('P2-06-18 派生主体驱动用户策略：同一个会话级门，对话 2（派生 explore）被拒、不问人也不审；对话 1 照常审查；evaluate 不按调用取主体', async () => {
    tc.userPolicies = [
      userPolicy(
        'no-spawned-explore-writes.md',
        [
          '---',
          'shuvix: policy v1',
          'name: no-spawned-explore-writes',
          'description: Spawned explore agents may not write files.',
          'shuvix-policy-scope:',
          '  subject.kind: [agent]',
          '  object.type: [path]',
          'shuvix-policy-rules:',
          '  - effect: deny',
          '    action: [write]',
          "    match: subject.profile == 'explore' && subject.agentKind == 'spawned'",
          '---',
          ''
        ].join('\n')
      )
    ]
    const sessionId = sid('p2-06-18')
    const EXPLORE: ToolAgentIdentity = {
      profileName: 'explore',
      kind: 'spawned',
      callerId: 'sub-a1'
    }
    const WORK: ToolAgentIdentity = { profileName: 'work', kind: 'root' }
    const seen: SecuritySubject[] = []
    const reviewer = vi.fn<Reviewer>(async (event) => {
      seen.push(event.request.subject)
      return answer('allow')
    })
    setPermissionReviewer(reviewer)
    const requestUserInput = vi.fn(async () => ({ kind: 'ask' as const, allowed: true }))
    const agentOf = vi.fn((conversationId: number) => (conversationId === 2 ? EXPLORE : WORK))
    const ctx = getDesktopSecurityContext({ sessionId, agentOf, requestUserInput }, cfg)

    await expect(
      ctx.enforcePath('write', OUTSIDE, { toolCallId: 'd-2', toolName: 'write', conversationId: 2 })
    ).rejects.toThrow()
    expect(reviewer).not.toHaveBeenCalled()
    expect(requestUserInput).not.toHaveBeenCalled()

    await expect(
      ctx.enforcePath('write', OUTSIDE, { toolCallId: 'd-1', toolName: 'write', conversationId: 1 })
    ).resolves.toBeUndefined()
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(seen).toStrictEqual([
      { kind: 'agent', sessionId, agentKind: 'root', profileName: 'work' }
    ])
    expect(requestUserInput).not.toHaveBeenCalled()

    // 被动判定按 ctx.agent（这里没有）取主体 = 根的缺省：ask-on-external-path，不问 agentOf
    const lookups = agentOf.mock.calls.length
    expect(verdictOf(ctx.evaluate('write', { type: 'path', path: OUTSIDE }))).toEqual({
      effect: 'ask',
      winning: 'ask-on-external-path#1'
    })
    expect(ctx.evaluateReadOnly('write', { type: 'path', path: OUTSIDE })).toBe(false)
    expect(agentOf.mock.calls.length).toBe(lookups)
  })

  /**
   * TC-RVR —— 审查员自己的工具调用从不问人（setPermissionReviewer 的第二个参数）。
   *
   * 判定型 hook 派出的审查员可以 `read`（看一眼被运行的脚本），但它的调用拿到的是同一个 provider 去掉
   * onPermissionRequest 与 requestUserInput 的那一份：判出 ask 的一律按 fail-closed 拒绝（`no way to ask`），
   * 不送审查、不弹卡。判定本身不变 —— 只是这一份上没有可问的人。所以它能读的恰是被审 agent 不问就能读的。
   * 「是不是审查员」由注入的判断每次调用现答（这里是一个按 bound 集合回答的替身；生产注入的是
   * permissionReview.isReviewerIdentity）。
   */
  describe('TC-RVR 审查员的调用不问人', () => {
    /** 家目录里的会话目录：读这里不问，全靠它在会话权限表里（不在家目录里的路径读起来本就不问） */
    const HOME_WS = join(homedir(), 'shuvix-tc-rvr-ws')
    const HOME_ART = join(homedir(), 'shuvix-tc-rvr-art')
    /** 家目录里、会话目录外：ask-on-external-path#0（读） */
    const HOME_READ = join(homedir(), 'shuvix-tc-rvr', 'secret.txt')
    const rvrConfig: ProjectConfig = { workingDirectory: HOME_WS }
    const rvrCfg = (): ProjectConfig => rvrConfig

    const REVIEWER: ToolAgentIdentity = {
      profileName: 'permission-reviewer',
      kind: 'spawned',
      callerId: 'sub-r1'
    }
    const AGENTS: Record<number, ToolAgentIdentity> = {
      1: WORK,
      2: { profileName: 'explore', kind: 'spawned', callerId: 'sub-a1' },
      3: REVIEWER,
      6: { profileName: 'titler', kind: 'spawned', callerId: 'sub-t1' }
    }
    const agentOf = (conversationId: number): ToolAgentIdentity | undefined =>
      AGENTS[conversationId]
    const at = (conversationId: number): { taskId: number; conversationId: number } => ({
      taskId: 30 + conversationId,
      conversationId
    })

    /** 绑在 permission.request 上的档案（hookService.agentsBoundTo 的替身，可变） */
    let bound: Set<string>
    let check: ReturnType<typeof vi.fn<(agent: ToolAgentIdentity) => boolean>>
    /** 审查接缝：对谁都答不出（null）—— 走到它就该弹卡；审查员根本走不到它 */
    let seam: ReturnType<typeof vi.fn<Reviewer>>
    let requestUserInput: ReturnType<
      typeof vi.fn<(req: InputRequest) => Promise<{ kind: 'ask'; allowed: boolean }>>
    >

    const sessionCtx = (sessionId: string): Gate =>
      getDesktopSecurityContext({ sessionId, agentOf, requestUserInput }, rvrCfg)
    const readFrom = (
      ctx: Gate,
      conversationId: number,
      path: string,
      id = `rvr-${conversationId}`
    ): Promise<void> =>
      ctx.enforcePath('read', path, { toolCallId: id, toolName: 'read', ...at(conversationId) })

    function onePolicy(
      name: string,
      effect: string,
      action: string,
      match: string
    ): UserPolicyFile {
      return userPolicy(
        `${name}.md`,
        [
          '---',
          'shuvix: policy v1',
          `name: ${name}`,
          `description: ${effect} test rule.`,
          'shuvix-policy-scope:',
          '  subject.kind: [agent]',
          '  object.type: [path]',
          'shuvix-policy-rules:',
          `  - effect: ${effect}`,
          `    action: [${action}]`,
          `    match: ${JSON.stringify(match)}`,
          '---',
          ''
        ].join('\n')
      )
    }

    beforeEach(() => {
      tc.pathView.mockImplementation((id) => ({
        read: [HOME_WS, join(HOME_ART, id)],
        write: [HOME_WS, join(HOME_ART, id)]
      }))
      bound = new Set(['permission-reviewer'])
      check = vi.fn(
        (agent: ToolAgentIdentity) => agent.kind === 'spawned' && bound.has(agent.profileName)
      )
      seam = vi.fn<Reviewer>(async () => null)
      requestUserInput = vi.fn(async () => ({ kind: 'ask' as const, allowed: true }))
      setPermissionReviewer(seam, check)
    })

    it('TC-RVR1 审查员读家目录里会话目录外的文件：按 fail-closed 拒绝（no way to ask），不弹卡、不送审查；决策记录是 ask、没有人的回答、主体是派生的 permission-reviewer', async () => {
      const sessionId = sid('tc-rvr1')
      const ctx = sessionCtx(sessionId)
      await expect(readFrom(ctx, 3, HOME_READ)).rejects.toThrow(
        /^Access denied: path outside workspace and no way to ask: /
      )
      expect(requestUserInput).not.toHaveBeenCalled()
      expect(seam).not.toHaveBeenCalled()

      const records = getSessionDecisions(sessionId)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        toolCallId: 'rvr-3',
        toolName: 'read',
        action: 'read',
        objectKind: 'path',
        effect: 'ask',
        winning: 'ask-on-external-path#0',
        subject: { kind: 'agent', agentKind: 'spawned', profileName: 'permission-reviewer' }
      })
      expect(records[0].userResponse).toBeUndefined()
      expect(records[0].review).toBeUndefined()
    })

    it('TC-RVR2 不需要询问的读取照常放行：工作区、本会话 artifacts、家目录外（/tmp、/usr/bin/env）、Read 授权、Write 授权（写授权覆盖读）—— 不送审查、不弹卡', async () => {
      const GRANT_R = join(homedir(), 'shuvix-tc-rvr-grant-r')
      const GRANT_W = join(homedir(), 'shuvix-tc-rvr-grant-w')
      const sessionId = sid('tc-rvr2')
      // 权限表：工作区、本会话 artifacts（派生），外加用户授予的一条读、一条写 —— 经真的 pathAclView
      // 归成 aclRead / aclWrite（写隐含读）
      const row = (
        target: string,
        access: 'read' | 'write',
        source: AclEntry['source']
      ): Pick<AclEntry, 'kind' | 'target' | 'access' | 'source'> => ({
        kind: 'path' as const,
        target,
        access,
        source
      })
      tc.pathView.mockImplementation((id) =>
        pathAclView([
          row(HOME_WS, 'write', 'workdir'),
          row(join(HOME_ART, id), 'write', 'system'),
          row(GRANT_R, 'read', 'user'),
          row(GRANT_W, 'write', 'user')
        ])
      )
      const ctx = sessionCtx(sessionId)
      const paths = [
        join(HOME_WS, 'scripts', 'build.sh'),
        join(HOME_ART, sessionId, 'x'),
        '/tmp/shuvix-tc-rvr/run.sh',
        '/usr/bin/env',
        join(GRANT_R, 'notes.txt'),
        join(GRANT_W, 'notes.txt')
      ]
      for (const [i, path] of paths.entries()) {
        await expect(readFrom(ctx, 3, path, `rvr2-${i}`), path).resolves.toBeUndefined()
      }
      expect(seam).not.toHaveBeenCalled()
      expect(requestUserInput).not.toHaveBeenCalled()
      // 自检：授权确实是放行的原因 —— 授权根之外、家目录里的同类路径照样拒绝
      await expect(
        readFrom(ctx, 3, join(homedir(), 'shuvix-tc-rvr-grant-x', 'notes.txt'), 'rvr2-x')
      ).rejects.toThrow(/no way to ask/)
    })

    it.each([
      ['审查员先', [3, 1, 2, 6]],
      ['根先', [1, 3, 2, 6, 3]]
    ] as const)(
      'TC-RVR3 同一个会话级 ctx（%s）：对话 1 / 2 / 6 各弹一张卡，对话 3 被拒 —— 去掉询问通道的那一份不漏到别的调用上',
      async (_label, order) => {
        const sessionId = sid(`tc-rvr3-${order[0]}`)
        const ctx = sessionCtx(sessionId)
        for (const [i, conversationId] of order.entries()) {
          const before = requestUserInput.mock.calls.length
          const run = readFrom(ctx, conversationId, HOME_READ, `rvr3-${i}`)
          if (conversationId === 3) {
            await expect(run).rejects.toThrow(/no way to ask/)
            expect(requestUserInput.mock.calls.length).toBe(before)
          } else {
            await expect(run).resolves.toBeUndefined()
            expect(requestUserInput.mock.calls.length).toBe(before + 1)
          }
        }
        expect(requestUserInput).toHaveBeenCalledTimes(3)
        // 接缝只见过别人的请求
        expect(seam.mock.calls.map(([event]) => event.request.subject.profileName)).toEqual(
          order.filter((c) => c !== 3).map((c) => AGENTS[c].profileName)
        )
      }
    )

    it.each(FAMILIES)(
      'TC-RVR4 %s：「agent 一律 ask」的用户策略下，审查员（对话 3）被拒，不弹卡、不送审查',
      async (_label, call) => {
        tc.userPolicies = [userPolicy('h11-always-ask.md', ALWAYS_ASK)]
        const ctx = sessionCtx(sid('tc-rvr4'))
        await expect(call(ctx, 'tc-rvr4', at(3))).rejects.toThrow(/no way to ask/)
        expect(requestUserInput).not.toHaveBeenCalled()
        expect(seam).not.toHaveBeenCalled()
        // 对照：同一族在对话 1 上照常送审查、弹卡
        await call(ctx, 'tc-rvr4-root', at(1))
        expect(seam).toHaveBeenCalledTimes(1)
        expect(requestUserInput).toHaveBeenCalledTimes(1)
      }
    )

    it('TC-RVR4 L1 门（enforceInvocation）同样：审查员被拒，不弹卡、不送审查', async () => {
      tc.userPolicies = [userPolicy('h11-always-ask.md', ALWAYS_ASK)]
      const ctx = sessionCtx(sid('tc-rvr4-l1'))
      await expect(
        ctx.enforceInvocation({ toolCallId: 'tc-rvr4-l1', toolName: 'skill', ...at(3) })
      ).rejects.toThrow(/no way to ask/)
      expect(requestUserInput).not.toHaveBeenCalled()
      expect(seam).not.toHaveBeenCalled()
    })

    it('TC-RVR5 force-ask（只问人）的读规则落在工作区：审查员被拒，不弹卡、不送审查；根 agent 弹卡', async () => {
      tc.userPolicies = [
        onePolicy('rvr-force-ask-ws', 'force-ask', 'read', 'inDir(object.path, vars.workspace)')
      ]
      const ctx = sessionCtx(sid('tc-rvr5-fa'))
      const target = join(HOME_WS, 'a.txt')
      await expect(readFrom(ctx, 3, target)).rejects.toThrow(/no way to ask/)
      expect(requestUserInput).not.toHaveBeenCalled()
      await expect(readFrom(ctx, 1, target)).resolves.toBeUndefined()
      expect(requestUserInput).toHaveBeenCalledTimes(1)
      // force-ask 本来就不送审查
      expect(seam).not.toHaveBeenCalled()
    })

    it('TC-RVR5 deny 规则：审查员收到的是那条拒绝，不是 no way to ask', async () => {
      tc.userPolicies = [
        onePolicy('rvr-deny-secret', 'deny', 'read', 'inDir(object.path, vars.home)')
      ]
      const ctx = sessionCtx(sid('tc-rvr5-deny'))
      const err = await readFrom(ctx, 3, HOME_READ).then(
        () => null,
        (e: Error) => e
      )
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toContain("Denied by security policy rule 'rvr-deny-secret#0'")
      expect(err!.message).not.toContain('no way to ask')
      expect(getSessionDecisions('tc-rvr5-deny')[0]).toMatchObject({
        effect: 'deny',
        winning: 'rvr-deny-secret#0'
      })
      expect(requestUserInput).not.toHaveBeenCalled()
      expect(seam).not.toHaveBeenCalled()
    })

    it('TC-RVR5 force-allow 规则：审查员照样放行（没有可问的人，不等于凡事都拒）', async () => {
      tc.userPolicies = [
        onePolicy(
          'rvr-force-allow',
          'force-allow',
          'read',
          `inDir(object.path, ${JSON.stringify(join(homedir(), 'shuvix-tc-rvr'))})`
        )
      ]
      const ctx = sessionCtx(sid('tc-rvr5-fallow'))
      await expect(readFrom(ctx, 3, HOME_READ)).resolves.toBeUndefined()
      expect(requestUserInput).not.toHaveBeenCalled()
      expect(seam).not.toHaveBeenCalled()
    })

    it.each(['allow', 'ask', 'deny'] as const)(
      'TC-RVR5 接缝对审查员会答 %s 也问不到它：审查员的调用根本不送审查，按 no way to ask 拒绝',
      async (decision) => {
        seam.mockImplementation(async () => answer(decision))
        const sessionId = sid(`tc-rvr5-seam-${decision}`)
        const ctx = sessionCtx(sessionId)
        await expect(readFrom(ctx, 3, HOME_READ)).rejects.toThrow(
          /^Access denied: path outside workspace and no way to ask: /
        )
        expect(seam).not.toHaveBeenCalled()
        expect(requestUserInput).not.toHaveBeenCalled()
        expect(getSessionDecisions(sessionId)[0].review).toBeUndefined()
        // 对照：同一个接缝对根 agent 照常作答
        const root = readFrom(ctx, 1, HOME_READ, 'rvr5-root')
        if (decision === 'deny') await expect(root).rejects.toThrow(/^Blocked by the reviewer: /)
        else await expect(root).resolves.toBeUndefined()
        expect(seam).toHaveBeenCalledTimes(1)
        expect(requestUserInput).toHaveBeenCalledTimes(decision === 'ask' ? 1 : 0)
      }
    )

    it('TC-RVR6 判断每次调用现答：收到这次调用认出的身份；从集合里拿掉之后，对话 3 的下一次调用弹卡', async () => {
      const ctx = sessionCtx(sid('tc-rvr6'))
      await expect(readFrom(ctx, 3, HOME_READ, 'rvr6-a')).rejects.toThrow(/no way to ask/)
      expect(check).toHaveBeenCalledTimes(1)
      expect(check.mock.calls[0][0]).toMatchObject({
        profileName: 'permission-reviewer',
        kind: 'spawned'
      })
      // 对话 2 的调用问的是 explore
      await readFrom(ctx, 2, HOME_READ, 'rvr6-b')
      expect(check.mock.calls[1][0]).toMatchObject({ profileName: 'explore', kind: 'spawned' })

      // auto-review 被停用：permission-reviewer 不再算绑定 —— 同一个 ctx 的下一次调用就弹卡
      bound.delete('permission-reviewer')
      const cards = requestUserInput.mock.calls.length
      await expect(readFrom(ctx, 3, HOME_READ, 'rvr6-c')).resolves.toBeUndefined()
      expect(requestUserInput.mock.calls.length).toBe(cards + 1)
      expect(check).toHaveBeenCalledTimes(3)
    })

    it('TC-RVR6 认不出调用方（没有 ctx.agent、agentOf 认不出）按根处理：判断一次都不调', async () => {
      const ctx = getDesktopSecurityContext(
        { sessionId: sid('tc-rvr6-none'), agentOf: () => undefined, requestUserInput },
        rvrCfg
      )
      await expect(readFrom(ctx, 9, HOME_READ)).resolves.toBeUndefined()
      await expect(
        ctx.enforcePath('read', HOME_READ, { toolCallId: 'rvr6-no-conv', toolName: 'read' })
      ).resolves.toBeUndefined()
      const plain = getDesktopSecurityContext(
        { sessionId: sid('tc-rvr6-plain'), requestUserInput },
        rvrCfg
      )
      await expect(
        plain.enforcePath('read', HOME_READ, { toolCallId: 'rvr6-plain', toolName: 'read' })
      ).resolves.toBeUndefined()
      expect(check).not.toHaveBeenCalled()
      expect(requestUserInput).toHaveBeenCalledTimes(3)
    })

    it('TC-RVR7 缺省：setPermissionReviewer(seam) 不带第二个参数 = 谁都不是审查员，对话 3 照旧弹卡；setPermissionReviewer(null) 清掉先前注入的判断', async () => {
      setPermissionReviewer(seam)
      const ctx = sessionCtx(sid('tc-rvr7'))
      await expect(readFrom(ctx, 3, HOME_READ, 'rvr7-a')).resolves.toBeUndefined()
      expect(requestUserInput).toHaveBeenCalledTimes(1)
      expect(seam).toHaveBeenCalledTimes(1)
      expect(check).not.toHaveBeenCalled()

      // 再注入判断 → 拒绝；然后 null 清掉 → 又弹卡（判断也一并清了）
      setPermissionReviewer(seam, check)
      await expect(readFrom(ctx, 3, HOME_READ, 'rvr7-b')).rejects.toThrow(/no way to ask/)
      setPermissionReviewer(null)
      await expect(readFrom(ctx, 3, HOME_READ, 'rvr7-c')).resolves.toBeUndefined()
      expect(requestUserInput).toHaveBeenCalledTimes(2)
      expect(check).toHaveBeenCalledTimes(1)
    })

    it('TC-RVR8 固定的 ctx.agent 是审查员（没有 agentOf）：enforcePath 读被拒；evaluate 照样判出 ask —— 改的只是送达，不是判定', async () => {
      const ctx = getDesktopSecurityContext(
        { sessionId: sid('tc-rvr8'), agent: REVIEWER, requestUserInput },
        rvrCfg
      )
      await expect(
        ctx.enforcePath('read', HOME_READ, { toolCallId: 'rvr8', toolName: 'read' })
      ).rejects.toThrow(/no way to ask/)
      expect(verdictOf(ctx.evaluate('read', { type: 'path', path: HOME_READ }))).toEqual({
        effect: 'ask',
        winning: 'ask-on-external-path#0'
      })
      expect(requestUserInput).not.toHaveBeenCalled()
      expect(seam).not.toHaveBeenCalled()
    })
  })
})

/**
 * 命令风险分类接缝（TC-CC）：provider.classifyCommand 每次调用现取 setCommandClassifier 注入的那份
 * （main 启动时注入；provider 整会话复用，两者谁先谁后都得对）。没注入 = 不分类（null）。注入的那份
 * 收到 (input, { signal, toolCallId, sessionId })：sessionId 是 provider 自己会话的 id（分类器日志按它对上）。
 * 内置 ask-on-command 读分类：分到 read_only 且 readOnly >= 0.9 的命令不问（TC-CC2..4）。
 */
describe('TC-CC 命令风险分类接缝（setCommandClassifier）', () => {
  type Classifier = (
    input: CommandObjectInput,
    opts: { signal?: AbortSignal; toolCallId?: string; sessionId: string }
  ) => Promise<CommandRisk | null>
  type Reviewer = (
    event: PermissionRequestEvent,
    signal?: AbortSignal
  ) => Promise<PermissionReviewAnswer | null>
  const projectConfig: ProjectConfig = { workingDirectory: '/ws' }
  const cfg = (): ProjectConfig => projectConfig

  const CATEGORIES = [
    'read_only',
    'personal_data',
    'runs_project_code',
    'local_change',
    'outside_change',
    'install',
    'remote_change',
    'data_out',
    'secrets',
    'destructive',
    'privilege',
    'persistence'
  ] as const
  /** 选中 category，readOnly = read_only 的概率 = readOnly */
  const riskOf = (category: (typeof CATEGORIES)[number], readOnly: number): CommandRisk => ({
    category,
    confidence: category === 'read_only' ? readOnly : 0.9,
    readOnly,
    probabilities: Object.fromEntries(
      CATEGORIES.map((c) => [c, c === 'read_only' ? readOnly : c === category ? 0.9 : 0])
    ) as CommandRisk['probabilities'],
    model: 'openrouter/~typesafe/jev-latest'
  })
  const READ_ONLY = riskOf('read_only', 0.95)

  const usedSessions = new Set<string>()
  const sid = (id: string): string => {
    usedSessions.add(id)
    return id
  }

  beforeEach(() => {
    tc.userPolicies = []
  })

  afterEach(() => {
    setCommandClassifier(null)
    setPermissionReviewer(null)
    tc.userPolicies = []
    for (const id of usedSessions) {
      clearReviewState(id)
      clearSessionDecisions(id)
    }
    usedSessions.clear()
  })

  /** 一个记下卡片的真实桌面 SecurityContext（人一律点允许） */
  function desktopContext(sessionId: string): {
    ctx: ReturnType<typeof getDesktopSecurityContext>
    asks: InputRequest[]
  } {
    const asks: InputRequest[] = []
    const ctx = getDesktopSecurityContext(
      {
        sessionId,
        requestUserInput: async (req) => {
          asks.push(req)
          return { kind: 'ask', allowed: true }
        }
      },
      cfg
    )
    return { ctx, asks }
  }

  const LS: CommandObjectInput = { channel: 'bash', command: 'ls', cwd: '/ws' }

  it('TC-CC1 注入之前构造的 provider：classifyCommand 交回 null；注入后收到 (同一个 input, { 同一个 signal, toolCallId, sessionId: 本会话 })、回答原样交回；换一个立刻生效（不是快照）；置 null 复原', async () => {
    const sessionId = sid('tc-cc1')
    const provider = makeDesktopSecurityProvider({ sessionId }, cfg)
    const signal = new AbortController().signal
    expect(provider.classifyCommand).toBeTypeOf('function')
    await expect(provider.classifyCommand!(LS, { signal, toolCallId: 'tc-a' })).resolves.toBeNull()
    await expect(provider.classifyCommand!(LS, {})).resolves.toBeNull()

    const first = vi.fn<Classifier>(async () => READ_ONLY)
    setCommandClassifier(first)
    const got = await provider.classifyCommand!(LS, { signal, toolCallId: 'tc-a' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0][0]).toBe(LS)
    expect(first.mock.calls[0][1]).toStrictEqual({ signal, toolCallId: 'tc-a', sessionId })
    expect(first.mock.calls[0][1].signal).toBe(signal)
    expect(got).toBe(READ_ONLY)

    const second = vi.fn<Classifier>(async () => null)
    setCommandClassifier(second)
    await expect(provider.classifyCommand!(LS, { signal })).resolves.toBeNull()
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0][1].sessionId).toBe(sessionId)
    expect(first).toHaveBeenCalledTimes(1)

    setCommandClassifier(null)
    await expect(provider.classifyCommand!(LS, { signal })).resolves.toBeNull()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('TC-CC2 没有用户策略、真实的桌面 SecurityContext：read_only 0.95 → 没圈住的 ls 不问就过，记录 allow / default:command + commandRisk，分类器拿到 toolCallId 与 sessionId；分类器置 null → ask-on-command 照问、没有 commandRisk', async () => {
    const classifier = vi.fn<Classifier>(async () => READ_ONLY)
    setCommandClassifier(classifier)
    const sessionId = sid('tc-cc2')
    const { ctx, asks } = desktopContext(sessionId)

    await expect(
      ctx.enforceCommand(LS, { toolCallId: 'tc-cc2-a', toolName: 'bash' })
    ).resolves.toEqual({ status: 'allowed' })
    expect(classifier).toHaveBeenCalledTimes(1)
    expect(classifier.mock.calls[0][0]).toBe(LS)
    expect(classifier.mock.calls[0][1]).toMatchObject({ toolCallId: 'tc-cc2-a', sessionId })
    expect(asks).toHaveLength(0)
    expect(getSessionDecisions(sessionId)[0]).toMatchObject({
      effect: 'allow',
      winning: 'default:command',
      matched: [],
      commandRisk: READ_ONLY
    })

    setCommandClassifier(null)
    await expect(
      ctx.enforceCommand(LS, { toolCallId: 'tc-cc2-b', toolName: 'bash' })
    ).resolves.toEqual({ status: 'allowed' })
    expect(asks).toHaveLength(1)
    const latest = getSessionDecisions(sessionId)[0]
    expect(latest).toMatchObject({ effect: 'ask', winning: 'ask-on-command#0' })
    expect(latest.commandRisk).toBeUndefined()
    expect(classifier).toHaveBeenCalledTimes(1)
  })

  it.each<[string, CommandRisk]>([
    ['read_only 0.85', riskOf('read_only', 0.85)],
    ['destructive', riskOf('destructive', 0.01)]
  ])('TC-CC3 %s → 没圈住的命令照问，记录带 commandRisk', async (_label, risk) => {
    setCommandClassifier(vi.fn<Classifier>(async () => risk))
    const sessionId = sid(`tc-cc3-${risk.category}-${risk.readOnly}`)
    const { ctx, asks } = desktopContext(sessionId)
    await expect(
      ctx.enforceCommand(LS, { toolCallId: 'tc-cc3', toolName: 'bash' })
    ).resolves.toEqual({ status: 'allowed' })
    expect(asks).toHaveLength(1)
    expect(getSessionDecisions(sessionId)[0]).toMatchObject({
      effect: 'ask',
      winning: 'ask-on-command#0',
      commandRisk: risk
    })
  })

  it('TC-CC4 审查者：豁免的命令（read_only 0.95）不调它；0.85 调一次、收到的客体带 risk', async () => {
    const reviewer = vi.fn<Reviewer>(async () => null)
    setPermissionReviewer(reviewer)

    setCommandClassifier(vi.fn<Classifier>(async () => READ_ONLY))
    const exempt = desktopContext(sid('tc-cc4-exempt'))
    await exempt.ctx.enforceCommand(LS, { toolCallId: 'tc-cc4-a', toolName: 'bash' })
    expect(reviewer).not.toHaveBeenCalled()
    expect(exempt.asks).toHaveLength(0)

    const unsure = riskOf('read_only', 0.85)
    setCommandClassifier(vi.fn<Classifier>(async () => unsure))
    const asked = desktopContext(sid('tc-cc4-asked'))
    await asked.ctx.enforceCommand(LS, { toolCallId: 'tc-cc4-b', toolName: 'bash' })
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(reviewer.mock.calls[0][0].request.object.risk).toEqual(unsure)
    expect(asked.asks).toHaveLength(1)
  })
})

/**
 * H11-49（P1-11）—— withCallAgent 是纯函数：换上这次调用的 agent，别的什么都不动。
 */
describe('withCallAgent', () => {
  const identity = { profileName: 'work', kind: 'root' as const }
  const base = (): ToolContext => ({
    sessionId: 's1',
    requestUserInput: vi.fn(),
    emitChatEvent: vi.fn(),
    agentOf: vi.fn(() => identity)
  })

  it('H11-49 (a) 调用没给 → 原样交回', () => {
    const ctx = base()
    expect(withCallAgent(ctx, undefined)).toBe(ctx)
    expect(withCallAgent(ctx, {})).toBe(ctx)
    expect(ctx.agentOf).not.toHaveBeenCalled()
  })

  it('H11-49 (b) ctx 没有 agentOf → agent 不变', () => {
    const fixed = { profileName: 'coding', kind: 'spawned' as const }
    const ctx: ToolContext = { sessionId: 's1', agent: fixed }
    expect(withCallAgent(ctx, { conversationId: 1 }).agent).toBe(fixed)
  })

  it('H11-49 (c) 认出来了 → agent 是那份身份；sessionId / requestUserInput / emitChatEvent / agentOf 同一引用；入参不改', () => {
    const ctx = base()
    const snapshot = { ...ctx }
    const out = withCallAgent(ctx, { conversationId: 1 })
    expect(out.agent).toBe(identity)
    expect(out.sessionId).toBe(ctx.sessionId)
    expect(out.requestUserInput).toBe(ctx.requestUserInput)
    expect(out.emitChatEvent).toBe(ctx.emitChatEvent)
    expect(out.agentOf).toBe(ctx.agentOf)
    expect(ctx).toStrictEqual(snapshot)
    expect(ctx.agent).toBeUndefined()
  })

  it('H11-49 (d) agentOf 交回 undefined（或抛错）→ agent 是 ctx.agent', () => {
    const fixed = { profileName: 'coding', kind: 'spawned' as const }
    const none: ToolContext = { sessionId: 's1', agent: fixed, agentOf: () => undefined }
    expect(withCallAgent(none, { conversationId: 1 }).agent).toBe(fixed)
    const throwing: ToolContext = {
      sessionId: 's1',
      agentOf: () => {
        throw new Error('closed')
      }
    }
    expect(withCallAgent(throwing, { conversationId: 1 }).agent).toBeUndefined()
  })

  it('H11-49 (e) agentOf 收到的恰是 call.conversationId', () => {
    const ctx = base()
    withCallAgent(ctx, { conversationId: 7 })
    expect(ctx.agentOf).toHaveBeenCalledTimes(1)
    expect(ctx.agentOf).toHaveBeenCalledWith(7)
  })
})
