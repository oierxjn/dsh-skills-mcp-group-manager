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
import type { ManagerState, McpServerConfig, SkillGroup } from './types.ts';
/** Same domain as dsh-mcp-client's SERVER_NAME_PATTERN. Mirrored in lib/client.js (the browser bundle cannot import this module). */
export declare const SERVER_NAME_PATTERN: RegExp;
/** Loader entry id domain for user-managed MCP rows. Mirrored in lib/client.js. */
export declare const ENTRY_ID_PATTERN: RegExp;
/** Validate a serverName against the dsh-mcp-client domain. */
export declare function isValidServerName(name: unknown): boolean;
/**
 * The injected skill set: the union of skill names across all enabled groups.
 * A skill listed in several enabled groups appears exactly once (Set dedup);
 * disabled groups contribute nothing.
 */
export declare function enabledSkillNames(state: ManagerState): Set<string>;
/**
 * The injected skill set for ONE session. A session without an entry in
 * `state.sessions` follows the global union (identical to
 * enabledSkillNames); an entry is an explicit set of group ids whose skills
 * are injected regardless of the groups' global enabled flags — an override
 * detaches the session from the global toggles. Ids of deleted groups are
 * dropped on read; `[]` injects nothing.
 */
export declare function enabledSkillNamesFor(state: ManagerState, sessionId: string): Set<string>;
/** Find one group by stable id; undefined when absent. */
export declare function groupById(state: ManagerState, id: string): SkillGroup | undefined;
/**
 * Append multiple skill names to a group in ONE immutable update (deduped).
 * The host batch RPC uses this so adding N skills costs one write + one
 * catalog invalidation instead of N writes + N invalidations.
 */
export declare function addSkillsToGroup(state: ManagerState, id: string, names: string[]): ManagerState;
/**
 * Remove multiple skill names from a group in ONE immutable update.
 */
export declare function removeSkillsFromGroup(state: ManagerState, id: string, names: string[]): ManagerState;
/**
 * Pick the known dsh-mcp-client config fields out of a raw args object (tool
 * or RPC input). Values are picked verbatim — validateMcpConfig flags the
 * type errors, so nothing is silently dropped.
 */
export declare function pickServerConfig(input: Record<string, unknown>): Partial<McpServerConfig>;
/**
 * Validate a proposed MCP server config; returns field-level errors keyed by
 * field name (empty object = valid). Every rule mirrors the dsh-mcp-client
 * schema so the panel rejects invalid input with the same semantics the
 * plugin would enforce at load. Replaces the old throw-on-first-error
 * validateMcpServerInput so the UI can display every violation inline.
 */
export declare function validateMcpConfig(id: string, config: Partial<McpServerConfig>): Record<string, string>;
/** Fresh plain-JSON copy of the state (scalar fields only; never live data). */
export declare function snapshotState(state: ManagerState): ManagerState;
//# sourceMappingURL=state.d.ts.map