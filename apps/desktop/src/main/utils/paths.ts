/**
 * 路径相关工具函数 — 所有数据目录的统一入口
 */

import { join, resolve, dirname, delimiter } from 'path'
import { homedir } from 'os'
import { mkdirSync, existsSync } from 'fs'
import { app } from 'electron'
import i18next from 'i18next'

/** 确保目录存在并返回路径 */
function ensureDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** 应用数据目录：~/Library/Application Support/shuvix/data/ */
export function getDataDir(): string {
  return ensureDir(join(app.getPath('userData'), 'data'))
}

/**
 * 会话转写目录：<userData>/data/sessions/，每会话一个 `<sessionId>.jsonl`。
 *
 * 与 shuvix.db 同级 —— 二者共同构成「本地结构化数据」，备份时一起带走。
 * 不放 ~/.shuvix/：那里是用户自己编写的配置（skills / agents / policies / widgets），
 * 会话转写是运行时产物。
 */
export function getSessionsDir(): string {
  return ensureDir(join(getDataDir(), 'sessions'))
}

/** 用户配置目录：~/.shuvix/ */
export function getUserConfigDir(): string {
  return ensureDir(join(homedir(), '.shuvix'))
}

/** TTS 临时音频文件缓存目录 */
export function getTtsCacheDir(): string {
  return ensureDir(join(app.getPath('userData'), 'tts_cache'))
}

/** Qwen3 TTS 基础目录：~/.shuvix/tts/qwen3/ */
export function getQwen3TtsDir(): string {
  return ensureDir(join(homedir(), '.shuvix', 'tts', 'qwen3'))
}

/**
 * 会话 Artifacts 根 —— `~/.shuvix/artifacts/<rootSessionId>/`，一场会话一个目录。
 *
 * 放 `~/.shuvix/` 而不是 `<userData>/data/`：凡是「智能体为用户产出的东西」都在这里
 * （widgets / knowledge / bots / skills），用户找得到、拷得走；`data/sessions/*.jsonl`
 * 是应用自己的账本，不是给人看的。
 *
 * 目录名就是会话 id（与知识库的项目 bundle `projects/<projectId>/` 同策：目录名就是 id，
 * 永不冲突、改名不失效）。显示名从不来自目录 —— 由宿主用会话当前标题解析。
 * 不自动创建：首次写入时才建，看一眼就结束的图在磁盘上什么都不留。
 */
export function getSessionArtifactsDir(rootSessionId: string): string {
  return join(homedir(), '.shuvix', 'artifacts', rootSessionId)
}

/** 全局 Skills 目录：~/.shuvix/skills/（不自动创建，由 skillService 管理） */
export function getDefaultSkillsDir(): string {
  return join(homedir(), '.shuvix', 'skills')
}

/** 内置 Skills 资源根 —— 打包后 Resources/skills/，开发时 resources/skills/；下面按语言分层 */
function getBuiltinSkillsRoot(): string {
  // `app?.` 与 getBuiltinKnowledgeDir 同策：单测常只桩半个 electron，少这一个问号就 TypeError
  return app?.isPackaged
    ? join(process.resourcesPath, 'skills')
    : resolve(__dirname, '../../resources/skills')
}

/** 语言回退的兜底（与内置知识库同一个常量语义：整份回退到 en，不做半中半英） */
const BUILTIN_SKILL_FALLBACK_LANGUAGE = 'en'

/**
 * 内置 Skills 目录 —— 随应用版本包发布，只读，**按界面语言分层**
 * （`skills/<lang>/<name>/SKILL.md`，与内置知识库的 `knowledge/<base>/<lang>/` 同策）。
 *
 * 为什么按语言分目录而不是一份英文：内置技能的正文是**提示散文**，与 builtinAgents 的
 * md 属同一类东西，而那一类在本仓的规矩就是一语言一份、按整份回退。技能是目录不是单文件，
 * 所以回退发生在这一层：界面语言的目录存在就用它，否则整个落到 en。
 *
 * 随之而来的约定（有守护测试）：**每个语言目录都要有每一个内置技能**，尚未翻译的那份
 * 先放英文原文 —— 与「未翻译的语言文件里正文先放英文原文」同一条规矩，翻译债因此出现在
 * 正确的位置，而不是变成「某个语言的用户静默少一个技能」。
 *
 * skillService 每次 findAll 都现扫，所以切换界面语言无需额外刷新。
 */
