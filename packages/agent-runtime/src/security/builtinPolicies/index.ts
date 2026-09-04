/**
 * 内置安全策略注册表 —— 策略本体全在同目录 `md/<name>[.<lang>].md`（`?raw` 构建期内联，
 * 两端统一：扩展没有文件系统，桌面的包也以源码内联进构建）。
 *
 * 原则：无策略 = 放行（evaluate 默认 allow）。出厂防护全部在此以策略表达 ——
 * protect-credentials（凭据写 deny + 读 ask）/ protect-system（系统目录写 deny，
 * 原 pathSafety hook 的策略化替身）/ block-catastrophic-commands（毁灭整机的
 * 少数命令写法直接 deny，原 bash-audit 内置 hook 的策略化替身）/ ask-on-read（工作区外读取门）/
 * ask-on-write（写入询问门）/ review-memory-writes（记忆写入 force-ask —— 免询问也照问）/
 * ask-on-command（命令询问门）/ git-safety
 * （git 危险操作门，含 checkout&&force / branch&&delete 的参数级细化）/
 * ask-on-database（可写数据库连接的逐条查询询问）/ ask-on-sub-session（开子会话前询问 ——
 * 唯一一条走 L1 全工具门的内置策略：客体是 {type:'invocation'}，判据落在工具维度
 * tool.name/tool.operation 上，因为「开一条子会话」没有路径/命令那样的专属客体，
 * 它的分量在于开出去的是**一整场会自己跑的对话**）——
 * 用户同名覆盖（含空 rules 的"清空"覆盖）即可放宽或移除任何一道门。
 *
 * 出厂内容**不只有防护**：session-auto-allow 与 session-path-grants 用
 * `effect: force-allow` 表达会话授权（免询问开关 / 「允许并记住」）。它们曾是引擎里写死的
 * 第四层规则来源，下沉成 md 后同样可见、可覆盖、可移除；授权条目本身仍是会话数据，
 * 经 vars.autoAllow / vars.grantedRead / vars.grantedWrite 进来（见 policyVars.ts）。
 *
 * 全部规则的 subject.kind 恒为 [agent]（守护测试钉死）：防护与授权都只作用于智能体，
 * 用户主体（UI 亲手操作）不受内置策略约束 —— 多主体模型见 types.ts SecuritySubject。
 * 这套出厂组合与安全模块迁移前的询问围栏逐点等价（见设计文档「出厂等价性」）。
 *
 * 多语言：与 builtinAgents 同款「一语言一文件、整文件回退」（精确语言 → 基础语言 → en，
 * 复用 pickLocalizedSource），但有一条安全约束是 agent md 没有的 ——
 * **规则唯一事实源恒为 en 文件**：本地化文件只贡献 description、body 与各规则的
 * `prompt`（三者都是人读面），frontmatter 里 rules 的判定字段与 lets 在构建时被忽略
 * （守护测试另行断言各语言规则去掉 prompt 后与 en 一致，让翻译漂移在 CI 就红，
 * 而不是静默改变安全语义）。prompt 破这个例是因为它本就是给人读的一句话，
 * 留在 en 等于让中/日用户在询问卡片上读英文。
 *
 * **书写约定**（引擎不强制，仅约束这十一份范本）：规则的 `prompt` 按投递面分口吻 ——
 * ask 门写给用户（这一步的风险），deny 门写给 agent（被拒的原因与替代路径），
 * force-allow 规则不投递、只在策略页当说明；`shuvix-policy-scope` 放
 * subject.kind / object.type / env.host（这份策略管什么），规则放 effect / action /
 * match（在这个范围内怎么判）。十份形状一致 —— 用户照抄时不必先挑该学哪一份。
 * （session-auto-allow 的 scope 只有 subject.kind：它本就跨所有客体类型，
 * 不写 object.type 正是"不约束"的正确表达，不是漏写。）
 *
 * 新增一个内置策略 = 三份 md（en/zh/ja）+ 一条 import + 一个 spec 条目。
 * 用户可在 ~/.shuvix/policies/<name>.md 同名覆盖任意内置策略或新增自定义策略
 * （宿主 provider.getUserPolicies 提供，assemble 时合并；用户文件单语言即可）。
 */
