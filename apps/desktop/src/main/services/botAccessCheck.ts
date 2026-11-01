/**
 * bot 定时运行的权限核对的宿主一侧（docs/bot-access-check-design.md）：认出这份 bot 在哪些位置定时跑、此刻生效的策略
 * 里哪些点名了它，再给每个位置搭一个试算的安全上下文交给 agent-runtime 的 botAccessNote 去判、去写回执。
 *
 * 三个入口，同一段文字：
 *   - bot 文件写下之后（forBotFile）：带定时的 bot，说它没人在场时能做什么；没有策略点名它就说怎么配一份；
 *   - 点名了 bot 的策略写下之后（forPolicyFile）：**按装进去之后**（顶替策略目录里同文件名的那份）把它点名的每个 bot
 *     核对一遍 —— 写坏的身份、压不过 ask 的 `allow`、放得太宽的路径当场就看得到；
 *   - `shuvix policy check [<file>] --bot <name>`（forBotName）。
 *
 * 纯逻辑：bot / 项目 / 策略 / 审查状态 / 试算上下文全由 deps 注入（botAccessWiring 接线），单测拿真实引擎跑。
 *
 * 试算的会话权限表是近似：只有工作目录、bot 文件与项目知识库三行（真的会话还有临时目录、产物、工具结果、只读的技能
 * 目录与项目选中的知识库），工作目录的取舍也只用 aclDir（真的会话还拒绝 ~/.shuvix、userData 里外的目录）。点名路径
 * 恰好落在那几处时，核对会说「要问」而真的运行不问，或反过来 —— 都是少见的边角，回执照常给。
 */
import { basename } from 'path'
import {
  botAccessNote,
  botIdentitiesNamedBy,
  celQuote,
  getTriggerPoint,
  parseBotDefinitionFile,
  parsePolicyDefinitionFile,
  policyNamesBot,
  resolvePolicyFiles,
  type BotAccessLocation,
  type BotBinding,
  type ParsedBotFile,
  type ParsedPolicyFile,
  type SecurityContext,
  type SecurityHostProvider,
  type UserPolicyFile
} from '@shuvix/agent-runtime'

export interface BotAccessDeps {
  home: string
  /** 文件系统根（家目录之外的反例放在它下面） */
  root: string
  sep: string
  /** 回执里写策略目录的说法（`~/.shuvix/policies/`） */
  policiesDirLabel: string
  /** 注册表里生效的 bot（遮蔽的、非法的不算） */
  bots(): Array<{ file: ParsedBotFile; basePath: string }>
  /** 一份 bot 文件的身份（botService.identityForFile） */
  identityForFile(file: Pick<ParsedBotFile, 'name' | 'objectId'>, basePath: string): string
  /** 名字对得上的没归档项目（projectService.projectsNamed） */
  projectsNamed(name: string): Array<{ id: string; name: string; path: string }>
  /** 项目知识库的目录（定时运行在项目里时它在会话权限表里，可读写） */
  projectKnowledgeDir(projectId: string): string
  /** 临时运行的工作目录（每次运行一份新的；这里只要一个形状对的路径） */
  temporaryWorkspace(): string
  /** 一个目录进会话权限表的写法（realpath；`/`、覆盖家目录 → null），同权限表的派生行 */
  aclDir(dir: string): string | null
  /** 此刻的用户策略（现扫，同名的几份都在） */
  userPolicies(): UserPolicyFile[]
  builtinPolicies(): ParsedPolicyFile[]
  isDisabled(policy: ParsedPolicyFile): boolean
  /** 自动审查此刻会不会接询问（有开着的 permission.request hook） */
  reviewActive(): boolean
  isDirectory(path: string): boolean
  /** 一次定时运行的试算上下文（toolContext.getDesktopBotRunTrial） */
  trial(
    run: { bot: string; workingDirectory: string; aclRead: string[]; aclWrite: string[] },
    trial: { userPolicies: UserPolicyFile[]; logger: NonNullable<SecurityHostProvider['logger']> }
  ): { context: SecurityContext; vars: Record<string, unknown> }
}

