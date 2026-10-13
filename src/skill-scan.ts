/**
 * Filesystem skill discovery for the picker's idle-host fallback.
 *
 * The skill registry layers providers by scope: the web-app composition
 * disables the base host `skill-filesystem` row and every preset mounts its
 * own, so provider lives in the preset layer — reachable only through a live
 * agent's scope chain. With no live agent the registry cannot enumerate
 * project skills at all; this module reads the same directories the provider
 * would (project root discovery walks up to `.git`, then `.dsh/skills` and
 * `.agents/skills`, plus the user-level roots) and parses SKILL.md front
 * matter for the name/description pair the picker displays. This is display
 * data only: grouping is name-based, and injection still resolves each name
 * against the real catalog at session time.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** A skill summary as the picker needs it (invocation policy is name-based). */
export interface ScannedSkill {
  name: string
  description?: string
  whenToUse?: string
}

let yamlPromise: Promise<typeof import('js-yaml')> | undefined
function loadYaml(): Promise<typeof import('js-yaml')> {
  yamlPromise ??= import('js-yaml')
  return yamlPromise
}

/**
 * Mirror the filesystem provider's project-root discovery: walk up from cwd
 * to the nearest ancestor containing `.git`, falling back to cwd itself.
 * Sync + existsSync: called at most once per picker refresh, on few paths.
 */
export function projectRootOf(cwd: string): string {
  let current = cwd
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

/**
 * Parse SKILL.md front matter (`---` fenced YAML block) into a skill summary.
 * Returns undefined when the file has no parsable block or no usable name —
 * the directory basename is applied by the caller as the fallback name.
 */
async function parseSkillMd(dir: string): Promise<ScannedSkill | undefined> {
  let raw: string
  try {
    raw = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  } catch {
    return undefined
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (match === null || match[1] === undefined) return undefined
  try {
    const yaml = await loadYaml()
    const meta = yaml.load(match[1]) as { name?: unknown; description?: unknown; whenToUse?: unknown } | undefined
    if (meta === null || typeof meta !== 'object') return undefined
    const name = typeof meta.name === 'string' && meta.name.trim().length > 0 ? meta.name.trim() : undefined
    if (name === undefined) return undefined
    return {
      name,
      ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
      ...(typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Scan skill directories derived from the given cwds (project roots via the
 * `.git` walk) plus the user-level roots, in that order. Each skill
 * directory must contain a SKILL.md; a missing/broken one is skipped. The
 * caller dedupes by name (first occurrence wins).
 */
export async function scanSkillDirectories(options: {
  cwds: readonly string[]
  dshHome?: string | undefined
  agentsHome?: string | undefined
}): Promise<ScannedSkill[]> {
  const roots: string[] = []
  const pushRoot = (dir: string | undefined): void => {
    if (typeof dir === 'string' && dir.length > 0 && !roots.includes(dir)) roots.push(dir)
  }
  for (const cwd of options.cwds) {
    const projectRoot = projectRootOf(cwd)
    pushRoot(join(projectRoot, '.dsh', 'skills'))
    pushRoot(join(projectRoot, '.agents', 'skills'))
  }
  pushRoot(join(options.dshHome ?? join(homedir(), '.dsh'), 'skills'))
  pushRoot(join(options.agentsHome ?? join(homedir(), '.agents'), 'skills'))

  const found: ScannedSkill[] = []
  for (const root of roots) {
    let children: string[]
    try {
      children = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const name of children) {
      const parsed = await parseSkillMd(join(root, name))
      if (parsed !== undefined) {
        found.push(parsed)
        continue
      }
      // No parsable front-matter name: fall back to the directory name only
      // when a SKILL.md exists at all, mirroring a minimal provider read.
      if (existsSync(join(root, name, 'SKILL.md'))) {
        found.push({ name })
      }
    }
  }
  return found
}