import { pickLocalizedSource } from '../../subagent/builtinAgents/spec'
import { parsePolicyDefinitionFile } from '../policyFile'
import type { ParsedPolicyFile } from '../types'
import askOnReadEn from './md/ask-on-read.md?raw'
import askOnReadZh from './md/ask-on-read.zh.md?raw'
import askOnReadJa from './md/ask-on-read.ja.md?raw'
import reviewMemoryWritesEn from './md/review-memory-writes.md?raw'
import reviewMemoryWritesZh from './md/review-memory-writes.zh.md?raw'
import reviewMemoryWritesJa from './md/review-memory-writes.ja.md?raw'
import askOnWriteEn from './md/ask-on-write.md?raw'
import protectBotFilesEn from './md/protect-bot-files.md?raw'
import protectBotFilesZh from './md/protect-bot-files.zh.md?raw'
import protectBotFilesJa from './md/protect-bot-files.ja.md?raw'
import askOnWriteZh from './md/ask-on-write.zh.md?raw'
import askOnWriteJa from './md/ask-on-write.ja.md?raw'
import protectCredentialsEn from './md/protect-credentials.md?raw'
import protectCredentialsZh from './md/protect-credentials.zh.md?raw'
import protectCredentialsJa from './md/protect-credentials.ja.md?raw'
import protectSystemEn from './md/protect-system.md?raw'
import protectSystemZh from './md/protect-system.zh.md?raw'
import protectSystemJa from './md/protect-system.ja.md?raw'
import blockCatastrophicCommandsEn from './md/block-catastrophic-commands.md?raw'
import blockCatastrophicCommandsZh from './md/block-catastrophic-commands.zh.md?raw'
import blockCatastrophicCommandsJa from './md/block-catastrophic-commands.ja.md?raw'
import askOnCommandEn from './md/ask-on-command.md?raw'
import askOnCommandZh from './md/ask-on-command.zh.md?raw'
import askOnCommandJa from './md/ask-on-command.ja.md?raw'
import gitSafetyEn from './md/git-safety.md?raw'
import gitSafetyZh from './md/git-safety.zh.md?raw'
import gitSafetyJa from './md/git-safety.ja.md?raw'
import askOnDatabaseEn from './md/ask-on-database.md?raw'
import askOnDatabaseZh from './md/ask-on-database.zh.md?raw'
import askOnDatabaseJa from './md/ask-on-database.ja.md?raw'
import askOnSubSessionEn from './md/ask-on-sub-session.md?raw'
import askOnSubSessionZh from './md/ask-on-sub-session.zh.md?raw'
import askOnSubSessionJa from './md/ask-on-sub-session.ja.md?raw'
import sessionAutoAllowEn from './md/session-auto-allow.md?raw'
import sessionAutoAllowZh from './md/session-auto-allow.zh.md?raw'
import sessionAutoAllowJa from './md/session-auto-allow.ja.md?raw'
import sessionPathGrantsEn from './md/session-path-grants.md?raw'
import sessionPathGrantsZh from './md/session-path-grants.zh.md?raw'
import sessionPathGrantsJa from './md/session-path-grants.ja.md?raw'

/** 一个内置策略的各语言 md 原文（键为语言代码，'en' 必有且为规则事实源） */
export interface BuiltinPolicySpec {
  name: string
  sources: Record<string, string> & { en: string }
}

