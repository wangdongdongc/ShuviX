import { describe, it, expect } from 'vitest'
import { parseShuvixPgliteArgv, HELP_TEXT } from '../argvParser'

describe('parseShuvixPgliteArgv', () => {
  describe('-c mode', () => {
    it('parses -c with SQL', () => {
      const r = parseShuvixPgliteArgv(['-c', 'SELECT 1;'], false)
      expect(r.request).toEqual({ mode: '-c', sql: 'SELECT 1;', extensions: [] })
    })

    it('errors when -c has no argument', () => {
      const r = parseShuvixPgliteArgv(['-c'], false)
      expect(r.error).toMatch(/argument expected for -c/)
    })

    it('rejects extra positional after -c sql', () => {
      const r = parseShuvixPgliteArgv(['-c', 'SELECT 1', 'extra'], false)
      expect(r.error).toMatch(/unexpected extra arguments/)
    })
  })

  describe('-f mode', () => {
    it('parses -f with path', () => {
      const r = parseShuvixPgliteArgv(['-f', '/tmp/q.sql'], false)
      expect(r.request).toEqual({
        mode: 'file',
        sql: '',
        filePath: '/tmp/q.sql',
        extensions: []
      })
    })

    it('errors when -f has no argument', () => {
      const r = parseShuvixPgliteArgv(['-f'], false)
      expect(r.error).toMatch(/argument expected for -f/)
    })
  })

  describe('stdin mode', () => {
    it('bare "-" with stdin', () => {
      const r = parseShuvixPgliteArgv(['-'], true)
      expect(r.request).toEqual({ mode: 'stdin', sql: '', extensions: [] })
    })

    it('"-" without stdin → error', () => {
      const r = parseShuvixPgliteArgv(['-'], false)
      expect(r.error).toMatch(/requires stdin/)
    })

    it('empty argv with stdin → stdin mode', () => {
      const r = parseShuvixPgliteArgv([], true)
      expect(r.request).toEqual({ mode: 'stdin', sql: '', extensions: [] })
    })

    it('empty argv without stdin → help text as error', () => {
      const r = parseShuvixPgliteArgv([], false)
      expect(r.error).toBe(HELP_TEXT)
    })
  })

  describe('version / help', () => {
    it('-V → version mode', () => {
      const r = parseShuvixPgliteArgv(['-V'], false)
      expect(r.request?.mode).toBe('version')
    })

    it('--version → version mode', () => {
      const r = parseShuvixPgliteArgv(['--version'], false)
      expect(r.request?.mode).toBe('version')
    })

    it('-h → help text', () => {
      const r = parseShuvixPgliteArgv(['-h'], false)
      expect(r.helpText).toBe(HELP_TEXT)
    })

    it('--help → help text', () => {
      const r = parseShuvixPgliteArgv(['--help'], false)
      expect(r.helpText).toBe(HELP_TEXT)
    })
  })

  describe('--extension', () => {
    it('single extension before -c', () => {
      const r = parseShuvixPgliteArgv(['--extension', 'vector', '-c', 'SELECT 1'], false)
      expect(r.request?.extensions).toEqual(['vector'])
      expect(r.request?.mode).toBe('-c')
      expect(r.request?.sql).toBe('SELECT 1')
    })

    it('multiple extensions interleaved with mode flag', () => {
      const r = parseShuvixPgliteArgv(
        ['--extension', 'vector', '-c', 'SELECT 1', '--extension', 'pg_trgm'],
        false
      )
      // collectExtensions removes them all before mode-parse; -c handling sees no extras
      expect(r.request?.extensions).toEqual(['vector', 'pg_trgm'])
      expect(r.request?.mode).toBe('-c')
    })

    it('errors when --extension has no value', () => {
      const r = parseShuvixPgliteArgv(['--extension'], false)
      expect(r.error).toMatch(/argument expected for --extension/)
    })

    it('--extension with stdin mode', () => {
      const r = parseShuvixPgliteArgv(['--extension', 'pg_trgm'], true)
      expect(r.request).toEqual({
        mode: 'stdin',
        sql: '',
        extensions: ['pg_trgm']
      })
    })
  })

  describe('unknown flags', () => {
    it('rejects unknown short flag', () => {
      const r = parseShuvixPgliteArgv(['-x'], false)
      expect(r.error).toMatch(/unknown option: -x/)
    })

    it('rejects unknown long flag', () => {
      const r = parseShuvixPgliteArgv(['--unknown'], false)
      expect(r.error).toMatch(/unknown option: --unknown/)
    })

    it('rejects bare positional (not a script — use -f)', () => {
      const r = parseShuvixPgliteArgv(['some.sql'], false)
      expect(r.error).toMatch(/unrecognized argument: some.sql/)
    })
  })
})
