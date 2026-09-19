/**
 * 技能 md 的笔记本载体 —— 点侧栏「技能」分组里的一行，打开的就是那个技能目录里的 `SKILL.md`
 * （与 bot / agent 档案同一条路：一份文件 = 一个笔记本会话，live-preview、自动保存、外部改动
 * 自动重载）。会话挂在隐藏的承载项目下，`notebookPath` 是**技能目录名 + `/SKILL.md`** ——
 * 一个技能是目录而不是单文件（SKILL.md 之外还有 `references/` 那些伴随文件），所以这里的
 * notebookPath 天然带一层子路径，与知识库条目同形。
 *
 * 三种来源、三种承载项目，因为承载项目的 `path` 决定 notebookPath 相对哪个根解析：
 *   - 默认目录 `~/.shuvix/skills/` —— 固定 id，可编辑；
 *   - 内置目录（随应用发布的 `Resources/skills/<lang>/`）—— 固定 id，**只读**（改了下次更新
 *     就被替换掉），且它的 path 随界面语言变，与内置知识库同一套处理；
 *   - 用户添加的外部目录 —— 路径任意、数量不定，**id 只能按目录名现拼**（`__skills:<name>__`）。
 *     外部目录的名字由用户在添加时取，技能标识 `<dirName>:<skillName>` 也用它，所以它同时是
 *     这个载体的稳定键。
 */

/** 默认技能目录（`~/.shuvix/skills/`）的承载项目 —— 可编辑 */
export const SKILL_DEFAULT_PROJECT_ID = '__skills__'

/**
 * 内置技能（随应用发布）的承载项目 —— **只读**。它的 path 是当前界面语言那一版的目录，
 * 与内置知识库同策：切语言时宿主把这一行改指到新语言的目录上。
 */
export const SKILL_BUILTIN_PROJECT_ID = '__skills_builtin__'

/** 外部技能目录的承载项目 id 前缀（后接目录名 + `__`） */
const SKILL_EXTERNAL_PREFIX = '__skills:'

/** 某个外部技能目录的承载项目 id（目录名是用户取的、在配置里唯一） */
export function skillExternalProjectId(dirName: string): string {
  return `${SKILL_EXTERNAL_PREFIX}${dirName}__`
}

/** 这个项目是不是技能的某个承载项目（固定两个 + 任意个外部目录） */
export function isSkillProjectId(id: string | null | undefined): boolean {
  if (!id) return false
  return (
    id === SKILL_DEFAULT_PROJECT_ID ||
    id === SKILL_BUILTIN_PROJECT_ID ||
    (id.startsWith(SKILL_EXTERNAL_PREFIX) &&
      id.endsWith('__') &&
      id.length > SKILL_EXTERNAL_PREFIX.length + 2)
  )
}

/**
 * 只读的技能笔记：内置技能在应用包里，改它没有意义（下次更新整目录被替换，macOS 上还会
 * 破坏应用签名）。用户自己的默认目录与外部目录都可编辑 —— 外部目录是用户自己的文件夹。
 */
export function isReadOnlySkillProjectId(id: string | null | undefined): boolean {
  return id === SKILL_BUILTIN_PROJECT_ID
}

/** 技能目录名 → 该技能在承载项目里的 notebookPath */
export function skillNotebookPath(skillDirName: string): string {
  return `${skillDirName}/SKILL.md`
}
