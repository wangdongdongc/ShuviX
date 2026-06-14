#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// 基于 check-i18n-unused.mjs 的输出，安全地从 en/zh/ja locale 中删除未使用键。
//
// 安全策略 (按从严到宽):
//   1) 只删 check-i18n-unused 输出的 "unused" 列表 (已排除动态 pattern 命中的)
//   2) 兜底字面量检查: 对每个候选键，再做一次源码字面量搜索 (排除 locales/)，
//      只要键的完整 dot-path 出现在任何 .ts/.tsx/.js/.jsx/.mjs/.cjs 中，
//      就保留 (覆盖 const KEY = 'a.b.c' 这种间接引用)
//   3) 同步删除 zh.json / ja.json 中相同路径的键
//   4) 不动态构造路径的键 (例如根本没在 en 出现的孤儿键) 由本脚本另行汇报，不主动删
//
// 用法:
//   node scripts/purge-i18n-unused.mjs            # dry-run, 只汇报
//   node scripts/purge-i18n-unused.mjs --apply    # 实际写入

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC_DIR = path.join(ROOT, 'src')
const LOCALES_DIR = path.join(ROOT, 'src/shared/i18n/locales')

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '.git'])

const APPLY = process.argv.includes('--apply')

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (SOURCE_EXTS.has(path.extname(entry.name))) files.push(full)
  }
  return files
}

function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out.push(key)
  }
  return out
}

function deleteByPath(obj, parts) {
  if (parts.length === 0) return false
  const [head, ...rest] = parts
  if (!(head in obj)) return false
  if (rest.length === 0) {
    delete obj[head]
    return true
  }
  const child = obj[head]
  if (child && typeof child === 'object') {
    const removed = deleteByPath(child, rest)
    // 如果子对象删空了，连子对象一起清掉
    if (removed && Object.keys(child).length === 0) delete obj[head]
    return removed
  }
  return false
}

function extractUsages(text) {
  const staticKeys = new Set()
  const dynamicPatterns = []

  const staticRe = /\bt\(\s*(['"`])([^'"`$]+?)\1\s*[,)]/g
  for (const m of text.matchAll(staticRe)) staticKeys.add(m[2])

  const propRe = /\bi18nKey\s*=\s*(['"])([^'"]+?)\1/g
  for (const m of text.matchAll(propRe)) staticKeys.add(m[2])

  const dynRe = /\bt\(\s*`([^`]*\$\{[^`]*)`/g
  for (const m of text.matchAll(dynRe)) {
    const raw = m[1]
    let regexStr = '^'
    let i = 0
    while (i < raw.length) {
      if (raw[i] === '$' && raw[i + 1] === '{') {
        let depth = 1
        i += 2
        while (i < raw.length && depth > 0) {
          if (raw[i] === '{') depth++
          else if (raw[i] === '}') depth--
          i++
        }
        regexStr += '[^`]+?'
      } else {
        regexStr += raw[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        i++
      }
    }
    regexStr += '$'
    if (regexStr === '^[^`]+?$') continue
    try {
      dynamicPatterns.push(new RegExp(regexStr))
    } catch {
      // skip
    }
  }
  return { staticKeys, dynamicPatterns }
}

function loadLocale(name) {
  const file = path.join(LOCALES_DIR, `${name}.json`)
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) }
}

function saveLocale(file, data) {
  // 保留尾部换行
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

function main() {
  const en = loadLocale('en')
  const zh = loadLocale('zh')
  const ja = loadLocale('ja')

  const enKeys = flatten(en.data)
  const files = walk(SRC_DIR)

  const usedStatic = new Set()
  const dynamicPatterns = []
  // 收集每个源文件的全文，用于"字面量兜底"检查 (排除 locale 文件)
  const sourceTexts = []
  for (const file of files) {
    const isLocale = file.startsWith(LOCALES_DIR)
    const text = fs.readFileSync(file, 'utf8')
    if (!isLocale) sourceTexts.push(text)
    const { staticKeys, dynamicPatterns: dyn } = extractUsages(text)
    for (const k of staticKeys) usedStatic.add(k)
    for (const p of dyn) dynamicPatterns.push(p)
  }

  const corpus = sourceTexts.join('\n')

  const toDelete = []
  const savedByDynamic = []
  const savedByLiteral = []

  for (const key of enKeys) {
    if (usedStatic.has(key)) continue
    if (dynamicPatterns.some((re) => re.test(key))) {
      savedByDynamic.push(key)
      continue
    }
    // 字面量兜底: 任何引号内出现的完整 dot-path
    const needle1 = `'${key}'`
    const needle2 = `"${key}"`
    const needle3 = `\`${key}\``
    if (corpus.includes(needle1) || corpus.includes(needle2) || corpus.includes(needle3)) {
      savedByLiteral.push(key)
      continue
    }
    toDelete.push(key)
  }

  // 孤儿键: zh/ja 有但 en 没有
  const enKeySet = new Set(enKeys)
  const zhOrphans = flatten(zh.data).filter((k) => !enKeySet.has(k))
  const jaOrphans = flatten(ja.data).filter((k) => !enKeySet.has(k))

  console.log(`总键数 (en): ${enKeys.length}`)
  console.log(`静态命中: ${usedStatic.size}`)
  console.log(`动态 pattern 保留: ${savedByDynamic.length}`)
  console.log(`字面量兜底保留: ${savedByLiteral.length}`)
  console.log(`将删除: ${toDelete.length}`)
  console.log(`zh 孤儿键 (en 中不存在): ${zhOrphans.length}`)
  console.log(`ja 孤儿键 (en 中不存在): ${jaOrphans.length}`)
  console.log('')

  if (savedByLiteral.length) {
    console.log('--- 因字面量兜底保留 (可能是间接引用) ---')
    for (const k of savedByLiteral) console.log(`  ${k}`)
    console.log('')
  }

  console.log('--- 将删除的键 ---')
  for (const k of toDelete) console.log(`  ${k}`)
  console.log('')

  if (zhOrphans.length) {
    console.log('--- zh 孤儿键 ---')
    for (const k of zhOrphans) console.log(`  ${k}`)
    console.log('')
  }
  if (jaOrphans.length) {
    console.log('--- ja 孤儿键 ---')
    for (const k of jaOrphans) console.log(`  ${k}`)
    console.log('')
  }

  if (!APPLY) {
    console.log('(dry-run, 加 --apply 实际写入)')
    return
  }

  // 实际执行删除: 三个 locale 文件都按 toDelete + 自身孤儿键删
  for (const k of toDelete) {
    const parts = k.split('.')
    deleteByPath(en.data, parts)
    deleteByPath(zh.data, parts)
    deleteByPath(ja.data, parts)
  }
  for (const k of zhOrphans) deleteByPath(zh.data, k.split('.'))
  for (const k of jaOrphans) deleteByPath(ja.data, k.split('.'))

  saveLocale(en.file, en.data)
  saveLocale(zh.file, zh.data)
  saveLocale(ja.file, ja.data)

  console.log(`已写入: ${en.file}`)
  console.log(`已写入: ${zh.file}`)
  console.log(`已写入: ${ja.file}`)
}

main()
