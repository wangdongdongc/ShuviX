/**
 * 侧栏「安全策略」分组「新建策略」的初值 —— 一份最小但**合法**的策略 md
 * （YAML 注释原样保留：文件才是事实源，逐字段表单会把它们悄悄抹掉）。
 *
 * 落盘走 `policy.create`（与「创建覆盖副本」同一个写入口，非法一律拒绝），
 * 建好之后打开的就是它自己的笔记本会话 —— 用户接着在那里改。
 */
export function newPolicyTemplate(t: (key: string) => string, name: string): string {
  return [
    '---',
    'shuvix: policy v1',
    `name: ${name}`,
    `description: ${t('settings.policyTemplateDesc')}`,
    `# ${t('settings.policyTemplateHint')}`,
    'shuvix-policy-rules:',
    '  - effect: ask',
    '    subject.kind: [agent]',
    '    object.type: [command]',
    '---',
    '',
    t('settings.policyTemplateBody'),
    ''
  ].join('\n')
}
