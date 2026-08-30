/**
 * Shared JSDoc type definitions for the dsh-skills-mcp-group-manager plugin.
 *
 * This module is TYPES ONLY: it holds no runtime code and is referenced from
 * JSDoc type positions via `import('./types.js')`, which is fully erased.
 * Keeping the shapes here means the host half, the patch editor, and the
 * probe all describe the same contract from a single source of truth.
 *
 * @module dsh-skills-mcp-group-manager/types
 */

/**
 * One skill group as persisted in `state.json`.
 *
 * @typedef {object} SkillGroup
 * @property {string} id Stable group id (uuid).
 * @property {string} name Display name.
 * @property {boolean} enabled Global on/off toggle.
 * @property {string[]} skills Member skill names (deduped).
 */

/**
 * A session's explicit group selection (per-session override). Absent entry =
 * the session follows the global enabled-group union.
 *
 * @typedef {object} SessionOverride
 * @property {string[]} enabledGroupIds Explicit group ids; `[]` injects nothing.
 */

/**
 * The manager state persisted to `<harness home>/mcp-skill-manager/state.json`.
 *
 * @typedef {object} ManagerState
 * @property {SkillGroup[]} groups Skill groups.
 * @property {Record<string, SessionOverride>} sessions Per-session overrides keyed by session (agent) id.
 */

/**
 * An MCP server config as stored in a `cordis.patch.yml` row and passed to
 * probes. Mirrors the `@deepseek-ai/dsh-mcp-client` entry config schema.
 *
 * Optional props are declared `| undefined` so the codebase's
 * assign-undefined-to-drop style stays valid under exactOptionalPropertyTypes.
 *
 * @typedef {object} McpServerConfig
 * @property {string} serverName Unique server name (becomes `mcp__<serverName>__*` tools).
 * @property {'stdio' | 'streamable-http'} transport Transport kind.
 * @property {string | undefined} [url] Endpoint URL (streamable-http only).
 * @property {string | undefined} [command] Executable command (stdio only).
 * @property {string[] | undefined} [args] Command arguments (stdio only).
 * @property {Record<string, string> | undefined} [env] Child env overrides (stdio only).
 * @property {string | undefined} [cwd] Child working directory (stdio only).
 * @property {Record<string, string> | undefined} [headers] Extra HTTP headers (streamable-http only).
 * @property {number | undefined} [toolCallTimeoutMs] Per-call timeout override (ms).
 * @property {boolean | undefined} [failOnStartupError] Reject activation when the initial connection fails.
 * @property {Record<string, unknown> | undefined} [reconnect] Reconnect policy passthrough.
 */

/**
 * A probe outcome before latency is attached.
 *
 * @typedef {object} ProbeOk
 * @property {true} ok
 * @property {number} toolCount Number of tools the server advertised.
 *
 * @typedef {object} ProbeFail
 * @property {false} ok
 * @property {string} error Human-readable failure reason (never thrown).
 */

/**
 * Final probe result: raw outcome plus measured latency. Never throws.
 *
 * @typedef {(ProbeOk | ProbeFail) & { latencyMs: number }} ProbeOutcome
 */

/**
 * The public projection of a live MCP server: its normalized config plus
 * runtime status (loader entry id, enabled flag, fiber phase, tool count).
 *
 * @typedef {McpServerConfig & {
 *   id: string,
 *   enabled: boolean,
 *   fiberPhase: string | null,
 *   toolCount: number,
 *   userManaged: boolean,
 * }} ServerStatus
 */

/**
 * A top-level row of the profile `cordis.patch.yml` (cordis-plugin-include
 * dialect). Rows are user-authored YAML, so unknown extra keys are allowed.
 *
 * @typedef {object} PatchEntry
 * @property {string} [id] Loader entry id.
 * @property {string} [name] Plugin package name.
 * @property {unknown} [config] Plugin config (for MCP rows: McpServerConfig).
 * @property {boolean} [disabled] Disable override.
 */

/**
 * Either a plain override row or an insert row that appends brand-new entries.
 * `insert` is optional (rather than a strict either/or union) so callers can
 * probe `row.insert` with plain `Array.isArray`, and user-authored YAML rows
 * may carry overlapping keys anyway.
 *
 * @typedef {PatchEntry & { insert?: PatchEntry[] }} PatchRow
 */