export function getBuiltinSkillsDir(): string {
  const root = getBuiltinSkillsRoot()
  const lang = (i18next.language || BUILTIN_SKILL_FALLBACK_LANGUAGE).split('-')[0].toLowerCase()
  return existsSync(join(root, lang))
    ? join(root, lang)
    : join(root, BUILTIN_SKILL_FALLBACK_LANGUAGE)
}

/**
 * 内置知识库资源目录 —— 随应用版本包发布，只读（`knowledge` 工具里的保留名 `shuvix`）。
 * 打包后位于 Resources/knowledge/，开发时位于 resources/knowledge/；里面一库一目录、目录下按语言分层
 * （`shuvix/en/…` / `shuvix/zh/…` / `shuvix/ja/…`），生效的只有界面语言那一版（services/knowledge）。
 */
export function getBuiltinKnowledgeDir(): string {
  // `locateBundle` 走到这里 —— 文件工具的每次写入都会经过它，而它们的单测只桩了半个 electron
  // （没有 app）：没有 app 就按未打包算，落到开发期的资源目录
  return app?.isPackaged
    ? join(process.resourcesPath, 'knowledge')
    : resolve(__dirname, '../../resources/knowledge')
}

/**
 * 内置 agent 档案目录 —— **内置档案的唯一事实源**。随包发布（`Resources/builtin-agents/`，
 * 见 electron-builder.yml 的 extraResources），开发期指向仓库里
 * `packages/agent-runtime/src/subagent/builtinAgents/md`。
 *
 * 运行时按当前语言现读这里的文件（agentService → buildBuiltinProfiles 的 readMd），侧栏点开
 * 一份内置档案时打开的也是同一份文件的只读笔记本 —— 不再有「跑的是内联字符串、看的是另一份」。
 * 与 getBuiltinKnowledgeDir 同策：没有 app（半桩的单测）按未打包算。
 */
export function getBuiltinAgentsDir(): string {
  return app?.isPackaged
    ? join(process.resourcesPath, 'builtin-agents')
    : // out/main → out → apps/desktop → apps → 仓库根
      resolve(__dirname, '../../../../packages/agent-runtime/src/subagent/builtinAgents/md')
}

/**
 * 内置安全策略目录 —— **内置策略的唯一事实源**。随包发布（`Resources/builtin-policies/`，
 * 见 electron-builder.yml 的 extraResources），开发期指向仓库里
 * `packages/agent-runtime/src/security/builtinPolicies/md`。
 *
 * 运行时按当前语言现读这里的文件（policyService / 桌面 SecurityHostProvider 的
 * readBuiltinPolicyMd → buildBuiltinPolicies），侧栏点开一份内置策略时打开的
 * 也是同一份文件的只读笔记本。与 getBuiltinAgentsDir 同策：没有 app（半桩的单测）按未打包算。
 */
export function getBuiltinPoliciesDir(): string {
  return app?.isPackaged
    ? join(process.resourcesPath, 'builtin-policies')
    : resolve(__dirname, '../../../../packages/agent-runtime/src/security/builtinPolicies/md')
}

/** 全局 Agents 目录：~/.shuvix/agents/（用户自己的档案；不自动创建，由 agentService 管理） */
export function getDefaultAgentsDir(): string {
  return join(homedir(), '.shuvix', 'agents')
}

/** 全局安全策略目录：~/.shuvix/policies/（不自动创建，由 policyService 管理；内置策略硬编码进 @shuvix/agent-runtime） */
export function getDefaultPoliciesDir(): string {
  return join(homedir(), '.shuvix', 'policies')
}

/** 全局 hook 目录：~/.shuvix/hooks/（不自动创建，由 hookService 管理；内置 hook 硬编码进 @shuvix/agent-runtime） */
export function getDefaultHooksDir(): string {
  return join(homedir(), '.shuvix', 'hooks')
}

/** 全局 Bots 目录：~/.shuvix/bots/（不自动创建，由 botService 管理；不内置任何 bot） */
export function getDefaultBotsDir(): string {
  return join(homedir(), '.shuvix', 'bots')
}

/**
 * 知识库 v2 的两个根（都不自动创建 —— 首次写入或首次打开入口才由 services/knowledge 懒建；
 * 与用户自己的知识库根并存、互不相干）。
 *
 * ShuviX 维护的那个根（容器）：一个绑定实体一个 bundle，全套簿记归宿主。
 */
export function getShuvixKnowledgeRootDir(): string {
  return join(homedir(), '.shuvix', 'knowledge-shuvix')
}

/**
 * 用户自己的知识库根（容器）：每个非隐藏子目录都是一个用户知识库，不要求任何标记；
 * 簿记（index/log 投影、git 提交）与 ShuviX 维护的库一视同仁
 */
