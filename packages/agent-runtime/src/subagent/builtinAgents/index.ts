/**
 * 内置档案（md 文件 + 统一构建器，跨端共享）。
 *
 * 所有内置 agent —— 含五个基座档案 work / chat / notebook / bot / tab —— 的文案都以
 * `md/<name>[.<lang>].md` 维护，格式与用户档案 `~/.shuvix/agents/<name>.md` 完全一致、
 * 经同一个解析器读取。这些文件**随包发布到磁盘**，运行时经宿主注入的 `readMd` 现读
 * （桌面 = Resources/builtin-agents；单测读构建期内联的同一批文件）：侧栏点开一份内置档案
 * 时看到的，就是运行时读的那一份。宿主 registry 调 buildBuiltinProfiles(deps) 现算列表
 * （语言切换 / 宿主参数变化自动跟随），用户仍可用同名用户档案覆盖（合并逻辑在各端 registry 内）。
 *
 * 加一个内置 agent = 在 md/ 放三份文件 + 在本文件加一个 spec 条目（不再需要 import）。
 */
import type { AgentProfile } from '../types'
import { buildBuiltinProfile, type BuiltinProfileDeps, type BuiltinProfileSpec } from './spec'
import { KNOWLEDGE_WRITER_PROFILE_NAME } from '../../knowledge/review'

export {
  buildBuiltinProfile,
  builtinMdFileNames,
  pickLocalizedSource,
  type BuiltinMdReader,
  type BuiltinProfileDeps,
  type BuiltinProfileSpec,
  type BuiltinProfileSources
} from './spec'

/**
 * 三个基座档案名 —— 会话根 Agent 的档案由**会话形态推导**，不是选出来的：归属项目的
 * 会话恒为 `work`，不归属任何项目的会话恒为 `chat`，笔记本会话恒为 `notebook`。
 * 没有设置项、没有会话内切换；三者都可被同名用户档案 `~/.shuvix/agents/<name>.md`
 * 覆盖 —— 那是定制人格的唯一入口，名字本身固定。
 *
 * 曾经它们放在 chat-protocol（输入框的档案选择器要按名着色）；选择器随「会话内切换
 * 档案」一并下线后，渲染层不再需要这些名字，事实源就回到了唯一还用它们的这一层。
 */
export const WORK_PROFILE_NAME = 'work'
export const CHAT_PROFILE_NAME = 'chat'
export const NOTEBOOK_PROFILE_NAME = 'notebook'
/**
 * Bot 会话的基座。形态判据是 `settings.bot` —— 它绑定了哪一份 `~/.shuvix/bots/<name>.md`，
 * 那份文件的正文经 `renderBotContext` 围栏后追加到本会话**根** Agent 的系统提示词末尾。
 */
export const BOT_PROFILE_NAME = 'bot'
/**
 * Chrome 标签页会话的基座。形态判据是 `settings.chromeTab` —— 用户在自己 Chrome 的某个标签页上打开了
 * ShuviX 侧边栏，这条会话就挂在那一页上。只有它声明 `mcp:chrome`（用户真实的 Chrome）：桌面自己的
 * 会话只用应用内的浏览器面板。
 */
export const TAB_PROFILE_NAME = 'tab'

/**
 * 工作档案 —— 归属项目的会话的基座（形态推导，见 WORK_PROFILE_NAME）：把需求敲定、
 * 把成规模的活儿交给 `coding` 子会话、自己做验收。
 */
export const WORK_SPEC: BuiltinProfileSpec = {
  name: WORK_PROFILE_NAME
}

/**
 * 聊天档案 —— 不归属任何项目的会话的基座，与 work 是**两条路线**而非强弱之分：
 * 它握着完整的内置工具（含 ls/grep/glob）、正文只讲「自己把活干完」，不写任何把活外包
 * 出去的引导；work 则相反，把成规模的活儿交给 `coding` 子会话、自己做需求与验收。
 * 哪条路线用在哪种会话由会话形态决定（有没有项目），不是配置。
 */
export const CHAT_SPEC: BuiltinProfileSpec = {
  name: CHAT_PROFILE_NAME
}

