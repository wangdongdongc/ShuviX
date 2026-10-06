#!/usr/bin/env node
/**
 * 生成 GitHub Release 的说明正文：tag 自带的说明（若有）+ 上一个版本 tag 以来 main 第一父链上的提交标题。
 *
 * 为什么需要它：工作流里的 `generate_release_notes` 只按**合并的 Pull Request** 列条目，而本项目直接
 * 往 main 提交、不走 PR，自动生成的说明就只剩一条 Full Changelog 链接。这里改用两样现成的素材 ——
 * 带说明的 tag 正文（面向用户的一段概述）和提交标题（完整的英文句子）。工作流把它作为 `body_path`
 * 传给发布步骤，GitHub 再把自动生成的 Full Changelog 链接接在后面。
 *
 * 用法：node .github/scripts/release-notes.mjs <tag> > release-notes.md
 * 需要完整的历史与带说明的 tag 对象（checkout 时 fetch-depth: 0，并重新 fetch 该 tag）。
 */
import { execFileSync } from 'node:child_process'

const tag = process.argv[2]
if (!tag) {
  console.error('usage: release-notes.mjs <tag>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

/** 上一个版本 tag：从本 tag 的父提交往回找；第一个版本没有 */
function previousTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`)
  } catch {
    return ''
  }
}

/**
 * tag 的说明正文。只认带说明的 tag：轻量 tag 的 `%(contents)` 指向的是提交本身的信息，拿来当概述
 * 会把 Co-Authored-By 之类的尾注贴进说明里。第一行是版本号本身（打 tag 时的惯例），正文才是概述。
 */
function tagSummary() {
  if (git('cat-file', '-t', tag) !== 'tag') return ''
  return git('tag', '-l', '--format=%(contents:body)', tag)
    .replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*$/, '')
    .trim()
}

const prev = previousTag()
// 只沿 main 的第一父链：直接提交在 main 上的照列，长期分支合进来只算它那一条 merge 的标题 ——
// 分支内部的几百个提交（「P3-16: format」之类）不进发布说明，需要细节时看 merge 提交本身
const commits = git('log', '--first-parent', '--format=- %s (%h)', prev ? `${prev}..${tag}` : tag)
const summary = tagSummary()

const lines = []
if (summary) lines.push(summary, '')
lines.push('## Changes', '', commits || '- (no commits)')
process.stdout.write(lines.join('\n') + '\n')
