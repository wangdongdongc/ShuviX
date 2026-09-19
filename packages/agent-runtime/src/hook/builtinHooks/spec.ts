/**
 * 内置 hook 的声明式 spec + 构建器 —— 与 builtinAgents / builtinPolicies 同一模式：
 * md 是唯一事实源（随包发布到磁盘，运行时经宿主注入的 `readMd` 现读），spec 只留结构。
 *
 * 语言回退复用 builtinMdFileNames 的候选序（精确 → 基础语言 → en，按文件整体回退）。
 * 一份 hook 只有十几行：本地化文件只动 `shuvix-displayName` / `description`，正文（任务文本）
 * 与 frontmatter 结构和 en 保持一致 —— 用眼睛就能对，不再需要字节一致的守护测试。
 */
import { builtinMdFileNames, type BuiltinMdReader } from '../../subagent/builtinAgents/spec'
import { parseHookDefinitionFile, type ParsedHookFile } from '../hookFile'

/** 一个内置 hook 的声明 —— 纯名字（文案在 md/ 目录，一语言一文件，运行时经 readMd 现读） */
export interface BuiltinHookSpec {
  /** name 必须与各语言 md frontmatter 的 name 一致 */
  name: string
}

export interface BuiltinHookDeps {
  /** 当前界面语言；缺省 en */
  language?: string
  /** 内置 hook md 的读取口（宿主注入；入参是目录内文件名，没有那一版返回 null） */
  readMd: BuiltinMdReader
}

/**
 * 按 spec 现算一个内置 hook。md 解析失败返回 null —— 内置 md 随包发布、用户改不到，
 * 出现即为开发期错误（诊断经 console.warn，与 buildBuiltinProfile 同策）。
 * 一份候选文件都读不到同样返回 null（宿主目录缺失由调用方决定要不要响）。
 */
export function buildBuiltinHook(
  spec: BuiltinHookSpec,
  deps: BuiltinHookDeps
): ParsedHookFile | null {
  for (const fileName of builtinMdFileNames(spec.name, deps.language)) {
    const source = deps.readMd(fileName)
    if (source === null) continue
    return parseHookDefinitionFile(source, spec.name, (msg) =>
      console.warn(`[builtinHooks] ${fileName}: ${msg}`)
    )
  }
  console.warn(`[builtinHooks] no md found for "${spec.name}"`)
  return null
}
