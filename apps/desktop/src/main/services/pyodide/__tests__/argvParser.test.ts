import { describe, it, expect } from 'vitest'
import { parseShuvixPythonArgv, splitPythonPath, HELP_TEXT } from '../argvParser'

describe('parseShuvixPythonArgv', () => {
  describe('-c mode', () => {
    it('parses -c with code', () => {
      const r = parseShuvixPythonArgv(['-c', 'print(1)'], false)
      expect(r.request).toEqual({
        mode: '-c',
        code: 'print(1)',
        pythonArgv: ['-c']
      })
    })

    it('forwards user args after -c code to sys.argv', () => {
      const r = parseShuvixPythonArgv(['-c', 'import sys; print(sys.argv)', 'a', 'b'], false)
      expect(r.request?.pythonArgv).toEqual(['-c', 'a', 'b'])
    })

    it('errors when -c has no argument', () => {
      const r = parseShuvixPythonArgv(['-c'], false)
      expect(r.error).toMatch(/argument expected for -c/)
    })
  })

  describe('-m mode', () => {
    it('parses -m with module and args', () => {
      const r = parseShuvixPythonArgv(['-m', 'http.server', '8000'], false)
      expect(r.request).toEqual({
        mode: '-m',
        code: '',
        target: 'http.server',
        pythonArgv: ['http.server', '8000']
      })
    })

    it('errors when -m has no module', () => {
      const r = parseShuvixPythonArgv(['-m'], false)
      expect(r.error).toMatch(/argument expected for -m/)
    })
  })

  describe('script mode', () => {
    it('treats first positional as script path', () => {
      const r = parseShuvixPythonArgv(['/abs/script.py', 'x', 'y'], false)
      expect(r.request).toEqual({
        mode: 'script',
        code: '',
        target: '/abs/script.py',
        pythonArgv: ['/abs/script.py', 'x', 'y']
      })
    })

    it('accepts relative paths', () => {
      const r = parseShuvixPythonArgv(['script.py'], false)
      expect(r.request?.mode).toBe('script')
      expect(r.request?.target).toBe('script.py')
    })
  })

  describe('stdin mode', () => {
    it('parses bare "-" with stdin', () => {
      const r = parseShuvixPythonArgv(['-'], true)
      expect(r.request).toEqual({
        mode: 'stdin',
        code: '',
        pythonArgv: ['-']
      })
    })

    it('forwards args after "-" to sys.argv', () => {
      const r = parseShuvixPythonArgv(['-', 'foo'], true)
      expect(r.request?.pythonArgv).toEqual(['-', 'foo'])
    })

    it('errors on "-" without stdin', () => {
      const r = parseShuvixPythonArgv(['-'], false)
      expect(r.error).toMatch(/requires stdin/)
    })

    it('empty argv with stdin → stdin mode', () => {
      const r = parseShuvixPythonArgv([], true)
      expect(r.request).toEqual({
        mode: 'stdin',
        code: '',
        pythonArgv: ['']
      })
    })

    it('empty argv without stdin → help text as error', () => {
      const r = parseShuvixPythonArgv([], false)
      expect(r.error).toBe(HELP_TEXT)
    })
  })

  describe('version/help flags', () => {
    it('-V → version mode', () => {
      const r = parseShuvixPythonArgv(['-V'], false)
      expect(r.request?.mode).toBe('version')
    })

    it('--version → version mode', () => {
      const r = parseShuvixPythonArgv(['--version'], false)
      expect(r.request?.mode).toBe('version')
    })

    it('-h → help text', () => {
      const r = parseShuvixPythonArgv(['-h'], false)
      expect(r.helpText).toBe(HELP_TEXT)
    })

    it('--help → help text', () => {
      const r = parseShuvixPythonArgv(['--help'], false)
      expect(r.helpText).toBe(HELP_TEXT)
    })
  })

  describe('unknown flags', () => {
    it('rejects unknown -X flag', () => {
      const r = parseShuvixPythonArgv(['-X', 'utf8'], false)
      expect(r.error).toMatch(/unknown option: -X/)
    })

    it('rejects long flag', () => {
      const r = parseShuvixPythonArgv(['--no-site'], false)
      expect(r.error).toMatch(/unknown option: --no-site/)
    })
  })
})

describe('splitPythonPath', () => {
  it('splits POSIX `:` separator on linux', () => {
    expect(splitPythonPath('/a:/b:/c', 'linux')).toEqual(['/a', '/b', '/c'])
  })

  it('splits POSIX `:` on darwin', () => {
    expect(splitPythonPath('/a:/b', 'darwin')).toEqual(['/a', '/b'])
  })

  it('splits Windows `;` separator and preserves drive letters', () => {
    expect(splitPythonPath('C:\\a;D:\\b', 'win32')).toEqual(['C:\\a', 'D:\\b'])
  })

  it('does NOT split `:` on Windows (drive letter safety)', () => {
    expect(splitPythonPath('C:\\foo', 'win32')).toEqual(['C:\\foo'])
  })

  it('drops empty entries', () => {
    expect(splitPythonPath('/a::/b:', 'linux')).toEqual(['/a', '/b'])
  })

  it('returns [] for undefined / empty', () => {
    expect(splitPythonPath(undefined, 'linux')).toEqual([])
    expect(splitPythonPath('', 'linux')).toEqual([])
  })

  it('trims whitespace', () => {
    expect(splitPythonPath(' /a : /b ', 'linux')).toEqual(['/a', '/b'])
  })
})
