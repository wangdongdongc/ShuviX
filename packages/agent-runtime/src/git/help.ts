/**
 * git 工具完整手册（action:"help"）—— 长尾细节不占常驻 description 预算。
 * 章节骨架由 GIT_OPS 生成 usage 清单，正文为静态英文常量（发给 LLM，不走 i18n）。
 */
import { GIT_OPS } from './ops'

export const GIT_HELP_TOPICS = ['workflow', 'diff', 'branching', 'destructive', 'author'] as const
export type GitHelpTopic = (typeof GIT_HELP_TOPICS)[number]

const SECTIONS: Record<GitHelpTopic, string> = {
  workflow: `## workflow — inspect, stage, commit

Typical loop:
1. status() — see what changed. Codes: "XY path" where X = staged (HEAD→index), Y = unstaged (index→worktree); "??" = untracked.
2. diff() / diff(staged:true) — review unstaged / staged changes before committing.
3. add(paths) — stage files. paths:["."] stages everything, including deletions.
4. commit(message) — commit the staged changes.
Inspection: log(ref?, depth?, path?) for history; show(ref) for one commit's metadata + changed files.
On large repos pass paths/path filters to status/diff to keep output small.`,

  diff: `## diff — three modes (mutually exclusive)

1. diff() — worktree vs index: what you would stage with add. Untracked files are NOT shown (use status).
2. diff(staged:true) — index vs HEAD: what you would commit.
3. diff(from, to?) — between two commits; omit "to" to compare a commit against the current worktree.
path:"dir/or/file" filters any mode. Binary files show as "Binary files ... differ".
Output is a unified patch compatible with git apply.`,

  branching: `## branching

branch() — list local branches, current one marked "* ".
branch(name) — create AND switch to a new branch.
branch(name, delete:true) — delete a branch (refuses to delete the current one).
checkout(ref) — switch to a branch or commit. If uncommitted changes would be overwritten it refuses
and lists the conflicting files; commit them first, or pass force:true to DISCARD them.`,

  destructive: `## destructive operations — read before using

- restore(paths, ref?) — overwrites those files in the worktree with the version from ref (default HEAD).
  Their local modifications are LOST. There is no undo for uncommitted changes.
- checkout(ref, force:true) — discards ALL conflicting local changes while switching.
Prefer committing (commits are recoverable) before any destructive call.
This tool has no clone/fetch/pull/push — network git is out of scope.`,

  author: `## author — commit identity resolution

commit resolves the author in this order:
1. authorName + authorEmail parameters (both required to take effect);
2. user.name / user.email in the repository .git/config;
3. host-level fallback (desktop reads ~/.gitconfig; not available in the browser extension).
If none is found, commit fails with an explanatory error — ask the user for their name/email
and pass them as parameters. The committer always equals the author.`
}

/** 生成手册全文；topic 给定时只回该章节（未知 topic 回全文） */
export function buildGitHelp(topic?: string): string {
  const key = GIT_HELP_TOPICS.find((t) => t === topic)
  if (key) return SECTIONS[key]
  const usageList = GIT_OPS.map((op) => `- ${op.usage}`).join('\n')
  return `# git tool manual

Local version control backed by isomorphic-git — works identically on desktop and in the browser extension.

Actions:
${usageList}

${GIT_HELP_TOPICS.map((t) => SECTIONS[t]).join('\n\n')}`
}