/**
 * Minimal logger contract the modules accept (subset of console).
 *
 * @typedef {object} Logger
 * @property {(message?: unknown, ...rest: unknown[]) => void} [warn]
 * @property {(message?: unknown, ...rest: unknown[]) => void} [error]
 */

/**
 * The plugin-owned state store returned by createStateStore: a get/update
 * surface over the persisted ManagerState plus load/persist for startup and
 * tooling. `dir`/`file` expose the plugin-owned state location (removed with
 * the plugin on uninstall).
 *
 * @typedef {object} StateStore
 * @property {() => Promise<ManagerState>} load Load state from disk (async variant; kept for tests/tooling).
 * @property {() => ManagerState} loadSync Load state from disk synchronously (startup path).
 * @property {() => ManagerState} get Current in-memory state (plain data; callers must not mutate).
 * @property {(patch: Partial<ManagerState>) => Promise<void>} update Merge a patch into the state and persist atomically.
 * @property {(next: unknown) => Promise<void>} replace Replace the whole state (normalized first) and persist atomically.
 * @property {() => Promise<void>} persist Serialized atomic write; failures never poison the chain.
 * @property {string} dir Plugin-owned state directory.
 * @property {string} file Plugin-owned state file path.
 */

// ── RPC / manager_* tool argument contracts ─────────────────────────────────
// These describe the JSON payloads shared by the manager_* tools, the RPC
// route, and the browser half. The host validates them at runtime too (the
// checks are the security boundary for untrusted JSON); these types give the
// two halves a single, checked description of that contract.

/**
 * @typedef {object} SkillsListArgs
 * @property {string | undefined} [sessionId] Prefer the catalog of this session's agent.
 */

/**
 * @typedef {object} GroupCreateArgs
 * @property {string} name Non-empty display name.
 */

/**
 * @typedef {object} GroupIdArgs
 * @property {string} id Stable group id.
 */

/**
 * @typedef {object} GroupRenameArgs
 * @property {string} id Stable group id.
 * @property {string} name New display name.
 */

/**
 * @typedef {object} GroupSetEnabledArgs
 * @property {string} id Stable group id.
 * @property {boolean} enabled New enabled state.
 */

/**
 * @typedef {object} GroupSkillsArgs
 * @property {string} id Stable group id.
 * @property {string} [skill] Legacy single-skill form.
 * @property {string[]} [skills] Batch form (preferred).
 */

/**
 * @typedef {object} SessionGetArgs
 * @property {string} sessionId Session (agent) id.
 */

/**
 * @typedef {object} SessionSetArgs
 * @property {string} sessionId Session (agent) id.
 * @property {string[] | null} enabledGroupIds Explicit ids, or null to follow global.
 */

/**
 * @typedef {object} McpToggleArgs
 * @property {string} id Loader entry id.
 * @property {boolean} enabled New enabled state.
 */

/**
 * @typedef {object} McpAddArgs
 * @property {string} [id] Loader entry id (trimmed by the host).
 * @property {unknown} [serverName]
 * @property {unknown} [transport]
 * @property {unknown} [url]
 * @property {unknown} [command]
 * @property {unknown} [args]
 * @property {unknown} [env]
 * @property {unknown} [cwd]
 * @property {unknown} [headers]
 * @property {unknown} [toolCallTimeoutMs]
 * @property {unknown} [failOnStartupError]
 */

/**
 * @typedef {object} McpProbeArgs
 * @property {string} [id] Probe this loader entry id, or:
 * @property {unknown} [config] probe this unsaved form config.
 */

/**
 * Session state reported by manager.session.get/set.
 *
 * @typedef {object} SessionStateResult
 * @property {{ enabledGroupIds: string[] } | null} override Explicit override (null = follow global).
 * @property {string[]} effectiveGroupIds The ids actually injected this session.
 */

/**
 * Result of `manager.mcp.list`.
 *
 * @typedef {object} McpListResult
 * @property {ServerStatus[]} servers Live servers merged with the patch layer.
 * @property {{ path: string, exists: boolean }} patch Patch file location.
 */

export {};