/**
 * Bot 档案 —— **bot 会话的基座**。与 work / chat 的分工不同，它的分界是「说话」与「干活」：
 * 正文规定它以消息而非文档的形状答复、把一切真正的活交给子会话，而**它是谁**由会话绑定的
 * 那份 bot md 经 systemContext 注入。
 *
 * 工具面**刻意收窄**（没有 bash / write，也不声明内置能力服务器 ssh / browser / database）：这是「执行任务不受人设
 * 干扰」的结构落点 —— 人格够得到的地方只能看不能动，要动就得开一条子会话，而子会话按自己的
 * 档案生成系统提示词、拿不到那段围栏。靠提示词纪律表达这条分工是不够的：一个握着 bash 的
 * 人格会顺手把活干了，那正是要避免的事。`edit` 留着是为了让 bot 维护自己那份 md（写入是一次
 * 普通的外部目录询问（ask-on-external-path）；恒询问的 `protect-bot-files` 已于 2026-10-01 从出厂删除）。
 */
export const BOT_SPEC: BuiltinProfileSpec = {
  name: BOT_PROFILE_NAME
}

/**
 * 笔记本档案 —— **每一条笔记本会话的基座**（主窗口里的笔记、知识库条目、bot / agent md、技能，
 * 从系统或应用里打开的 md 窗口）。文档只经 `doc_read` / `doc_edit` / `doc_insert` 改：有编辑器显示着它
 * 时在编辑器的当前缓冲上当场执行，没有就直接改磁盘（见 chat-protocol liveDocument.ts）。工具面刻意
 * 不握 edit / bash：对这份文档的改动都得经协作编辑工具（宿主也让 write / edit 碰它时拒绝），`write`
 * 只用来写别的文件（要链接过去的新笔记、单独存成文件的图）。
 */
export const NOTEBOOK_SPEC: BuiltinProfileSpec = {
  name: NOTEBOOK_PROFILE_NAME
}

/**
 * 标签页档案 —— **Chrome 标签页会话的基座**（ShuviX 扩展的侧边栏）。工具面刻意收窄到
 * 「用户的 Chrome + 询问 + 画图」：这类会话的主要输入是网页内容，而网页内容不可信 ——
 * 一个同时握着 bash / write 的 agent 读到一段恶意页面文字，代价是用户的整台机器。
 * 要放宽就同名覆盖 `~/.shuvix/agents/tab.md`。
 */
export const TAB_SPEC: BuiltinProfileSpec = {
  name: TAB_PROFILE_NAME
}

/**
 * 编码智能体 —— 从 work 里拆出来的工程人格：完整的本地工具链 + 做事纪律（ssh / browser / database
 * 是按会话勾选的内置能力服务器，子会话随父会话继承勾选）。
 * work 只留编排的薄壳，遇到成规模的工程活儿开一条 `coding` 子会话把活交过去
 * （session 工具的 `agent_profile`）—— 它是子会话的档案，不是用户切换的目标。
 */
export const CODING_SPEC: BuiltinProfileSpec = {
  name: 'coding'
}

export const EXPLORE_SPEC: BuiltinProfileSpec = {
  name: 'explore'
}

export const WIDGET_SPEC: BuiltinProfileSpec = {
  name: 'widget',
  requiredParams: ['widgetsRoot']
}

/**
 * 标题生成 agent —— auto-title 内置 hook 的执行侧。
 * 模型走 agent md `shuvix-model` 的通用链路：内置档案不声明 → 跟随派发方 = 会话当前模型；
 * 想钉住便宜模型就覆盖 `~/.shuvix/agents/titler.md` 写上 `shuvix-model`
 * （旧的「标题模型」专项设置已废弃）。经 session 工具落标题。
 */
export const TITLER_SPEC: BuiltinProfileSpec = {
  name: 'titler'
}

/**
 * 知识库条目的提交检查（OKF）—— `knowledge` 工具 `submit` 的执行侧，**只由宿主派发**：主 agent 用文件
 * 工具把条目写进库，提交时宿主同步派它补齐元数据、判内容站不站得住，经 `next` 交回 `{passed, report}`；
 * 通过的章由宿主盖（knowledge/review.ts）。元数据的写法（键表、类型词汇表、出处规则）只写在这份提示词里 ——
 * 主 agent 因此不必为它付每会话的提示词。
 *
 * 不依赖任何宿主参数：要检查的文件、所在的库、提交者都由任务文本给出。
 */
