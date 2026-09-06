/**
 * `systemNoticeContract` —— 按正文形状认系统通知的那把尺。
 *
 * 它是侧车之外的兜底判据（steer / nextTurn 路径插不进侧车），所以边界要钉死在
 * 「整段正文只由通知块组成」：多一句人写的话就不算 —— 宁可漏认一条通知（画成气泡），
 * 也不能把用户真正说的话认成系统通知。
 */
import { describe, it, expect } from 'vitest'
import { isSystemNoticeText, systemNoticeBlockRe, SYSTEM_NOTICE_TAGS } from './systemNoticeContract'

const bgTask = [
  '<background-task pid="17162" status="killed by SIGTERM" duration="23s">',
  'for i in $(seq 1 30); do echo "tick $i"; sleep 2; done',
  'Last output:',
  'tick 12 17:36:12',
  'Full log: /tmp/x.log',
  '</background-task>'
].join('\n')

const subSession = [
  '<sub-session id="c9f1" title="重构登录页" status="settled">',
  'The turn you started in the background has finished.',
  '</sub-session>'
].join('\n')

describe('isSystemNoticeText', () => {
  it('T-1 一个完整的后台任务通知块 → true（正文里的引号 / $() / 尖括号以外的字符不影响）', () => {
    expect(isSystemNoticeText(bgTask)).toBe(true)
  })

  it('T-2 两个通知块用空行拼接（合并窗口内一起完成）→ true；前后空白也允许', () => {
    expect(isSystemNoticeText(`${bgTask}\n\n${subSession}`)).toBe(true)
    expect(isSystemNoticeText(`\n  ${subSession}\n`)).toBe(true)
  })

  it('T-3 通知块之外多了人写的话 → false（宁可漏认，不把用户的话认成系统通知）', () => {
    expect(isSystemNoticeText(`看看这个：\n${bgTask}`)).toBe(false)
    expect(isSystemNoticeText(`${bgTask}\n然后呢`)).toBe(false)
  })

  it('T-4 普通文本 / 空串 / 纯空白 / 别的标签 → false', () => {
    expect(isSystemNoticeText('帮我重构登录页')).toBe(false)
    expect(isSystemNoticeText('')).toBe(false)
    expect(isSystemNoticeText('   \n ')).toBe(false)
    expect(isSystemNoticeText('<note>hi</note>')).toBe(false)
  })

  it('T-5 半截标签（有开无合）→ false', () => {
    expect(isSystemNoticeText('<background-task pid="1" status="x" duration="1s">\nls')).toBe(false)
  })
})

describe('systemNoticeBlockRe', () => {
  it('R-1 每次调用给一个新实例：上一次 exec 留下的 lastIndex 不会串到下一次', () => {
    const a = systemNoticeBlockRe()
    expect(a.exec(bgTask)).not.toBeNull()
    expect(a.lastIndex).toBeGreaterThan(0)
    const b = systemNoticeBlockRe()
    expect(b).not.toBe(a)
    expect(b.lastIndex).toBe(0)
    expect(b.flags).toContain('g')
  })

  it('R-2 捕获组：1 = 标签名，2 = 属性串，3 = 正文；标签表里的每个名字都能匹配', () => {
    const m = systemNoticeBlockRe().exec(subSession)!
    expect(m[1]).toBe('sub-session')
    expect(m[2]).toContain('title="重构登录页"')
    expect(m[3]).toContain('has finished')
    for (const tag of SYSTEM_NOTICE_TAGS) {
      expect(systemNoticeBlockRe().test(`<${tag} a="1">\nbody\n</${tag}>`)).toBe(true)
    }
  })
})
