import { describe, it, expect } from 'vitest'
import { matchHook } from '../hookMatcher'

describe('matchHook', () => {
  describe('wildcard / empty / undefined', () => {
    it('undefined matches anything', () => {
      expect(matchHook(undefined, 'bash')).toBe(true)
      expect(matchHook(undefined, '')).toBe(true)
    })
    it('empty string matches anything', () => {
      expect(matchHook('', 'bash')).toBe(true)
    })
    it('"*" matches anything', () => {
      expect(matchHook('*', 'bash')).toBe(true)
      expect(matchHook('*', '')).toBe(true)
    })
  })

  describe('exact list (alphanumeric + underscore + pipe)', () => {
    it('single name matches exactly', () => {
      expect(matchHook('bash', 'bash')).toBe(true)
      expect(matchHook('bash', 'Edit')).toBe(false)
    })
    it('pipe-separated list matches any', () => {
      expect(matchHook('bash|Edit|Write', 'Edit')).toBe(true)
      expect(matchHook('bash|Edit|Write', 'bash')).toBe(true)
      expect(matchHook('bash|Edit|Write', 'Read')).toBe(false)
    })
    it('underscores allowed in exact list', () => {
      expect(matchHook('mcp_tool|skill_x', 'mcp_tool')).toBe(true)
    })
    it('exact matcher is NOT a partial match', () => {
      expect(matchHook('bash', 'bashfoo')).toBe(false)
      expect(matchHook('Edit', 'EditFile')).toBe(false)
    })
  })

  describe('regex (falls through when chars outside [A-Za-z0-9_|])', () => {
    it('treats string with . as regex', () => {
      expect(matchHook('^mcp__.*', 'mcp__memory__add')).toBe(true)
      expect(matchHook('^mcp__.*', 'bash')).toBe(false)
    })
    it('treats string with parens as regex', () => {
      expect(matchHook('(bash|Edit)', 'bash')).toBe(true)
      expect(matchHook('(bash|Edit)', 'Read')).toBe(false)
    })
    it('invalid regex returns false (does not throw)', () => {
      expect(matchHook('[unclosed', 'anything')).toBe(false)
    })
  })
})
