/**
 * 知识库种子 —— 宿主首次初始化根目录时写出的文件（设计 §5 root.ts）。
 * SCHEMA.md 是本库的编辑规范（Karpathy 模式里的 schema 文件），以 md 维护、`?raw` 内联；
 * 用户改它就是改规则 —— 宿主只在文件不存在时写出，从不覆盖。
 */
import schemaSeed from './seed/SCHEMA.md?raw'

export const KNOWLEDGE_SCHEMA_SEED: string = schemaSeed
