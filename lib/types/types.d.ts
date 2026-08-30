/**
 * Shared type definitions for the dsh-skills-mcp-group-manager plugin.
 *
 * This module is TYPES ONLY: it holds no runtime code. Keeping the shapes
 * here means the host half, the patch editor, and the probe all describe the
 * same contract from a single source of truth.
 */
/** One skill group as persisted in `state.json`. */
export interface SkillGroup {
    /** Stable group id (uuid). */
    id: string;
    /** Display name. */
    name: string;
    /** Global on/off toggle. */
    enabled: boolean;
    /** Member skill names (deduped). */
    skills: string[];
}
/**
 * A session's explicit group selection (per-session override). Absent entry =
 * the session follows the global enabled-group union.
 */
export interface SessionOverride {
    /** Explicit group ids; `[]` injects nothing. */
    enabledGroupIds: string[];
}
/** The manager state persisted to `<harness home>/mcp-skill-manager/state.json`. */
export interface ManagerState {
    /** Skill groups. */
    groups: SkillGroup[];
    /** Per-session overrides keyed by session (agent) id. */
    sessions: Record<string, SessionOverride>;
}
/**
 * An MCP server config as stored in a `cordis.patch.yml` row and passed to
 * probes. Mirrors the `@deepseek-ai/dsh-mcp-client` entry config schema.
 *
 * Optional props are declared `| undefined` so the codebase's
 * assign-undefined-to-drop style stays valid under exactOptionalPropertyTypes.
 */
export interface McpServerConfig {
    /** Unique server name (becomes `mcp__<serverName>__*` tools). */
    serverName: string;
    /** Transport kind. */
    transport: 'stdio' | 'streamable-http';
    /** Endpoint URL (streamable-http only). */
    url?: string | undefined;
    /** Executable command (stdio only). */
    command?: string | undefined;
    /** Command arguments (stdio only). */
    args?: string[] | undefined;
    /** Child env overrides (stdio only). */
    env?: Record<string, string> | undefined;
    /** Child working directory (stdio only). */
    cwd?: string | undefined;
    /** Extra HTTP headers (streamable-http only). */
    headers?: Record<string, string> | undefined;
    /** Per-call timeout override (ms). */
    toolCallTimeoutMs?: number | undefined;
    /** Reject activation when the initial connection fails. */
    failOnStartupError?: boolean | undefined;
    /** Reconnect policy passthrough. */
    reconnect?: Record<string, unknown> | undefined;
}
/** A probe outcome before latency is attached. */
export interface ProbeOk {
    ok: true;
    /** Number of tools the server advertised. */
    toolCount: number;
}
export interface ProbeFail {
    ok: false;
    /** Human-readable failure reason (never thrown). */
    error: string;
}
/** Final probe result: raw outcome plus measured latency. Never throws. */
export type ProbeOutcome = (ProbeOk | ProbeFail) & {
    latencyMs: number;
};
/**
 * The public projection of a live MCP server: its normalized config plus
 * runtime status (loader entry id, enabled flag, fiber phase, tool count).
 */
export interface ServerStatus extends McpServerConfig {
    id: string;
    enabled: boolean;
    fiberPhase: string | null;
    toolCount: number;
    userManaged: boolean;
}
/**
 * A top-level row of the profile `cordis.patch.yml` (cordis-plugin-include
 * dialect). Rows are user-authored YAML, so unknown extra keys are allowed.
 */
export interface PatchEntry {
    /** Loader entry id. */
    id?: string;
    /** Plugin package name. */
    name?: string;
    /** Plugin config (for MCP rows: McpServerConfig). */
    config?: unknown;
    /** Disable override. */
    disabled?: boolean;
}
/**
 * Either a plain override row or an insert row that appends brand-new entries.
 * `insert` is optional (rather than a strict either/or union) so callers can
 * probe `row.insert` with plain `Array.isArray`, and user-authored YAML rows
 * may carry overlapping keys anyway.
 */
export interface PatchRow extends PatchEntry {
    insert?: PatchEntry[];
}
/** Minimal logger contract the modules accept (subset of console). */
export interface Logger {
    warn?(message?: unknown, ...rest: unknown[]): void;
    error?(message?: unknown, ...rest: unknown[]): void;
}
/**
 * The plugin-owned state store returned by createStateStore: a get/update
 * surface over the persisted ManagerState plus load/persist for startup and
 * tooling. `dir`/`file` expose the plugin-owned state location (removed with
 * the plugin on uninstall).
 */
export interface StateStore {
    /** Load state from disk (async variant; kept for tests/tooling). */
    load(): Promise<ManagerState>;
    /** Load state from disk synchronously (startup path). */
    loadSync(): ManagerState;
    /** Current in-memory state (plain data; callers must not mutate). */
    get(): ManagerState;
    /** Merge a patch into the state and persist atomically. */
    update(patch: Partial<ManagerState>): Promise<void>;
    /** Replace the whole state (normalized first) and persist atomically. */
    replace(next: unknown): Promise<void>;
    /** Serialized atomic write; failures never poison the chain. */
    persist(): Promise<void>;
    /** Plugin-owned state directory. */
    dir: string;
    /** Plugin-owned state file path. */
    file: string;
}
export interface SkillsListArgs {
    /** Prefer the catalog of this session's agent. */
    sessionId?: string | undefined;
}
export interface GroupCreateArgs {
    /** Non-empty display name. */
    name: string;
}
export interface GroupIdArgs {
    /** Stable group id. */
    id: string;
}
export interface GroupRenameArgs {
    /** Stable group id. */
    id: string;
    /** New display name. */
    name: string;
}
export interface GroupSetEnabledArgs {
    /** Stable group id. */
    id: string;
    /** New enabled state. */
    enabled: boolean;
}
export interface GroupSkillsArgs {
    /** Stable group id. */
    id: string;
    /** Legacy single-skill form. */
    skill?: string;
    /** Batch form (preferred). */
    skills?: string[];
}
export interface SessionGetArgs {
    /** Session (agent) id. */
    sessionId: string;
}
export interface SessionSetArgs {
    /** Session (agent) id. */
    sessionId: string;
    /** Explicit ids, or null to follow global. */
    enabledGroupIds: string[] | null;
}
export interface McpToggleArgs {
    /** Loader entry id. */
    id: string;
    /** New enabled state. */
    enabled: boolean;
}
/** Untrusted add/update payload; the host validates every field at runtime. */
export interface McpAddArgs {
    /** Loader entry id (trimmed by the host). */
    id?: string;
    serverName?: unknown;
    transport?: unknown;
    url?: unknown;
    command?: unknown;
    args?: unknown;
    env?: unknown;
    cwd?: unknown;
    headers?: unknown;
    toolCallTimeoutMs?: unknown;
    failOnStartupError?: unknown;
}
export interface McpProbeArgs {
    /** Probe this loader entry id, or: */
    id?: string;
    /** Probe this unsaved form config. */
    config?: unknown;
}
/**
 * Session state reported by manager.session.get/set.
 */
export interface SessionStateResult {
    /** Explicit override (null = follow global). */
    override: {
        enabledGroupIds: string[];
    } | null;
    /** The ids actually injected this session. */
    effectiveGroupIds: string[];
}
/** Result of `manager.mcp.list`. */
export interface McpListResult {
    /** Live servers merged with the patch layer. */
    servers: ServerStatus[];
    /** Patch file location. */
    patch: {
        path: string;
        exists: boolean;
    };
}
//# sourceMappingURL=types.d.ts.map