export const KNOWLEDGE_WRITER_SPEC: BuiltinProfileSpec = {
  name: KNOWLEDGE_WRITER_PROFILE_NAME
}

/**
 * 权限审查员 —— 询问点自动审查的执行侧（设计稿 docs/permission-review-design.md）：内置判定型 hook
 * `auto-review` 在策略判出 ask、弹卡片之前派发它，它经 `next` 交回 allow / ask / deny。
 * 不声明任何工具（只有结果契约附带的 `next`）、不要注入，`shuvix-thinking: low` —— 系统提示词就是
 * 那段审查规则，一次请求出结论。思考是 low 而不是 off，出自真模型探针（e2e/live/review.probe.ts）：
 * kimi-for-coding 一族关掉思考时不调 `next`、把判决写成正文里的 XML，追问也一样；low 档每条都经
 * `next` 作答、中位 2.8 秒。名字刻意不叫 `reviewer`：用户照着说明书里的示例建一份代码审查
 * agent 就会按名覆盖它。
 */
export const PERMISSION_REVIEWER_PROFILE_NAME = 'permission-reviewer'
export const PERMISSION_REVIEWER_SPEC: BuiltinProfileSpec = {
  name: PERMISSION_REVIEWER_PROFILE_NAME
}

/**
 * 内置 spec 全集（五个基座档案 work / chat / notebook / bot / tab 居首，其后为可派发的具名 agent；
 * widget 依赖宿主根目录参数，缺参自动跳过）
 */
export const BUILTIN_PROFILE_SPECS: readonly BuiltinProfileSpec[] = [
  WORK_SPEC,
  CHAT_SPEC,
  NOTEBOOK_SPEC,
  BOT_SPEC,
  TAB_SPEC,
  CODING_SPEC,
  EXPLORE_SPEC,
  WIDGET_SPEC,
  TITLER_SPEC,
  KNOWLEDGE_WRITER_SPEC,
  PERMISSION_REVIEWER_SPEC
]

/**
 * 「基座档案」——某种会话形态的根 Agent 人格，由形态推导、按名钉死，而非可派发的具名 agent：
 * `work` 是项目会话，`chat` 是不归属项目的会话，`notebook` 是笔记本会话，`bot` 是 bot 会话，
 * `tab` 是 Chrome 标签页会话。
 *
 * 三者都可被同名用户档案覆盖（这正是自定义人格的入口），但都不该被点名：不进派发工具
 * 的可用名单（会诱导 LLM 拿基座档案当一次性任务 agent 使 —— 它们是某种会话形态的人格，
 * 不是为一次性任务写的；论工具清单它们与 coding 逐字相同，分工全在正文），也不接受作为
 * 子会话的 `agent_profile`（子会话不点名就自然落到自己形态的基座上）。
 */
export const BASE_PROFILE_NAMES: ReadonlySet<string> = new Set([
  WORK_PROFILE_NAME,
  CHAT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME,
  BOT_PROFILE_NAME,
  TAB_PROFILE_NAME
])

/**
 * 只由宿主派发的档案 —— 比基座更严：派发工具**按名也解析不到**（基座只是不进可用名单），子会话的
 * `agent_profile` 也不收。权限审查员与知识库写手都是一道门：被检查的 agent 要是能直接派发它们，就能
 * 反复拿它们试探「哪种写法能过」。hook 仍可点名（内置 `auto-review` 正是这么派发审查员的）。
 */
export const HOST_ONLY_PROFILE_NAMES: ReadonlySet<string> = new Set([
  PERMISSION_REVIEWER_PROFILE_NAME,
  KNOWLEDGE_WRITER_PROFILE_NAME
])

/** 按宿主 deps 现算全部可用内置档案（文案按当前语言解析） */
export function buildBuiltinProfiles(deps: BuiltinProfileDeps): AgentProfile[] {
  return BUILTIN_PROFILE_SPECS.map((spec) => buildBuiltinProfile(spec, deps)).filter(
    (p): p is AgentProfile => p !== null
  )
}
