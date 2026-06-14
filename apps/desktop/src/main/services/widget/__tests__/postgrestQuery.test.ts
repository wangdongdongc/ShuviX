import { describe, it, expect } from 'vitest'
import { parseQuery, PostgrestQueryError } from '../postgrestQuery'

function qs(s: string): URLSearchParams {
  return new URLSearchParams(s)
}

describe('parseQuery — select / order / limit / offset', () => {
  it('defaults select to *, empty where/order, null limit/offset', () => {
    const r = parseQuery(qs(''))
    expect(r.selectClause).toBe('*')
    expect(r.whereClause).toBe('')
    expect(r.orderClause).toBe('')
    expect(r.limit).toBe(null)
    expect(r.offset).toBe(null)
    expect(r.params).toEqual([])
  })

  it('quotes select columns', () => {
    const r = parseQuery(qs('select=id,name,created_at'))
    expect(r.selectClause).toBe('"id", "name", "created_at"')
  })

  it('preserves wildcard select=*', () => {
    expect(parseQuery(qs('select=*')).selectClause).toBe('*')
  })

  it('rejects embedded resources in select', () => {
    expect(() => parseQuery(qs('select=*,author(*)'))).toThrow(PostgrestQueryError)
    expect(() => parseQuery(qs('select=id:alias'))).toThrow(PostgrestQueryError)
  })

  it('parses order with direction and nulls modifier', () => {
    expect(parseQuery(qs('order=created_at.desc.nullslast')).orderClause).toBe(
      '"created_at" DESC NULLS LAST'
    )
    expect(parseQuery(qs('order=a.asc,b.desc.nullsfirst')).orderClause).toBe(
      '"a" ASC, "b" DESC NULLS FIRST'
    )
  })

  it('order without direction defaults to ASC', () => {
    expect(parseQuery(qs('order=name')).orderClause).toBe('"name" ASC')
  })

  it('rejects unknown order modifiers', () => {
    expect(() => parseQuery(qs('order=name.sideways'))).toThrow(PostgrestQueryError)
  })

  it('parses limit / offset as integers', () => {
    const r = parseQuery(qs('limit=20&offset=40'))
    expect(r.limit).toBe(20)
    expect(r.offset).toBe(40)
  })

  it('rejects negative / non-integer limit', () => {
    expect(() => parseQuery(qs('limit=-1'))).toThrow(PostgrestQueryError)
    expect(() => parseQuery(qs('limit=1.5'))).toThrow(PostgrestQueryError)
    expect(() => parseQuery(qs('limit=abc'))).toThrow(PostgrestQueryError)
  })
})

describe('parseQuery — filter operators', () => {
  it('eq → parameterized =', () => {
    const r = parseQuery(qs('id=eq.5'))
    expect(r.whereClause).toBe('"id" = $1')
    expect(r.params).toEqual(['5'])
  })

  it('multiple filters AND together with sequential placeholders', () => {
    const r = parseQuery(qs('a=gte.10&b=lt.100'))
    expect(r.whereClause).toBe('"a" >= $1 AND "b" < $2')
    expect(r.params).toEqual(['10', '100'])
  })

  it('neq / gt / gte / lt / lte', () => {
    expect(parseQuery(qs('x=neq.0')).whereClause).toBe('"x" <> $1')
    expect(parseQuery(qs('x=gt.0')).whereClause).toBe('"x" > $1')
    expect(parseQuery(qs('x=gte.0')).whereClause).toBe('"x" >= $1')
    expect(parseQuery(qs('x=lt.0')).whereClause).toBe('"x" < $1')
    expect(parseQuery(qs('x=lte.0')).whereClause).toBe('"x" <= $1')
  })

  it('like / ilike convert * to %', () => {
    const r = parseQuery(qs('name=ilike.*foo*'))
    expect(r.whereClause).toBe('"name" ILIKE $1')
    expect(r.params).toEqual(['%foo%'])
  })

  it('in.(a,b,c) emits parameterized IN with sequential $n', () => {
    const r = parseQuery(qs('status=in.(active,pending,closed)'))
    expect(r.whereClause).toBe('"status" IN ($1, $2, $3)')
    expect(r.params).toEqual(['active', 'pending', 'closed'])
  })

  it('empty in.() → FALSE (no params consumed)', () => {
    const r = parseQuery(qs('status=in.()'))
    expect(r.whereClause).toBe('FALSE')
    expect(r.params).toEqual([])
  })

  it('is.null / is.true / is.false / is.unknown — no params', () => {
    expect(parseQuery(qs('deleted_at=is.null')).whereClause).toBe('"deleted_at" IS NULL')
    expect(parseQuery(qs('done=is.true')).whereClause).toBe('"done" IS TRUE')
    expect(parseQuery(qs('done=is.false')).whereClause).toBe('"done" IS FALSE')
    expect(parseQuery(qs('x=is.unknown')).whereClause).toBe('"x" IS UNKNOWN')
    expect(parseQuery(qs('x=is.null')).params).toEqual([])
  })

  it('rejects unsupported is.<value>', () => {
    expect(() => parseQuery(qs('x=is.42'))).toThrow(PostgrestQueryError)
  })

  it('IN placeholders continue numbering after preceding eq filter', () => {
    const r = parseQuery(qs('a=eq.1&tags=in.(x,y)'))
    expect(r.whereClause).toBe('"a" = $1 AND "tags" IN ($2, $3)')
    expect(r.params).toEqual(['1', 'x', 'y'])
  })
})

describe('parseQuery — security / validation', () => {
  it('rejects column names with non-identifier characters', () => {
    expect(() => parseQuery(qs('id;drop=eq.1'))).toThrow(PostgrestQueryError)
    expect(() => parseQuery(qs('x x=eq.1'))).toThrow(PostgrestQueryError)
    expect(() => parseQuery(qs('"col"=eq.1'))).toThrow(PostgrestQueryError)
  })

  it('rejects unknown operator names', () => {
    expect(() => parseQuery(qs('x=overlap.1'))).toThrow(PostgrestQueryError)
  })

  it('explicitly rejects fts / cs / cd / not / nxr / nxl / adj / sl / sr', () => {
    for (const op of ['fts', 'cs', 'cd', 'not', 'nxr', 'nxl', 'adj', 'sl', 'sr']) {
      expect(() => parseQuery(qs(`x=${op}.1`))).toThrow(PostgrestQueryError)
    }
  })

  it('rejects and()/or() top-level logical operators', () => {
    expect(() => parseQuery(qs('and=(a.eq.1,b.eq.2)'))).toThrow(PostgrestQueryError)
    expect(() => parseQuery(qs('or=(a.eq.1,b.eq.2)'))).toThrow(PostgrestQueryError)
  })

  it('rejects filter values without "op.value" form', () => {
    expect(() => parseQuery(qs('id=5'))).toThrow(PostgrestQueryError)
  })

  it('rejects malformed in list (missing parens)', () => {
    expect(() => parseQuery(qs('x=in.a,b,c'))).toThrow(PostgrestQueryError)
  })

  it('rejects order column with invalid identifier', () => {
    expect(() => parseQuery(qs('order=col;drop.asc'))).toThrow(PostgrestQueryError)
  })

  it('column names quoted always — even when valid', () => {
    expect(parseQuery(qs('x=eq.1')).whereClause).toBe('"x" = $1')
  })
})
