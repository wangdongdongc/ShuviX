/**
 * projection —— 保留文件（index.md / log.md）的确定性投影。
 *
 * 设计 §14：同一份概念清单永远渲染出同一批字节 —— 宿主逐份比对内容只写有变化的文件，
 * git 历史因此不被无意义重写刷满。这里钉：输入顺序无关、根 index 的分节与渐进披露第一跳、
 * 子目录 index 的 Entries/Sections 形状、目录名取绑定概念的 title，以及日志的日期分组。
 */
import { describe, it, expect } from 'vitest'
import {
  appendLogEntry,
  comparePaths,
  formatLogText,
  renderAllIndexes,
  type ProjectionConcept
} from '../projection'
import { buildLogMd, parseLogMd } from '../okfCodec'

const concept = (
  path: string,
  title: string,
  description = '',
  status: ProjectionConcept['status'] = 'stable'
): ProjectionConcept => ({ path, title, description, status })

const render = (concepts: ProjectionConcept[], extraDirs?: string[]): Map<string, string> =>
  renderAllIndexes({ concepts, extraDirs, okfVersion: '0.2' })

describe('renderAllIndexes — 确定性', () => {
  const SET: ProjectionConcept[] = [
    concept('global/Z.md', 'Z', 'dz'),
    concept('global/a.md', 'A', 'da'),
    concept('projects/acme/project.md', 'Acme Corp', 'binds'),
    concept('projects/acme/x.md', 'X', 'dx'),
    concept('projects/acme/sessions/s.md', 'S', 'ds'),
    concept('wiki/auth/café.md', 'Café', 'dc')
  ]

  it('PJ-1 任意输入顺序 → 逐键逐值相同的 Map；输出不含时间戳；路径按 NFC 码点序', () => {
    const base = [...render(SET).entries()]
    const shuffled1 = [SET[5], SET[3], SET[0], SET[4], SET[2], SET[1]]
    const shuffled2 = [SET[2], SET[5], SET[1], SET[3], SET[0], SET[4]]
    expect([...render(shuffled1).entries()]).toEqual(base)
    expect([...render(shuffled2).entries()]).toEqual(base)
    for (const [, text] of base) {
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}/)
    }
    // 码点序：大写在小写前；分解式与合成式的 é 视为同一路径
    expect(comparePaths('Z.md', 'a.md')).toBeLessThan(0)
    expect(comparePaths('café.md', 'café.md')).toBe(0)
    const globalIndex = render(SET).get('global')!
    expect(globalIndex.indexOf('[Z](Z.md)')).toBeLessThan(globalIndex.indexOf('[A](a.md)'))
  })

  /**
   * 一个 bundle 的根 index 与子目录 index 同构（Entries 再 Sections），只多一份 `okf_version`
   * frontmatter —— 它是「这是一个 OKF bundle」的声明。跨 bundle 的事投影一概不知道，
   * 那正是 bundle 边界的意思。
   */
  it('PJ-2 bundle 根 index：okf_version frontmatter + Entries 再 Sections，与子目录同构', () => {
    const root = render([
      concept('project.md', 'Acme Corp', 'binds'),
      concept('token-refresh.md', 'Token refresh', 'dt'),
      concept('auth/session.md', 'Session', 'ds')
    ]).get('')!
    expect(root).toBe(
      [
        '---',
        'okf_version: "0.2"',
        '---',
        '',
        '## Entries',
        '',
        '* [Acme Corp](project.md) - binds',
        '* [Token refresh](token-refresh.md) - dt',
        '',
        '## Sections',
        '',
        '* [auth](auth/index.md)',
        ''
      ].join('\n')
    )
    // 作用域分节随目录作用域一起退役：一个 bundle 只有它自己的条目与子目录
    for (const absent of ['## Global memory', '## Projects', '## Bundle']) {
      expect(root).not.toContain(absent)
    }
  })

  it('PJ-3 子目录 index：Entries（目录相对路径）再 Sections；绑定概念的 title 命名目录；非根 index 不带 frontmatter', () => {
    const map = render([
      concept('projects/acme/project.md', 'Acme Corp', 'binds'),
      concept('projects/acme/x.md', 'X', 'dx'),
      concept('projects/acme/sessions/s.md', 'S', 'ds')
    ])
    expect(map.get('projects/acme')).toBe(
      '## Entries\n\n* [Acme Corp](project.md) - binds\n* [X](x.md) - dx\n\n## Sections\n\n* [sessions](sessions/index.md)\n'
    )
    expect(map.get('projects')).toBe('## Sections\n\n* [Acme Corp](acme/index.md)\n')
    expect(map.get('projects/acme/sessions')).toBe('## Entries\n\n* [S](s.md) - ds\n')
    // bundle 根同样是 Entries / Sections —— 只多 frontmatter
    expect(map.get('')).toBe(
      '---\nokf_version: "0.2"\n---\n\n## Sections\n\n* [projects](projects/index.md)\n'
    )
    for (const [dir, text] of map) {
      if (dir !== '') expect(text.startsWith('---'), dir).toBe(false)
    }
    // 没有绑定概念的目录用目录名
    expect(render([concept('auth/alice/b.md', 'B')]).get('auth')).toBe(
      '## Sections\n\n* [alice](alice/index.md)\n'
    )
  })

  it('PJ-4 deprecated 条目标题带 (deprecated)；空 description 不留 ` - ` 尾巴', () => {
    const map = render([concept('global/x.md', 'Title', '', 'deprecated')])
    expect(map.get('global')).toBe('## Entries\n\n* [Title (deprecated)](x.md)\n')
  })

  it('PJ-5 祖先目录与 extraDirs 都得到 index，空目录的 index 是空串', () => {
    const map = render(
      [concept('projects/acme/sessions/s.md', 'S', 'ds')],
      ['global', 'bots/alice']
    )
    expect([...map.keys()]).toEqual([
      '',
      'bots',
      'bots/alice',
      'global',
      'projects',
      'projects/acme',
      'projects/acme/sessions'
    ])
    // buildIndexMd([]) 就是空串：空作用域目录的 index.md 是一份空文件，不是「无文件」
    expect(map.get('global')).toBe('')
    expect(map.get('bots/alice')).toBe('')
    expect(map.get('bots')).toBe('## Sections\n\n* [alice](alice/index.md)\n')
  })
})

