// Checks for the rules the long set's users state in an early message, shared by the long graders. Each
// returns a list of problems (empty = the rule was kept), so a grader can throw them as one error.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The CHANGELOG.md every long task starts with (all three start overlays carry the same file) */
const START_CHANGELOG = readFileSync(
  new URL('./orders/start/CHANGELOG.md', import.meta.url),
  'utf8'
)

/** From the first released version ("## 1.4.0 — …") to the end */
const released = (text) => {
  const at = text.search(/^## \d/m)
  return at === -1 ? '' : text.slice(at).trimEnd()
}

/**
 * The CHANGELOG rule: the change is written under `## Unreleased`, one `- <area>: <text>` line per entry
 * where area is a directory under src/ (wrapped lines may continue indented), no sub-headings, and the
 * released versions are left exactly as they were.
 */
export function changelogProblems(repo) {
  const file = join(repo, 'CHANGELOG.md')
  if (!existsSync(file)) return ['CHANGELOG.md is gone']
  const text = readFileSync(file, 'utf8')
  const problems = []
  if (released(text) !== released(START_CHANGELOG)) problems.push('the released versions changed')
  const section = text.match(/^## Unreleased[ \t]*\r?\n([\s\S]*?)(?=^## )/m)
  if (!section) return [...problems, 'no "## Unreleased" section above the released versions']
  const areas = readdirSync(join(repo, 'src'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  const lines = section[1].split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) problems.push('nothing under "## Unreleased"')
  for (const [i, line] of lines.entries()) {
    if (i > 0 && /^\s{2,}\S/.test(line)) continue
    const bullet = line.match(/^- ([A-Za-z]+): \S/)
    if (!bullet) problems.push(`not a "- <area>: <text>" line: ${line.slice(0, 80)}`)
    else if (!areas.includes(bullet[1]))
      problems.push(`"${bullet[1]}" is not a directory under src/`)
  }
  return problems
}
