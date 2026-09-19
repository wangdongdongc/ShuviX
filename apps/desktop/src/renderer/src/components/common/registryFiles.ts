/**
 * 注册表 md 列表（侧栏的智能体分组 / 设置页的安全策略与 Hooks tab）共用的小工具。
 * 放在 common 而不是某一边：智能体那份 UI 搬到侧栏之后，它不再是「设置页专用」。
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
