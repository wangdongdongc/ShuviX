/**
 * 每个 bot 一个知识库（2026-11-14）—— chat-protocol 这一侧的纯函数与常量。
 *
 *   KP-1  botKnowledgeKey：UUID 身份 → 小写 UUID（trim）
 *   KP-2  botKnowledgeKey：内置形态 `bot:builtin:<name>` → `builtin-<name>`；名字里进不了目录名的字符换成 `-`
 *   KP-3  botKnowledgeKey：没有 key 的身份（空、别的 kind 的内置 id、只剩点的名字）
 *   KP-N  botKnowledgeKey：别的身份（文件没写 `shuvix-id`，身份就是名字）→ `name-<名字>`；改名换 key
 *   KP-S  每个 key 都是一个安全的目录段；三种形态互不相撞
 *   KP-4  baseNameFromEntryPath：`bots/<key>/…` → 工具里的保留名 `bot`
 *   KP-5  常量：容器名 / 保留名与别的名字空间不撞
 */
import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_BOT_BASE,
  KNOWLEDGE_BOTS_DIR,
  KNOWLEDGE_BUILTIN_BASE,
  KNOWLEDGE_BUILTIN_DIR,
  KNOWLEDGE_PROJECT_BASE,
  KNOWLEDGE_PROJECTS_DIR,
  KNOWLEDGE_SHUVIX_ROOT_DIR,
  KNOWLEDGE_USER_ROOT_DIR,
  baseNameFromEntryPath,
  botKnowledgeKey
} from './knowledge'

const U1 = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'

