/**
 * 内置安全策略注册表 —— 策略本体全在同目录 `md/<name>[.<lang>].md`（一个策略一语言一文件，
 * 与内置 agent 档案同一套机制）。这些文件**随包发布到磁盘**，运行时经宿主注入的 `readMd`
 * 现读（桌面 = `Resources/builtin-policies/`，见 electron-builder.yml；单测读构建期内联的
 * 同一批文件，见 inlineSources.ts）：侧栏点开一份内置策略时看到的只读笔记本，读的就是
 * 运行时读的那一份。
 *
 * 原则：无策略 = 放行（evaluate 默认 allow）。管 agent 的出厂只有询问、没有硬限制（没有 deny，也没有
 * force-ask）—— 默认尽可能少问，复杂的事交给自动审查（2026-10-01 用户裁定）：
 *   - ask-on-external-path：文件工具在会话权限表（`vars.aclRead` / `vars.aclWrite`，与命令沙箱
 *     同一份）以外 —— 读家目录里的文件、往任何地方写 —— 询问。
 *   - ask-on-command：没被圈进沙箱的命令询问。
 *   - ask-on-session-access（2026-10-20 用户裁定）：`session` 工具查看 / 对话一条别的会话（不是自己的子会话 —— 子会话
 *     不过这道门），不是自己发起的那一轮、也不在会话权限表（`vars.aclSessionRead` / `vars.aclSessionWrite`）里时询问。这类询问**只由人回答**
 *     —— 不是靠 force-ask（那样「允许并记住」就不生效了），而是内置 hook auto-review 的 `when` 把会话客体排除在外。
 *   - ask-on-widget-access（2026-10-27 用户裁定）：`widget` 工具用一个组件（调它的操作、构建、预览、跑 SQL、导出），
 *     会话权限表（`vars.aclWidgetRead` / `vars.aclWidgetWrite`）里没有覆盖这次访问的组件行时询问。同会话访问，
 *     **只由人回答**（auto-review 的 `when` 也把组件客体排除在外）。
 * 用户同名覆盖（含空 rules 的"清空"覆盖）即可放宽或移除任何一道门；想要更多防护（系统目录拒写、
 * 灾难命令拒绝、git / 数据库 / 子会话 / 新站点询问……）写成自己的策略即可 —— 各个执行点都还在，
 * 只是出厂不再挂门。被删掉的出厂策略原文留作测试夹具（`__tests__/fixtures/`）。
 *
 * 2026-10-01 分两轮删掉：先是 protect-system、block-catastrophic-commands、protect-bot-files、
 * protect-shuvix-config、git-safety、ask-on-database、ask-on-sub-session、ask-on-new-site 与「免询问」
 * 开关；随后沙箱改为只把命令的文件访问收进会话目录，protect-credentials（凭据在家目录里，自然被
 * 外部目录访问挡住）、ask-on-write（并入 ask-on-external-path）、session-grants（「允许并记住」
 * 并入 ask-on-external-path 的 match）也删了。
 *
 * 另有一份管远程访问的（2026-10-19 用户裁定，上面那条「没有 deny」的唯一例外，只作用于 network 主体）：
 *   - network-admission：远程访问只允许本机 —— 发送方不是 127.0.0.1 / ::1 的 HTTP 请求一律拒绝。
 *     网络点位没有人可问（ask 会降级为拒绝），所以它直接写 deny；要让别的设备进来，写一份同名的用户
 *     策略替换它（deny 压过一切 allow，另写一份放不开）。设置页按它的状态给引导提示。
 *
 * 另有一份配套随应用提供的日报 bot（2026-10-24 用户裁定，「没有硬限制」之外的另一类 —— 它只放宽，不设门）：
 *   - daily-bot-access：日报 bot（`subject.bot == 'bot:builtin:daily'`）的根 agent 不用问就能读最近 7 天有过
 *     消息的会话（压过 ask-on-session-access），并读写 `~/.shuvix/tracking`（压过 ask-on-external-path）。它每天
 *     傍晚被内置 timer 叫起来，那时多半没有人在场回答询问。两条都是 force-allow，时间窗写在 CEL 里可调。
 *
 * agent 主体那几份的 subject.kind 恒为 [agent]、network-admission 的恒为 [network]（守护测试钉死）：
 * 用户主体（UI 亲手操作）不受内置策略约束 —— 多主体模型见 types.ts SecuritySubject。
 *
 * 多语言：与 builtinAgents 同款「一语言一文件、整文件回退」（精确语言 → 基础语言 → en，
 * 复用 builtinMdFileNames 的候选序），但有一条安全约束是 agent md 没有的 ——
 * **规则唯一事实源恒为 en 文件**：本地化文件只贡献 description、body 与各规则的
 * `prompt`（三者都是人读面），frontmatter 里 rules 的判定字段与 lets 在装配时被忽略
 * （守护测试另行断言各语言规则去掉 prompt 后与 en 一致，让翻译漂移在 CI 就红，
 * 而不是静默改变安全语义）。prompt 破这个例是因为它本就是给人读的一句话，
 * 留在 en 等于让中/日用户在询问卡片上读英文。
 *
 * **书写约定**（引擎不强制，仅约束这几份范本）：规则的 `prompt` 按投递面分口吻 ——
 * ask 门写给用户（这一步的风险），deny 门写给 agent（被拒的原因与替代路径），
 * force-allow 规则不投递、只在策略页当说明；`shuvix-policy-scope` 放
 * subject.kind / object.type / env.host（这份策略管什么），规则放 effect / action /
 * match（在这个范围内怎么判）。各份形状一致 —— 用户照抄时不必先挑该学哪一份。
 *
 * 新增一个内置策略 = 三份 md（en/zh/ja）+ 一个 spec 条目（不再需要 import）。
 * 用户可在 ~/.shuvix/policies/<name>.md 同名覆盖任意内置策略或新增自定义策略
 * （宿主 provider.getUserPolicies 提供，assemble 时合并；用户文件单语言即可）。
 */
