#!/usr/bin/env node
// The repo's linter: no dependencies, a handful of rules, every .js file under src/, bin/ and scripts/.
//
//   npm run lint
//
// Rules: no-unused-imports, eqeqeq, semi (no semicolons at the end of a line), no-var, max-len (120),
// no-trailing-spaces, eol-last. Prints one problem per line and exits 1, or exits 0 when clean.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIRS = ['src', 'bin', 'scripts']
const MAX_LEN = 120

function filesUnder(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (name === 'node_modules' || name.startsWith('.')) continue
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else if (name.endsWith('.js')) out.push(path)
  }
  return out
}

const blank = (text) => text.replace(/[^\n]/g, ' ')

/** Characters after which a `/` starts a regular expression rather than a division */
const BEFORE_REGEX = '(,=:[!&|?{};+-*%<>~^'

/**
 * Two views of a file, each the same length as the file with its newlines kept:
 *   code      comments, strings, template literals and regular expressions blanked out
 *   noComment only comments blanked out
 */
function views(text) {
  let code = ''
  let noComment = ''
  let i = 0
  const keep = (from, to) => {
    code += text.slice(from, to)
    noComment += text.slice(from, to)
  }
  const literal = (from, to) => {
    code += blank(text.slice(from, to))
    noComment += text.slice(from, to)
  }
  const comment = (from, to) => {
    code += blank(text.slice(from, to))
    noComment += blank(text.slice(from, to))
  }
  // the end of a template literal starting at `start` (a backtick), nested templates included
  const templateEnd = (start) => {
    let j = start + 1
    while (j < text.length) {
      if (text[j] === '\\') j += 2
      else if (text[j] === '`') return j + 1
      else if (text[j] === '$' && text[j + 1] === '{') j = expressionEnd(j + 2)
      else j++
    }
    return text.length
  }
  // the end of a `${ … }` expression whose body starts at `start`
  const expressionEnd = (start) => {
    let depth = 1
    let j = start
    while (j < text.length && depth > 0) {
      const c = text[j]
      if (c === '`') j = templateEnd(j)
      else if (c === '"' || c === "'") j = stringEnd(j)
      else {
        if (c === '{') depth++
        if (c === '}') depth--
        j++
      }
    }
    return j
  }
  const stringEnd = (start) => {
    let j = start + 1
    while (j < text.length && text[j] !== text[start] && text[j] !== '\n') {
      j += text[j] === '\\' ? 2 : 1
    }
    return Math.min(j + 1, text.length)
  }
  const regexEnd = (start) => {
    let j = start + 1
    let inClass = false
    while (j < text.length && text[j] !== '\n') {
      const c = text[j]
      if (c === '\\') {
        j += 2
        continue
      }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) break
      j++
    }
    j++
    while (j < text.length && /[a-z]/.test(text[j])) j++
    return j
  }
  const startsRegex = () => {
    const before = code.trimEnd()
    if (before === '') return true
    if (/\b(return|typeof|case|in|of|void|delete|throw|yield|await)$/.test(before)) return true
    return BEFORE_REGEX.includes(before.at(-1))
  }
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    let end
    if (i === 0 && c === '#' && next === '!') {
      end = text.indexOf('\n')
      comment(0, end === -1 ? text.length : end)
    } else if (c === '/' && next === '/') {
      end = text.indexOf('\n', i)
      comment(i, end === -1 ? text.length : end)
    } else if (c === '/' && next === '*') {
      end = text.indexOf('*/', i + 2)
      comment(i, end === -1 ? text.length : end + 2)
    } else if (c === '"' || c === "'") {
      end = stringEnd(i)
      literal(i, end)
    } else if (c === '`') {
      end = templateEnd(i)
      literal(i, end)
    } else if (c === '/' && startsRegex()) {
      end = regexEnd(i)
      literal(i, end)
    } else {
      end = i + 1
      keep(i, end)
    }
    i = end === undefined || end <= i ? i + 1 : end
  }
  return { code, noComment }
}

/** 1-based line and column of an offset */
function position(text, offset) {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return { line, col: offset - before.lastIndexOf('\n') }
}

function lintFile(text) {
  const problems = []
  const add = (offset, message, rule) => problems.push({ ...position(text, offset), message, rule })
  const { code, noComment } = views(text)

  // no-unused-imports
  const IMPORT = /^import\s+([\w$\s{},*]+?)\s+from\s+(['"])[^'"\n]+\2/gm
  for (const m of noComment.matchAll(IMPORT)) {
    const clause = m[1]
    const names = []
    const braces = clause.match(/\{([^}]*)\}/)
    for (const part of braces ? braces[1].split(',') : []) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
      if (name) names.push(name)
    }
    const outside = clause.replace(/\{[^}]*\}/, '')
    for (const part of outside.split(',')) {
      const name = part.trim().replace(/^\*\s*as\s+/, '')
      if (name) names.push(name)
    }
    const rest = noComment.slice(0, m.index) + blank(m[0]) + noComment.slice(m.index + m[0].length)
    for (const name of names) {
      const used = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(rest)
      if (!used) {
        add(
          m.index + m[0].indexOf(name),
          `'${name}' is imported but never used`,
          'no-unused-imports'
        )
      }
    }
  }

  // eqeqeq and no-var, on code only
  for (const m of code.matchAll(/(?<![=!<>])(==|!=)(?!=)/g)) {
    add(m.index, `Expected '${m[1]}=' and instead saw '${m[1]}'`, 'eqeqeq')
  }
  for (const m of code.matchAll(/\bvar\s/g))
    add(m.index, 'Unexpected var, use let or const', 'no-var')

  // line rules
  const rawLines = text.split('\n')
  const codeLines = code.split('\n')
  let offset = 0
  for (const [n, line] of rawLines.entries()) {
    const codeLine = codeLines[n].trimEnd()
    if (codeLine.endsWith(';')) add(offset + codeLine.length - 1, 'Extra semicolon', 'semi')
    if (line.length > MAX_LEN) {
      add(
        offset,
        `This line has a length of ${line.length}. Maximum allowed is ${MAX_LEN}`,
        'max-len'
      )
    }
    if (/[ \t]+$/.test(line))
      add(offset + line.trimEnd().length, 'Trailing spaces not allowed', 'no-trailing-spaces')
    offset += line.length + 1
  }
  if (text.length > 0 && !text.endsWith('\n'))
    add(text.length, 'Newline required at end of file', 'eol-last')
  return problems.sort((a, b) => a.line - b.line || a.col - b.col)
}

const files = DIRS.flatMap((d) => filesUnder(join(ROOT, d)))
let count = 0
for (const file of files) {
  for (const p of lintFile(readFileSync(file, 'utf8'))) {
    count++
    console.log(`${relative(ROOT, file)}:${p.line}:${p.col}  ${p.message}  ${p.rule}`)
  }
}
if (count > 0) {
  console.log(`\n✖ ${count} problem${count === 1 ? '' : 's'}`)
  process.exitCode = 1
} else {
  console.log(`✔ ${files.length} files, no problems`)
}