/** name 必须与各语言 md frontmatter 的 name 一致（守护测试钉死） */
// 装配序 = 决策归因优先序（同 tier 多规则命中时 winning 取先装配者）：
// 更具体的 protect-credentials 在前，凭据读取归因到它而非泛化的 ask-on-read
export const BUILTIN_POLICY_SPECS: readonly BuiltinPolicySpec[] = [
  {
    name: 'protect-credentials',
    sources: { en: protectCredentialsEn, zh: protectCredentialsZh, ja: protectCredentialsJa }
  },
  {
    name: 'protect-system',
    sources: { en: protectSystemEn, zh: protectSystemZh, ja: protectSystemJa }
  },
  {
    name: 'block-catastrophic-commands',
    sources: {
      en: blockCatastrophicCommandsEn,
      zh: blockCatastrophicCommandsZh,
      ja: blockCatastrophicCommandsJa
    }
  },
  {
    name: 'protect-bot-files',
    sources: { en: protectBotFilesEn, zh: protectBotFilesZh, ja: protectBotFilesJa }
  },
  {
    name: 'ask-on-read',
    sources: { en: askOnReadEn, zh: askOnReadZh, ja: askOnReadJa }
  },
  {
    name: 'ask-on-write',
    sources: { en: askOnWriteEn, zh: askOnWriteZh, ja: askOnWriteJa }
  },
  {
    name: 'review-memory-writes',
    sources: { en: reviewMemoryWritesEn, zh: reviewMemoryWritesZh, ja: reviewMemoryWritesJa }
  },
  {
    name: 'ask-on-command',
    sources: { en: askOnCommandEn, zh: askOnCommandZh, ja: askOnCommandJa }
  },
  {
    name: 'git-safety',
    sources: { en: gitSafetyEn, zh: gitSafetyZh, ja: gitSafetyJa }
  },
  {
    name: 'ask-on-database',
    sources: { en: askOnDatabaseEn, zh: askOnDatabaseZh, ja: askOnDatabaseJa }
  },
  {
    name: 'ask-on-sub-session',
    sources: { en: askOnSubSessionEn, zh: askOnSubSessionZh, ja: askOnSubSessionJa }
  },
  // force-allow 层两份放最后：它们与上面的防护不在同一 tier，装配序对结算无影响，
  // 但列表尾部更贴合阅读顺序（先看拦什么，再看什么情况下放行）
  {
    name: 'session-auto-allow',
    sources: { en: sessionAutoAllowEn, zh: sessionAutoAllowZh, ja: sessionAutoAllowJa }
  },
  {
    name: 'session-path-grants',
    sources: { en: sessionPathGrantsEn, zh: sessionPathGrantsZh, ja: sessionPathGrantsJa }
  }
]

/** 语言 → 解析产物缓存（md 是编译期常量，无失效问题；键为归一化语言码） */
const cache = new Map<string, ParsedPolicyFile[]>()

/**
 * 解析全部内置策略（按界面语言取 description/body；**rules 恒取 en**）。
 * 内置 md 随包发布、用户改不到，解析失败即开发期错误 —— 直接 throw
 * （对齐「内置策略缺失比启动失败更危险」；守护测试保证发布前必绿）。
 */
export function buildBuiltinPolicies(language?: string): ParsedPolicyFile[] {
  const key = (language || 'en').toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached

  const policies = BUILTIN_POLICY_SPECS.map(({ name, sources }) => {
    const canonical = parsePolicyDefinitionFile(sources.en, name)
    if (!canonical || canonical.name !== name) {
      throw new Error(`builtin security policy '${name}' failed to parse`)
    }
    const localizedRaw = pickLocalizedSource(sources, language)
    if (localizedRaw === sources.en) return canonical

    const localized = parsePolicyDefinitionFile(localizedRaw, name)
    if (!localized || localized.name !== name) {
      throw new Error(`builtin security policy '${name}' (${key}) failed to parse`)
    }
    // 本地化文件只贡献人读面；规则以 en 为准（各语言规则一致性由守护测试保证）
    return {
      ...canonical,
      // displayName 解析回退为 name（=各语言相同）时不覆盖 en 的显示名
      displayName: localized.displayName !== name ? localized.displayName : canonical.displayName,
      description: localized.description || canonical.description,
      // 唯一从本地化文件取的规则字段：prompt 是给人看的提示语，不参与匹配。按下标对位 ——
      // 条数不等说明这份翻译已经与 en 结构脱节，此时整体不 overlay（宁可整卡英文，
      // 也不要按错位的下标拼出一张张冠李戴的提示语）。守护测试保证仓内不会走到这一支
      rules:
        localized.rules.length === canonical.rules.length
          ? canonical.rules.map((rule, i) => {
              const prompt = localized.rules[i].prompt
              return prompt ? { ...rule, prompt } : rule
            })
          : canonical.rules,
      body: localized.body || canonical.body
    }
  })
  cache.set(key, policies)
  return policies
}
