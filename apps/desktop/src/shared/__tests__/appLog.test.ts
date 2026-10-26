/**
 * 应用日志的行解析（parseAppLog / formatAppLogEntry）—— 行格式照 electron-log 按 `main/logger.ts` 的模板写出来的样子：
 * `{level}]` 补齐到 6 个字符，`{scope}` 是 ` (tag)` 补齐到最长的 tag。
 *
 *   AL-1 不带标签的行：时间、级别、正文；级别补出来的空格不进正文
 *   AL-2 带标签的行：info（补了一格）与 error（没补）都认出标签，标签后的补齐空格不进正文
 *   AL-3 没有行头的行归到上一条的 more（堆栈）；第一条行头之前的行进 orphan
 *   AL-4 CRLF（Windows 的 EOL）：行尾的 \r 去掉；末尾换行不产生空行，正文里的空行保留在 more
 *   AL-5 formatAppLogEntry：行头 + 后续行；带标签 / 不带标签都与解析互逆（文本层面）
 *   AL-6 不是行头的方括号行（时间格式不对、级别有大写）当续行
 */
import { describe, expect, it } from 'vitest'
import { formatAppLogEntry, parseAppLog } from '../appLog'

describe('parseAppLog', () => {
  it('AL-1 不带标签的行', () => {
    const { entries, orphan } = parseAppLog(
      '[2026-10-25 07:38:27.876] [warn]  扫描 skills 目录失败: /tmp/x\n'
    )
    expect(orphan).toEqual([])
    expect(entries).toEqual([
      {
        time: '2026-10-25 07:38:27.876',
        level: 'warn',
        scope: '',
        text: '扫描 skills 目录失败: /tmp/x',
        more: []
      }
    ])
  })

  it('AL-2 带标签的行（info 补一格、error 不补）', () => {
    const { entries } = parseAppLog(
      [
        '[2026-10-25 02:04:05.963] [info]  (Perf)          main: app modules start — +859ms',
        '[2026-10-25 02:04:06.001] [error] (MCP)           [ab12cd34:ipc] server "x" exited 1'
      ].join('\n')
    )
    expect(entries.map((e) => [e.level, e.scope, e.text])).toEqual([
      ['info', 'Perf', 'main: app modules start — +859ms'],
      ['error', 'MCP', '[ab12cd34:ipc] server "x" exited 1']
    ])
  })

  it('AL-3 续行归上一条；第一条之前的进 orphan', () => {
    const { entries, orphan } = parseAppLog(
      [
        '    at tail of a previous stack',
        '[2026-10-25 07:38:27.876] [error] (App)  boom Error: EACCES',
        '    at readdirSync (node:fs:1590:26)',
        '    at SkillService.scan (skillService.ts:300:17)',
        '[2026-10-25 07:38:28.000] [info]  next'
      ].join('\n')
    )
    expect(orphan).toEqual(['    at tail of a previous stack'])
    expect(entries).toHaveLength(2)
    expect(entries[0].more).toEqual([
      '    at readdirSync (node:fs:1590:26)',
      '    at SkillService.scan (skillService.ts:300:17)'
    ])
    expect(entries[1]).toMatchObject({ level: 'info', scope: '', text: 'next', more: [] })
  })

  it('AL-4 CRLF 去掉 \\r；末尾换行不产生空行；正文里的空行保留', () => {
    const { entries } = parseAppLog(
      '[2026-10-25 07:38:27.876] [info]  a\r\n\r\n  b\r\n[2026-10-25 07:38:28.000] [debug] c\r\n'
    )
    expect(entries.map((e) => [e.level, e.text, e.more])).toEqual([
      ['info', 'a', ['', '  b']],
      ['debug', 'c', []]
    ])
  })

  it('AL-5 formatAppLogEntry 写回行头 + 后续行', () => {
    const text = [
      '[2026-10-25 07:38:27.876] [error] (App) boom',
      '    at x (y.ts:1:1)',
      '[2026-10-25 07:38:28.000] [info] plain'
    ].join('\n')
    const { entries } = parseAppLog(text)
    expect(entries.map(formatAppLogEntry).join('\n')).toBe(text)
  })

  it('AL-6 时间或级别不合格式的方括号行是续行', () => {
    const { entries } = parseAppLog(
      [
        '[2026-10-25 07:38:27.876] [info]  head',
        '[2026-10-25 07:38] [info] short time',
        '[2026-10-25 07:38:27.876] [INFO] upper'
      ].join('\n')
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].more).toHaveLength(2)
  })
})