describe('formatLogText / appendLogEntry', () => {
  it('PJ-6 日志正文：`**Op** /path — title · by actor`，缺 title / actor 就没有那一截', () => {
    expect(
      formatLogText({
        date: '2026-09-09',
        op: 'Creation',
        path: 'global/x.md',
        title: 'X',
        actor: 'shuvix-work/gpt-5'
      })
    ).toBe('**Creation** /global/x.md — X · by shuvix-work/gpt-5')
    expect(formatLogText({ date: '2026-09-09', op: 'Update', path: '/a.md' })).toBe(
      '**Update** /a.md'
    )
  })

  it('PJ-6 追加：新日期组在前、同日新事件在前、回填日期落到自己的组；手写杂行被丢弃（日志是投影）', () => {
    const existing = `${buildLogMd([{ date: '2026-09-08', text: 'old' }])}junk line\n`
    const step1 = appendLogEntry(existing, {
      date: '2026-09-09',
      op: 'Creation',
      path: 'global/x.md',
      title: 'X'
    })
    expect(step1).toBe(
      '## 2026-09-09\n\n- **Creation** /global/x.md — X\n\n## 2026-09-08\n\n- old\n'
    )
    const step2 = appendLogEntry(step1, { date: '2026-09-09', op: 'Update', path: 'global/x.md' })
    expect(step2).toBe(
      '## 2026-09-09\n\n- **Update** /global/x.md\n- **Creation** /global/x.md — X\n\n## 2026-09-08\n\n- old\n'
    )
    const step3 = appendLogEntry(step2, { date: '2026-09-07', op: 'Deletion', path: 'global/y.md' })
    expect(step3.endsWith('\n## 2026-09-07\n\n- **Deletion** /global/y.md\n')).toBe(true)
    expect(step3).not.toContain('junk line')
    expect(parseLogMd(step3)).toEqual([
      { date: '2026-09-09', text: '**Update** /global/x.md' },
      { date: '2026-09-09', text: '**Creation** /global/x.md — X' },
      { date: '2026-09-08', text: 'old' },
      { date: '2026-09-07', text: '**Deletion** /global/y.md' }
    ])
    // 不存在的日志：从一条开始
    expect(appendLogEntry(null, { date: '2026-09-09', op: 'Creation', path: 'a.md' })).toBe(
      '## 2026-09-09\n\n- **Creation** /a.md\n'
    )
  })
})
