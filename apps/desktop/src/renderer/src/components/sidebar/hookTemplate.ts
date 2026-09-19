/**
 * 侧栏「Hooks」分组「新建 Hook」的初值 —— 一份最小但**合法**的 hook md
 * （YAML 注释与键序原样保留：文件才是事实源，逐字段表单会把它们悄悄抹掉）。
 *
 * 落盘走 `hook.create`（与「创建覆盖副本」同一个写入口，非法一律拒绝），
 * 建好之后打开的就是它自己的笔记本会话 —— 用户接着在那里改。
 */
export function newHookTemplate(t: (key: string) => string, name: string): string {
  return [
    '---',
    'shuvix: hook v1',
    `name: ${name}`,
    `description: ${t('settings.hookTemplateDesc')}`,
    'shuvix-hook-agent: explore',
    'shuvix-hook-on:',
    '  - trigger: session.turn-completed',
    '    when: event.turnCount == 1',
    '---',
    '',
    t('settings.hookTemplateBody'),
    ''
  ].join('\n')
}