describe('botKnowledgeKey', () => {
  it('KP-1 UUID 身份 → 小写 UUID；前后空白去掉', () => {
    expect(botKnowledgeKey(U1)).toBe(U1)
    expect(botKnowledgeKey(U1.toUpperCase())).toBe(U1)
    expect(botKnowledgeKey(`  ${U1.toUpperCase()}  `)).toBe(U1)
  })

  it('KP-2 内置形态 → builtin-<name>：允许的字符与大小写原样，目录名里的禁字符换成 -，CJK 保留', () => {
    expect(botKnowledgeKey('bot:builtin:daily')).toBe('builtin-daily')
    expect(botKnowledgeKey('bot:builtin:a.b_c-D9')).toBe('builtin-a.b_c-D9')
    // 空格不在禁字符里：保留
    expect(botKnowledgeKey('bot:builtin:my bot/x')).toBe('builtin-my bot-x')
    expect(botKnowledgeKey('bot:builtin:日记')).toBe('builtin-日记')
    // `/` 换成 `-` 之后再去首尾的点：`../../etc` → `..-..-etc` → `-..-etc`
    expect(botKnowledgeKey('bot:builtin:../../etc')).toBe('builtin--..-etc')
    expect(botKnowledgeKey('bot:builtin:a\\b:c*d?e"f<g>h|i')).toBe('builtin-a-b-c-d-e-f-g-h-i')
    expect(botKnowledgeKey('  bot:builtin:daily  ')).toBe('builtin-daily')
  })

  it('KP-3 没有 key：空身份、别的 kind 的内置 id、整个名字只剩点', () => {
    for (const v of [null, undefined, '', '   ', '\t\n']) expect(botKnowledgeKey(v)).toBeNull()
    for (const kind of ['agent', 'policy', 'hook']) {
      expect(botKnowledgeKey(`${kind}:builtin:x`)).toBeNull()
    }
    // 去掉首尾的点就什么都不剩
    expect(botKnowledgeKey('.')).toBeNull()
    expect(botKnowledgeKey('...')).toBeNull()
    expect(botKnowledgeKey('bot:builtin:...')).toBeNull()
  })

  it('KP-N 文件没写 shuvix-id（身份就是名字）→ name-<名字>，规则同内置名', () => {
    expect(botKnowledgeKey('buddy')).toBe('name-buddy')
    expect(botKnowledgeKey('  buddy  ')).toBe('name-buddy')
    expect(botKnowledgeKey('Buddy')).toBe('name-Buddy')
    expect(botKnowledgeKey('日记助手')).toBe('name-日记助手')
    expect(botKnowledgeKey('not-a-uuid-1234')).toBe('name-not-a-uuid-1234')
    expect(botKnowledgeKey('a/b\\c:d')).toBe('name-a-b-c-d')
    expect(botKnowledgeKey('x\u0001y\u001fz')).toBe('name-x-y-z')
    expect(botKnowledgeKey('.hidden.')).toBe('name-hidden')
    // 不是合法内置 id（名字段为空）→ 按名字算
    expect(botKnowledgeKey('bot:builtin:')).toBe('name-bot-builtin-')
    // 改名就换了身份，库也跟着换
    expect(botKnowledgeKey('pal')).not.toBe(botKnowledgeKey('buddy'))
  })

  it('KP-S 每个 key 都是单个安全目录段：没有禁字符、不以点开头或结尾', () => {
    const inputs = [
      U1,
      'bot:builtin:daily',
      'bot:builtin:../../etc',
      'bot:builtin:my bot/x',
      'bot:builtin:x.',
      'buddy',
      '../secret',
      'a/b',
      '.hidden.',
      'C:\\temp',
      'x\u0000y'
    ]
    for (const input of inputs) {
      const key = botKnowledgeKey(input)!
      expect(key, input).toBeTruthy()
      // eslint-disable-next-line no-control-regex
      expect(key, input).not.toMatch(/[/\\:*?"<>|\u0000-\u001f]/)
      expect(key.startsWith('.'), input).toBe(false)
      expect(key.endsWith('.'), input).toBe(false)
    }
  })

  // 契约：首尾的空白与点都去掉，去完点露出来的空白也去掉 —— 以空白结尾的目录名在 Windows 上会被悄悄截掉
  it('KP-S2 去掉首尾的点之后露出来的空白也去掉（`x .` → name-x）', () => {
    expect(botKnowledgeKey('x .')).toBe('name-x')
    expect(botKnowledgeKey('bot:builtin:x .')).toBe('builtin-x')
  })

  it('KP-S 三种形态互不相撞：名字恰好长得像别的形态的 key 也落在 name- 前缀下', () => {
    expect(botKnowledgeKey('builtin-daily')).toBe('name-builtin-daily')
    expect(botKnowledgeKey('name-buddy')).toBe('name-name-buddy')
    expect(botKnowledgeKey(U1)).not.toBe(botKnowledgeKey(`name-${U1}`))
    expect(botKnowledgeKey('daily')).not.toBe(botKnowledgeKey('bot:builtin:daily'))
  })
})

describe('baseNameFromEntryPath —— bot 库', () => {
  it('KP-4 bots/<key>/… → bot；只到库 / 只到容器 → null；名叫 bots 的用户库不是容器', () => {
    expect(baseNameFromEntryPath('bots/k1/x.md')).toEqual({ baseName: 'bot', bundlePath: '/x.md' })
    expect(baseNameFromEntryPath('bots/k1/sub/x.md')).toEqual({
      baseName: 'bot',
      bundlePath: '/sub/x.md'
    })
    expect(baseNameFromEntryPath('bots/k1')).toBeNull()
    expect(baseNameFromEntryPath('bots')).toBeNull()
    expect(baseNameFromEntryPath('knowledge/bots/x.md')).toEqual({
      baseName: 'bots',
      bundlePath: '/x.md'
    })
  })
})

describe('常量', () => {
  it('KP-5 bot 的容器名与保留名不与别的名字空间相撞', () => {
    expect(KNOWLEDGE_BOTS_DIR).toBe('bots')
    expect(KNOWLEDGE_BOT_BASE).toBe('bot')
    const containers = [
      KNOWLEDGE_PROJECTS_DIR,
      KNOWLEDGE_USER_ROOT_DIR,
      KNOWLEDGE_BUILTIN_DIR,
      KNOWLEDGE_SHUVIX_ROOT_DIR
    ]
    expect(containers).not.toContain(KNOWLEDGE_BOTS_DIR)
    expect([KNOWLEDGE_PROJECT_BASE, KNOWLEDGE_BUILTIN_BASE]).not.toContain(KNOWLEDGE_BOT_BASE)
  })
})
