/**
 * CSV 解析器（parseCsv / detectCsvDelimiter）的契约 —— 对话里产物画幅与文件预览窗口的表格视图共用。
 *
 *   CSV-1..17  parseCsv：行尾、引号、BOM、空行、maxRows、显式分隔符、空输入、参差行、空字段、未闭合引号
 *   CSV-18..22 detectCsvDelimiter：第一条记录里（引号外）最多的 `,` / `;` / `\t`，平手与没有 → 逗号
 *   CSV-23     parseCsv 自动定分隔符（含 BOM）
 */
import { describe, expect, it } from 'vitest'
import { detectCsvDelimiter, parseCsv } from './csvTable'

describe('parseCsv', () => {
  it('CSV-1 基本两行', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual({
      rows: [
        ['a', 'b'],
        ['1', '2']
      ],
      totalRows: 2,
      columns: 2,
      truncated: false,
      delimiter: ','
    })
  })

  it('CSV-2 \\r\\n 与单独的 \\r 结果相同；混用也认', () => {
    const lf = parseCsv('a,b\n1,2\n')
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual(lf)
    expect(parseCsv('a,b\r1,2\r')).toEqual(lf)
    const mixed = parseCsv('a\nb\r\nc\rd')
    expect(mixed.rows).toEqual([['a'], ['b'], ['c'], ['d']])
    expect(mixed.totalRows).toBe(4)
  })

  it('CSV-3 引号里的分隔符', () => {
    expect(parseCsv('"x,y",z').rows).toEqual([['x,y', 'z']])
  })

  it('CSV-4 引号里的换行原样保留', () => {
    const t = parseCsv('"line1\nline2",b\n"c\r\nd",e')
    expect(t.rows).toEqual([
      ['line1\nline2', 'b'],
      ['c\r\nd', 'e']
    ])
    expect(t.totalRows).toBe(2)
  })

  it('CSV-5 "" 是一个引号', () => {
    expect(parseCsv('"say ""hi""",2').rows).toEqual([['say "hi"', '2']])
  })

  it('CSV-6 开头的 BOM 去掉', () => {
    const t = parseCsv('﻿a,b\n1,2')
    expect(t.rows).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
    expect(t.rows[0][0]).toBe('a')
  })

  it('CSV-7 空行不算记录', () => {
    const t = parseCsv('a\n\n\nb\n\n')
    expect(t.rows).toEqual([['a'], ['b']])
    expect(t.totalRows).toBe(2)
  })

  it('CSV-8 maxRows 只限制留下的行，totalRows 照算整份', () => {
    const five = 'a\nb\nc\nd\ne'
    const capped = parseCsv(five, { maxRows: 2 })
    expect(capped.rows).toEqual([['a'], ['b']])
    expect(capped.totalRows).toBe(5)
    expect(capped.truncated).toBe(true)
    const all = parseCsv(five, { maxRows: 5 })
    expect(all.rows).toHaveLength(5)
    expect(all.truncated).toBe(false)
  })

  it('CSV-9 maxRows 0：不留行、columns 0、totalRows 是整份', () => {
    const t = parseCsv('a,b\n1,2\n3,4', { maxRows: 0 })
    expect(t.rows).toEqual([])
    expect(t.columns).toBe(0)
    expect(t.totalRows).toBe(3)
    expect(t.truncated).toBe(true)
  })

  it('CSV-10 显式分隔符', () => {
    const t = parseCsv('a|b;c', { delimiter: '|' })
    expect(t.rows).toEqual([['a', 'b;c']])
    expect(t.delimiter).toBe('|')
  })

  it('CSV-11 空串与只有 BOM', () => {
    const empty = { rows: [], totalRows: 0, columns: 0, truncated: false, delimiter: ',' }
    expect(parseCsv('')).toEqual(empty)
    expect(parseCsv('﻿')).toEqual(empty)
  })

  it('CSV-12 参差行：columns 取最宽，各行保留自己的长度', () => {
    const t = parseCsv('a\n1,2,3\n4,5')
    expect(t.columns).toBe(3)
    expect(t.rows).toEqual([['a'], ['1', '2', '3'], ['4', '5']])
  })

  it('CSV-13 columns 只看留下的行', () => {
    expect(parseCsv('a\n1,2,3,4', { maxRows: 1 }).columns).toBe(1)
  })

  it('CSV-14 空字段的记录不是空行', () => {
    expect(parseCsv(',\n').rows).toEqual([['', '']])
    expect(parseCsv('""\n').rows).toEqual([['']])
    expect(parseCsv('   \n').rows).toEqual([['   ']])
  })

  it('CSV-15 未闭合的引号：吞到结尾，不抛', () => {
    expect(() => parseCsv('a,"b\nc')).not.toThrow()
    const t = parseCsv('a,"b\nc')
    expect(t.rows).toEqual([['a', 'b\nc']])
    expect(t.totalRows).toBe(1)
  })

  it('CSV-16 字段中间的引号（钉住现状）', () => {
    expect(parseCsv('a"b"c,d').rows).toEqual([['abc', 'd']])
  })

  it('CSV-17 行尾的分隔符留一个空字段', () => {
    const t = parseCsv('a,b,\n')
    expect(t.rows).toEqual([['a', 'b', '']])
    expect(t.columns).toBe(3)
  })

  it('CSV-23 自动定分隔符：分号文件（含 BOM）', () => {
    expect(parseCsv('﻿a;b\n1;2').delimiter).toBe(';')
    expect(parseCsv('Name;Preis\nA;1,50').rows).toEqual([
      ['Name', 'Preis'],
      ['A', '1,50']
    ])
  })
})

describe('detectCsvDelimiter', () => {
  it('CSV-18 第一条记录里最多的那个', () => {
    expect(detectCsvDelimiter('a;b;c\n1,2')).toBe(';')
    expect(detectCsvDelimiter('a\tb\tc\n1\t2')).toBe('\t')
    expect(detectCsvDelimiter('a,b')).toBe(',')
  })

  it('CSV-19 一个都没有 → 逗号', () => {
    expect(detectCsvDelimiter('abc\ndef')).toBe(',')
    expect(detectCsvDelimiter('')).toBe(',')
  })

  it('CSV-20 引号里的不算', () => {
    expect(detectCsvDelimiter('"a;b;c;d",x,y')).toBe(',')
  })

  it('CSV-21 只看第一条记录（引号里的换行不结束它）', () => {
    expect(detectCsvDelimiter('a,b\n1;2;3;4;5')).toBe(',')
    expect(detectCsvDelimiter('"x\n;;;;",a,b')).toBe(',')
  })

  it('CSV-22 平手 → 逗号', () => {
    expect(detectCsvDelimiter('a,b;c')).toBe(',')
  })
})