export interface BotAccessChecker {
  /** bot 文件写下之后（path = 它的绝对路径）；没有触发绑定 / 解析不过 / 没有能跑的位置 → null */
  forBotFile(text: string, path: string): string | null
  /** 策略文件写下之后，按装进策略目录 `fileName` 算；没有点名 bot / 解析不过 → null */
  forPolicyFile(text: string, fileName: string): string | null
  /** CLI：按名字或身份查一个 bot，可带一份按装进去之后算的策略 */
  forBotName(
    nameOrIdentity: string,
    policy?: { text: string; fileName: string }
  ): { text: string } | { error: string }
}

const TEMPORARY = 'a temporary folder'

/**
 * 真的会无人值守地跑的绑定：埋点在这个版本上存在、且不属于任何会话（今天就是 timer.fired）。不认识的埋点解析器
 * 留着、只是不会触发 —— 它不该换来一段权限核对
 */
function runnableBindings(bot: ParsedBotFile): BotBinding[] {
  return (bot.bindings ?? []).filter((b) => getTriggerPoint(b.trigger)?.scope === 'global')
}

const NO_SCHEDULE = (name: string): string =>
  `Bot ${name} has no schedule (shuvix-bot-on), so nothing of it runs unattended; in its chats asks reach the ` +
  'user as usual.'
const NOWHERE = (name: string): string =>
  `Bot ${name}: none of its bindings names exactly one project, so every run would be skipped and nothing of it ` +
  'runs unattended.'

