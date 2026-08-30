/**
 * Pure state logic for the dsh-mcp-skill-manager host half.
 *
 * Deliberately dependency-free (no Cordis, no schemastery): every function
 * here is unit-testable with plain `node --test` and is the single source of
 * truth for the state semantics shared by the manager_* tools, the RPC
 * surface, and the skill-catalog shadow provider in src/index.ts.
 *
 * All functions operate on plain JSON-shaped state objects:
 *   state = {
 *     groups: [{ id, name, enabled, skills: string[] }],
 *     sessions: { [sessionId]: { enabledGroupIds: string[] } },
 *   }
 *
 * `sessions[sessionId]` is that session's explicit group selection; a session
 * without an entry follows the global enabled-group union. An empty array
 * means the session injects nothing.
 *
 * MCP servers no longer live in this state: they are rows in the profile's
 * cordis.patch.yml (see src/patch.ts); this module only hosts the field-level
 * config validation shared by the add/update/probe paths.
 */

import { McpError } from './errors.ts'
import type { ManagerState, McpServerConfig, SkillGroup } from './types.ts'

/** Same domain as dsh-mcp-client's SERVER_NAME_PATTERN. Mirrored in lib/client.js (the browser bundle cannot import this module). */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Loader entry id domain for user-managed MCP rows. Mirrored in lib/client.js. */
export const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Validate a serverName against the dsh-mcp-client domain. */
export function isValidServerName(name: unknown): boolean {
  return typeof name === 'string' && SERVER_NAME_PATTERN.test(name)
}

/**
 * The injected skill set: the union of skill names across all enabled groups.
 * A skill listed in several enabled groups appears exactly once (Set dedup);
 * disabled groups contribute nothing.
 */
export function enabledSkillNames(state: ManagerState): Set<string> {
  const set = new Set<string>()
  for (const group of state.groups) {
    if (!group.enabled) continue
    for (const skill of group.skills) set.add(skill)
  }
  return set
}

/**
 * The injected skill set for ONE session. A session without an entry in
 * `state.sessions` follows the global union (identical to
 * enabledSkillNames); an entry is an explicit set of group ids whose skills
 * are injected regardless of the groups' global enabled flags — an override
 * detaches the session from the global toggles. Ids of deleted groups are
 * dropped on read; `[]` injects nothing.
 */
export function enabledSkillNamesFor(state: ManagerState, sessionId: string): Set<string> {
  const override = state.sessions?.[sessionId]
  if (override === undefined) return enabledSkillNames(state)
  const byId = new Map(state.groups.map((group) => [group.id, group]))
  const set = new Set<string>()
  for (const id of override.enabledGroupIds) {
    const group = byId.get(id)
    if (group === undefined) continue // deleted group id: dropped on read
    for (const skill of group.skills) set.add(skill)
  }
  return set
}

/** Find one group by stable id; undefined when absent. */
export function groupById(state: ManagerState, id: string): SkillGroup | undefined {
  return state.groups.find((group) => group.id === id)
}

/**
 * Append multiple skill names to a group in ONE immutable update (deduped).
 * The host batch RPC uses this so adding N skills costs one write + one
 * catalog invalidation instead of N writes + N invalidations.
 */
export function addSkillsToGroup(state: ManagerState, id: string, names: string[]): ManagerState {
  const group = state.groups.find((g) => g.id === id)
  if (group === undefined) throw new McpError('not-found', `group "${id}" does not exist`)
  const seen = new Set(group.skills)
  const added: string[] = []
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name)
      added.push(name)
    }
  }
  if (added.length === 0) return state
  return {
    ...state,
    groups: state.groups.map((g) => (g.id === id ? { ...g, skills: [...g.skills, ...added] } : g)),
  }
}

/**
 * Remove multiple skill names from a group in ONE immutable update.
 */
