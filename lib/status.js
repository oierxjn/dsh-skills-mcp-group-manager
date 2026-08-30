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
 *
 * @module dsh-skills-mcp-group-manager/status
 */

/** @typedef {import('./types.js').McpServerConfig} McpServerConfig */
/** @typedef {import('./types.js').ServerStatus} ServerStatus */
/** @typedef {import('./types.js').Logger} Logger */

/** The package that implements an MCP server bridge in the harness. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/** Runtime mirror of the cross-package Cordis FiberState const enum. */
const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
};

/**
 * The composed loader nests every row under the root include group, so tree
 * entry ids look like `include:<file-id>` (nested groups add more segments).
 * The user patch file addresses rows by their file-level id, so the plugin
 * strips the leading root-group segment for all id comparisons.
 * @param {string} id
 * @returns {string}
 */
export function normalizeEntryId(id) {
  return id.startsWith('include:') ? id.slice('include:'.length) : id;
}

/** Complete public projection of the Cordis Fiber states. */
/** @type {Record<number, string | null>} */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
};

/**
 * Project a raw fiber state number. A state outside the mirrored enum means
 * the host Cordis version drifted from this mirror — warn and degrade to
 * `null` instead of silently misreporting the phase.
 * @param {number} state
 * @param {Logger | undefined} logger
 * @returns {string | null}
 */
function fiberPhaseOf(state, logger) {
  const phase = FIBER_PHASE[state];
  if (phase === undefined) {
    logger?.warn?.(`mcp-skill-manager: unknown fiber state ${String(state)}; reporting status as not-loaded`);
    return null;
  }
  return phase;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a raw mcp-client row config into the shared shape.
 * @param {unknown} raw
 * @returns {McpServerConfig}
 */
export function toServerConfig(raw) {
  const cfg = /** @type {Record<string, unknown>} */ (raw ?? {});
  return {
    serverName: typeof cfg.serverName === 'string' ? cfg.serverName : '',
    transport: cfg.transport === 'stdio' ? 'stdio' : 'streamable-http',
    url: typeof cfg.url === 'string' ? cfg.url : undefined,
    command: typeof cfg.command === 'string' ? cfg.command : undefined,
    args: Array.isArray(cfg.args) ? cfg.args : undefined,
    env: /** @type {Record<string, string> | undefined} */ (isRecord(cfg.env) ? cfg.env : undefined),
    cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
    headers: /** @type {Record<string, string> | undefined} */ (isRecord(cfg.headers) ? cfg.headers : undefined),
    toolCallTimeoutMs: typeof cfg.toolCallTimeoutMs === 'number' ? cfg.toolCallTimeoutMs : undefined,
    failOnStartupError: typeof cfg.failOnStartupError === 'boolean' ? cfg.failOnStartupError : undefined,
    reconnect: isRecord(cfg.reconnect) ? cfg.reconnect : undefined,
  };
}

/**
 * Count tools registered on the harness registry under a server namespace.
 * @param {HostPluginContext} ctx
 * @param {string} serverName
 * @returns {number}
 */
export function countServerTools(ctx, serverName) {
  if (serverName === '') return 0;
  const prefix = `mcp__${serverName}__`;
  let count = 0;
  for (const schema of ctx.tools.schemas()) {
    if (schema.name !== undefined && schema.name.startsWith(prefix)) count += 1;
  }
  return count;
}

/**
 * Enumerate every live mcp-client instance with its status projection.
 * @param {HostPluginContext} ctx
 * @param {(id: string) => boolean} userManaged
 * @param {Logger | undefined} logger
 * @returns {ServerStatus[]}
 */
export function listMcpServers(ctx, userManaged, logger) {
  /** @type {ServerStatus[]} */
  const servers = [];
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue;
    if (entry.options.name !== MCP_CLIENT_PACKAGE) continue;
    const config = toServerConfig(entry.options.config);
    const phase = entry.fiber === undefined ? null : fiberPhaseOf(entry.fiber.state, logger);
    const id = normalizeEntryId(entry.id);
    servers.push({
      ...config,
      id,
      enabled: !entry.disabled,
      fiberPhase: phase,
      toolCount: countServerTools(ctx, config.serverName),
      userManaged: userManaged(id),
    });
  }
  return servers;
}

/**
 * Whether a serverName is already taken by a live mcp-client instance.
 * @param {HostPluginContext} ctx
 * @param {string} serverName
 * @param {string} [exceptId]
 * @returns {boolean}
 */
export function serverNameTaken(ctx, serverName, exceptId) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue;
    if (entry.options.name !== MCP_CLIENT_PACKAGE) continue;
    // Compare file-level ids (tree ids carry the `include:` root prefix).
    if (exceptId !== undefined && normalizeEntryId(entry.id) === exceptId) continue;
    const raw = /** @type {Record<string, unknown>} */ (entry.options.config ?? {});
    if (raw.serverName === serverName) return true;
  }
  return false;
}

/**
 * Whether a loader entry id is already taken (across all plugins).
 * @param {HostPluginContext} ctx
 * @param {string} id
 * @param {string} [exceptId]
 * @returns {boolean}
 */
export function entryIdTaken(ctx, id, exceptId) {
  for (const entry of ctx.loader.entries()) {
    if (normalizeEntryId(entry.id) === id && entry.id !== exceptId) return true;
  }
  return false;
}