export function createBotAccessChecker(deps: BotAccessDeps): BotAccessChecker {
  const effectiveWith = (users: UserPolicyFile[]): ParsedPolicyFile[] =>
    resolvePolicyFiles(deps.builtinPolicies(), users)
      .filter((entry) => !entry.shadowedBy && !deps.isDisabled(entry.policy))
      .map((entry) => entry.policy)

  /** 一个 bot 的回执；没有能跑的位置（绑定的项目全对不上 —— 排期核对已经说了会被跳过）→ null */
  const check = (bot: ParsedBotFile, basePath: string, users: UserPolicyFile[]): string | null => {
    const identity = deps.identityForFile(bot, basePath)
    const places = new Map<string, { workdir: string; projectId?: string }>()
    for (const binding of runnableBindings(bot)) {
      if (!binding.project) {
        places.set(TEMPORARY, { workdir: deps.temporaryWorkspace() })
        continue
      }
      const matches = deps.projectsNamed(binding.project)
      if (matches.length !== 1) continue
      const project = matches[0]
      places.set(`project ${project.name}`, { workdir: project.path, projectId: project.id })
    }
    if (places.size === 0) return null

    // 试算给的变量与一条真的会话一样全（getDesktopBotRunTrial），所以「vars.x 宿主没给」只会是策略里拼错了变量名 ——
    // 照实报给 agent，不滤
    const warnings: string[] = []
    const logger = {
      info: () => {},
      warn: (m: string) => void warnings.push(m),
      error: (m: string) => void warnings.push(m)
    }
    let firstVars: Record<string, unknown> | undefined
    const locations: BotAccessLocation[] = [...places].map(([label, place]) => {
      const dirs = [
        deps.aclDir(place.workdir),
        deps.aclDir(basePath),
        place.projectId ? deps.aclDir(deps.projectKnowledgeDir(place.projectId)) : null
      ].filter((d): d is string => !!d)
      const trial = deps.trial(
        { bot: identity, workingDirectory: place.workdir, aclRead: dirs, aclWrite: dirs },
        { userPolicies: users, logger }
      )
      firstVars ??= trial.vars
      return {
        label,
        // `vars.workspace` 随位置变：点名路径按这个位置的变量取
        vars: trial.vars,
        judge: (action, object, tool) => trial.context.judgeGate(action, object, { tool })
      }
    })
    const naming = effectiveWith(users).filter((p) => policyNamesBot(p, identity))
    return botAccessNote({
      botName: bot.name,
      identity,
      identityFrom: !bot.objectId ? 'name' : identity === bot.objectId ? 'id' : 'untrusted-id',
      naming,
      locations,
      reviewActive: deps.reviewActive(),
      host: {
        home: deps.home,
        root: deps.root,
        sep: deps.sep,
        vars: firstVars ?? {},
        isDirectory: deps.isDirectory
      },
      policiesDirLabel: deps.policiesDirLabel,
      now: new Date(),
      warnings: () => warnings
    })
  }

  /** 策略按装进策略目录 `fileName` 之后的用户策略清单 */
  const installed = (policy: ParsedPolicyFile, fileName: string): UserPolicyFile[] => [
    ...deps.userPolicies().filter((p) => p.fileName !== fileName),
    { ...policy, fileName }
  ]

  const parsePolicy = (text: string, fileName: string): ParsedPolicyFile | null =>
    parsePolicyDefinitionFile(text, fileName.replace(/\.md$/i, ''))

  return {
    forBotFile(text, path) {
      const bot = parseBotDefinitionFile(text, basename(path).replace(/\.md$/i, ''))
      if (!bot || runnableBindings(bot).length === 0) return null
      return check(bot, path, deps.userPolicies())
    },

    forPolicyFile(text, fileName) {
      const policy = parsePolicy(text, fileName)
      if (!policy) return null
      const identities = botIdentitiesNamedBy(policy)
      if (identities.length === 0) return null
      const users = installed(policy, fileName)
      const bots = deps.bots()
      const parts: string[] = [`Checked with this policy installed as ${fileName}.`]
      for (const identity of identities) {
        const matched = bots.filter((b) => deps.identityForFile(b.file, b.basePath) === identity)
        const quoted = celQuote(identity)
        if (matched.length === 0) {
          const byName = bots.find((b) => b.file.name === identity)
          parts.push(
            byName
              ? `subject.bot == ${quoted}: bot ${identity} has a shuvix-id, so policies know it as ` +
                  `${celQuote(deps.identityForFile(byName.file, byName.basePath))}, not by its name — this ` +
                  'condition never matches.'
              : `subject.bot == ${quoted}: no bot is known by that (a bot's identity is its shuvix-id, or its ` +
                  'name when it has none) — this condition never matches.'
          )
          continue
        }
        for (const entry of matched) {
          if (runnableBindings(entry.file).length === 0) {
            parts.push(NO_SCHEDULE(entry.file.name))
            continue
          }
          parts.push(check(entry.file, entry.basePath, users) ?? NOWHERE(entry.file.name))
        }
      }
      return parts.length > 1 ? parts.join('\n\n') : null
    },

    forBotName(nameOrIdentity, policy) {
      const wanted = nameOrIdentity.trim()
      const entry = deps
        .bots()
        .find((b) => b.file.name === wanted || deps.identityForFile(b.file, b.basePath) === wanted)
      if (!entry) return { error: `No bot is named ${wanted}.` }
      let users = deps.userPolicies()
      const head: string[] = []
      if (policy) {
        const parsed = parsePolicy(policy.text, policy.fileName)
        if (!parsed) return { error: `${policy.fileName} is not a valid policy file.` }
        users = installed(parsed, policy.fileName)
        head.push(`Checked with ${policy.fileName} installed.`)
      }
      if (runnableBindings(entry.file).length === 0) {
        return { text: [...head, NO_SCHEDULE(entry.file.name)].join('\n') }
      }
      const note = check(entry.file, entry.basePath, users) ?? NOWHERE(entry.file.name)
      return { text: [...head, note].join('\n') }
    }
  }
}