export function removeSkillsFromGroup(state: ManagerState, id: string, names: string[]): ManagerState {
  const group = state.groups.find((g) => g.id === id)
  if (group === undefined) throw new McpError('not-found', `group "${id}" does not exist`)
  const remove = new Set(names)
  const remaining = group.skills.filter((name) => !remove.has(name))
  if (remaining.length === group.skills.length) return state
  return {
    ...state,
    groups: state.groups.map((g) => (g.id === id ? { ...g, skills: remaining } : g)),
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((v) => typeof v === 'string')
}

/**
 * Pick the known dsh-mcp-client config fields out of a raw args object (tool
 * or RPC input). Values are picked verbatim — validateMcpConfig flags the
 * type errors, so nothing is silently dropped.
 */
export function pickServerConfig(input: Record<string, unknown>): Partial<McpServerConfig> {
  const config: Partial<McpServerConfig> = {
    serverName: input.serverName as string,
    transport: input.transport === 'stdio' ? 'stdio' : 'streamable-http',
  }
  // Values are picked verbatim (validated later by validateMcpConfig), so the
  // copy loop goes through a loose record view of the typed config object.
  const loose = config as Record<string, unknown>
  for (const key of ['url', 'command', 'args', 'env', 'cwd', 'headers', 'toolCallTimeoutMs', 'failOnStartupError']) {
    if (input[key] !== undefined) loose[key] = input[key]
  }
  return config
}

/**
 * Validate a proposed MCP server config; returns field-level errors keyed by
 * field name (empty object = valid). Every rule mirrors the dsh-mcp-client
 * schema so the panel rejects invalid input with the same semantics the
 * plugin would enforce at load. Replaces the old throw-on-first-error
 * validateMcpServerInput so the UI can display every violation inline.
 */
export function validateMcpConfig(id: string, config: Partial<McpServerConfig>): Record<string, string> {
  const errors: Record<string, string> = {}

  if (typeof id !== 'string' || !ENTRY_ID_PATTERN.test(id)) {
    errors.id = `Entry id must match ${ENTRY_ID_PATTERN.source}`
  }
  if (typeof config.serverName !== 'string' || !SERVER_NAME_PATTERN.test(config.serverName)) {
    errors.serverName = `serverName must match ${SERVER_NAME_PATTERN.source}`
  }
  const transport = config.transport === 'stdio' ? 'stdio' : 'streamable-http'
  if (transport === 'streamable-http') {
    if (typeof config.url !== 'string' || !/^https?:\/\/.+/.test(config.url)) {
      errors.url = 'A valid http(s):// URL is required for streamable-http'
    }
  } else {
    if (typeof config.command !== 'string' || config.command.trim() === '') {
      errors.command = 'An executable command is required for stdio'
    }
    if (config.args !== undefined
      && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))) {
      errors.args = 'args must be an array of strings'
    }
    if (config.cwd !== undefined && typeof config.cwd !== 'string') {
      errors.cwd = 'cwd must be a string'
    }
  }
  if (config.env !== undefined && !isStringRecord(config.env)) {
    errors.env = 'env must be a string-to-string map'
  }
  if (config.headers !== undefined && !isStringRecord(config.headers)) {
    errors.headers = 'headers must be a string-to-string map'
  }
  if (config.toolCallTimeoutMs !== undefined
    && (typeof config.toolCallTimeoutMs !== 'number' || config.toolCallTimeoutMs < 1)) {
    errors.toolCallTimeoutMs = 'toolCallTimeoutMs must be a positive number'
  }
  return errors
}

/** Fresh plain-JSON copy of the state (scalar fields only; never live data). */
export function snapshotState(state: ManagerState): ManagerState {
  return {
    groups: state.groups.map((group) => ({
      id: group.id,
      name: group.name,
      enabled: group.enabled,
      skills: [...group.skills],
    })),
    sessions: Object.fromEntries(
      Object.entries(state.sessions ?? {}).map(([sessionId, entry]) => [
        sessionId,
        { enabledGroupIds: [...entry.enabledGroupIds] },
      ]),
    ),
  }
}