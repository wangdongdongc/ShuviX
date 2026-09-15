/**
 * 设置页三个注册表 tab（智能体 / 安全策略 / Hooks）共用的小工具 —— 与组件分文件放，
 * 让 RegistryNoteView 只导出组件（fast refresh 的要求）。
 */

/** 列表项 basePath → 注册表目录下的文件名（渲染进程没有 node:path） */
export function fileNameOf(basePath: string): string {
  return basePath.split(/[\\/]/).pop() ?? basePath
}

/** `base`、`base-2`、`base-3`……里第一个没被占用的名字（新建模板用：撞名的新建会被拒绝） */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken)
  let name = base
  for (let i = 2; names.has(name); i++) name = `${base}-${i}`
  return name
}