export function getUserKnowledgeRootDir(): string {
  return join(homedir(), '.shuvix', 'knowledge')
}

/**
 * 项目记忆根目录：~/.shuvix/memory/（不自动创建，由 services/memory 懒建）。
 *
 * 放 ~/.shuvix/ 而非 <userData>/data/：这里是**用户拥有并可直接编辑的资产** ——
 * 自己写的配置（skills / agents / policies）与 agent 产出但归用户处置的
 * widgets / memory 都在这层；<userData>/data/ 留给应用的结构化运行时数据
 * （shuvix.db 与会话转写）。记忆要被用户看见、改写、删除，属于前者。
 *
 * 按 projectId（uuidv7）分目录而非按项目路径：仓库移动 / 改名 / 重新 clone 后
 * projects.path 会变而 id 不变，记忆不会因此失联。
 */
export function getMemoryRootDir(): string {
  return join(homedir(), '.shuvix', 'memory')
}

/** 单个项目的记忆目录：~/.shuvix/memory/<projectId>/ */
export function getProjectMemoryDir(projectId: string): string {
  return join(getMemoryRootDir(), projectId)
}

/** Widgets 根目录：~/.shuvix/widgets/（懒创建） */
export function getWidgetsDir(): string {
  return ensureDir(join(homedir(), '.shuvix', 'widgets'))
}

/** 获取临时会话的工作目录 */
export function getTempWorkspace(sessionId: string): string {
  return ensureDir(join(app.getPath('userData'), 'temp_workspace', sessionId))
}

/** 工具大结果持久化根目录（不自动创建） */
export function getToolResultsBase(): string {
  return join(app.getPath('userData'), 'tool_results')
}

/** 工具大结果持久化目录：~/Library/Application Support/shuvix/tool_results/{sessionId}/ */
export function getToolResultsDir(sessionId: string): string {
  return ensureDir(join(getToolResultsBase(), sessionId))
}

/**
 * 合并 PATH — 打包后的 Electron GUI 应用不继承 shell PATH，
 * 需要手动追加常见路径以便找到 npx / docker 等命令。
 */
const EXTRA_PATHS = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin']
export const mergedPATH = [
  ...new Set([...(process.env.PATH?.split(':') ?? []), ...EXTRA_PATHS])
].join(':')

/**
 * shuvix CLI 入口绝对路径：
 *   - SHUVIX_ELECTRON  当前 Electron 二进制（CLI 用 ELECTRON_RUN_AS_NODE 复用之）
 *   - SHUVIX_CLI_JS    打包后的 cli 入口（out/main/cli.js / Resources/app.asar 内）
 *   - SHUVIX_CLI       wrapper 脚本绝对路径（同时 wrapper 所在目录会被 prepend 到 PATH，
 *                      AI 直接 `shuvix widget …` 即可，不必引用此 env）
 */
export function getShuvixCliEnv(): {
  SHUVIX_ELECTRON: string
  SHUVIX_CLI_JS: string
  SHUVIX_CLI: string
} {
  const electron = process.execPath
  const isWin = process.platform === 'win32'
  const wrapperName = isWin ? 'shuvix.cmd' : 'shuvix'
  const cliJs = app.isPackaged
    ? join(app.getAppPath(), 'out', 'main', 'cli.js')
    : resolve(__dirname, '../../out/main/cli.js')
  const wrapper = app.isPackaged
    ? join(process.resourcesPath, 'cli', wrapperName)
    : resolve(__dirname, '../../resources/cli', wrapperName)
  return {
    SHUVIX_ELECTRON: electron,
    SHUVIX_CLI_JS: cliJs,
    SHUVIX_CLI: wrapper
  }
}

/**
 * 构建 spawn 用环境变量：
 *   - PATH 合并系统 PATH + EXTRA_PATHS + shuvix CLI wrapper 所在目录（prepended）
 *     这样 AI 可直接 `shuvix widget …`，不需要引用 $SHUVIX_CLI
 *   - 额外注入 SHUVIX_ELECTRON / SHUVIX_CLI_JS / SHUVIX_CLI（debugging / fallback）
 */
export function buildSpawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const cliEnv = getShuvixCliEnv()
  const cliDir = dirname(cliEnv.SHUVIX_CLI)
  // 仅 POSIX 走 mergedPATH（用 ":" 解析）；Windows 直接用原始 PATH
  const basePath = process.platform === 'win32' ? (process.env.PATH ?? '') : mergedPATH
  const PATH = [cliDir, basePath].filter(Boolean).join(delimiter)
  return { ...process.env, ...cliEnv, ...extra, PATH }
}
