/**
 * md 扩展元数据（内聚模块）—— 挂在 agent / bot / hook / policy 文件 frontmatter 的 `shuvix-id` 上的
 * 补缺值，存在表 md_attrs 里。本模块只管数据（内存快照 + 读写）；「哪条笔记是哪份文件」「值合不合法」
 * 归上层的 mdMetaService，注册表经主进程入口注入的读口取补缺值（agentService.setMetaFill）。
 */
export { mdMetaStore } from './store'
