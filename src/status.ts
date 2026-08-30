/**
 * Loader/tools status enumeration for MCP server instances.
 *
 * Every MCP server is one `@deepseek-ai/dsh-mcp-client` plugin entry in the
 * loader composition. Its lifecycle phase (mirrored from the Cordis FiberState
 * const enum) plus the number of `mcp__<serverName>__*` tools it currently has
 * registered on the tool registry make up the observable "connection status":
 * a server that successfully connected and synchronized its tool list is
 * `active` with `toolCount > 0`; a disabled entry reports `pending`/`null`; a
 * failing server reports `failed`.
 */
import type { Logger, McpServerConfig, ServerStatus } from './types.ts'

/** The package that implements an MCP server bridge in the harness. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Runtime mirror of the cross-package Cordis FiberState const enum. */
const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

/**
 * The composed loader nests every row under the root include group, so tree
 * entry ids look like `include:<file-id>` (nested groups add more segments).
 * The user patch file addresses rows by their file-level id, so the plugin
 * strips the leading root-group segment for all id comparisons.
 */
export function normalizeEntryId(id: string): string {
  return id.startsWith('include:') ? id.slice('include:'.length) : id
}

/** Complete public projection of the Cordis Fiber states. */
const FIBER_PHASE: Record<number, string | null> = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
}

/**
 * Project a raw fiber state number. A state outside the mirrored enum means
 * the host Cordis version drifted from this mirror — warn and degrade to
 * `null` instead of silently misreporting the phase.
 */
function fiberPhaseOf(state: number, logger: Logger | undefined): string | null {
  const phase = FIBER_PHASE[state]
  if (phase === undefined) {
    logger?.warn?.(`mcp-skill-manager: unknown fiber state ${String(state)}; reporting status as not-loaded`)
    return null
  }
  return phase
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize a raw mcp-client row config into the shared shape. */
export function toServerConfig(raw: unknown): McpServerConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>
  return {
    serverName: typeof cfg.serverName === 'string' ? cfg.serverName : '',
    transport: cfg.transport === 'stdio' ? 'stdio' : 'streamable-http',
    url: typeof cfg.url === 'string' ? cfg.url : undefined,
    command: typeof cfg.command === 'string' ? cfg.command : undefined,
    args: Array.isArray(cfg.args) ? cfg.args : undefined,
    env: isRecord(cfg.env) ? cfg.env as Record<string, string> : undefined,
    cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
    headers: isRecord(cfg.headers) ? cfg.headers as Record<string, string> : undefined,
    toolCallTimeoutMs: typeof cfg.toolCallTimeoutMs === 'number' ? cfg.toolCallTimeoutMs : undefined,
    failOnStartupError: typeof cfg.failOnStartupError === 'boolean' ? cfg.failOnStartupError : undefined,
    reconnect: isRecord(cfg.reconnect) ? cfg.reconnect : undefined,
  }
}

/** Count tools registered on the harness registry under a server namespace. */
export function countServerTools(ctx: HostPluginContext, serverName: string): number {
  if (serverName === '') return 0
  const prefix = `mcp__${serverName}__`
  let count = 0
  for (const schema of ctx.tools.schemas()) {
    if (schema.name !== undefined && schema.name.startsWith(prefix)) count += 1
  }
  return count
}

/** Enumerate every live mcp-client instance with its status projection. */
export function listMcpServers(
  ctx: HostPluginContext,
  userManaged: (id: string) => boolean,
  logger: Logger | undefined,
): ServerStatus[] {
  const servers: ServerStatus[] = []
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    if (entry.options.name !== MCP_CLIENT_PACKAGE) continue
    const config = toServerConfig(entry.options.config)
    const phase = entry.fiber === undefined ? null : fiberPhaseOf(entry.fiber.state, logger)
    const id = normalizeEntryId(entry.id)
    servers.push({
      ...config,
      id,
      enabled: !entry.disabled,
      fiberPhase: phase,
      toolCount: countServerTools(ctx, config.serverName),
      userManaged: userManaged(id),
    })
  }
  return servers
}

/** Whether a serverName is already taken by a live mcp-client instance. */
export function serverNameTaken(ctx: HostPluginContext, serverName: string, exceptId?: string): boolean {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    if (entry.options.name !== MCP_CLIENT_PACKAGE) continue
    // Compare file-level ids (tree ids carry the `include:` root prefix).
    if (exceptId !== undefined && normalizeEntryId(entry.id) === exceptId) continue
    const raw = (entry.options.config ?? {}) as Record<string, unknown>
    if (raw.serverName === serverName) return true
  }
  return false
}

/** Whether a loader entry id is already taken (across all plugins). */
export function entryIdTaken(ctx: HostPluginContext, id: string, exceptId?: string): boolean {
  for (const entry of ctx.loader.entries()) {
    if (normalizeEntryId(entry.id) === id && entry.id !== exceptId) return true
  }
  return false
}