import { builtinMdFileNames, type BuiltinMdReader } from '../../subagent/builtinAgents/spec'
import { parsePolicyDefinitionFile } from '../policyFile'
import type { ParsedPolicyFile } from '../types'

/** 一个内置策略的声明 —— 纯名字（文案在 md/ 目录，一语言一文件，运行时经 readMd 现读） */
export interface BuiltinPolicySpec {
  /** name 必须与各语言 md frontmatter 的 name 一致（守护测试钉死） */
  name: string
}

// 装配序 = 决策归因优先序（同 tier 多规则命中时 winning 取先装配者）
export const BUILTIN_POLICY_SPECS: readonly BuiltinPolicySpec[] = [
  { name: 'ask-on-external-path' },
  { name: 'ask-on-command' },
  { name: 'ask-on-session-access' },
  { name: 'ask-on-widget-access' },
  { name: 'network-admission' },
  { name: 'daily-bot-access' },
  { name: 'redact-sensitive' }
]

/** 语言 → 解析产物缓存（键为归一化语言码）。readMd 是进程级稳定接缝（桌面 = 随包目录，
 * 扩展 = 构建期内联表），不放进缓存键：同一语言换读取源只会发生在测试里，那里各有自己的进程 */
const cache = new Map<string, ParsedPolicyFile[]>()

export interface BuildBuiltinPoliciesDeps {
  /** 当前界面语言（i18next.language，如 'zh' / 'zh-CN' / 'ja'）；缺省 en */
  language?: string
  /** 内置策略 md 的读取口（宿主注入；入参是目录内文件名，没有那一版返回 null） */
  readMd: BuiltinMdReader
}

/**
 * 解析全部内置策略（按界面语言取 description/body/规则 prompt；**rules 的判定字段恒取 en**）。
 * 内置 md 随包发布、用户改不到，en 文件缺失或解析失败即开发期错误 —— 直接 throw
 * （对齐「内置策略缺失比启动失败更危险」；守护测试保证发布前必绿）。
 */
export function buildBuiltinPolicies(deps: BuildBuiltinPoliciesDeps): ParsedPolicyFile[] {
  const key = (deps.language || 'en').toLowerCase()
  const cached = cache.get(key)
  if (cached) return cached

  const policies = BUILTIN_POLICY_SPECS.map(({ name }) => {
    // en 是规则唯一事实源，必须读得到 —— 它缺席意味着打包漏了文件，绝不能静默退化成
    // 「没有这道门」
    const canonicalRaw = deps.readMd(`${name}.md`)
    if (canonicalRaw === null) {
      throw new Error(`builtin security policy '${name}' is missing its md file (${name}.md)`)
    }
    const canonical = parsePolicyDefinitionFile(canonicalRaw, name)
    if (!canonical || canonical.name !== name) {
      throw new Error(`builtin security policy '${name}' failed to parse`)
    }
    // 本地化文件：与 builtinMdFileNames 同一条回退序（精确语言 → 基础语言），en 自身跳过
    const localizedRaw = builtinMdFileNames(name, deps.language)
      .filter((fileName) => fileName !== `${name}.md`)
      .map((fileName) => deps.readMd(fileName))
      .find((text) => text !== null)
    if (!localizedRaw) return canonical

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
