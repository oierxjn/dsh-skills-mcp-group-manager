/**
 * Live MCP connectivity probe used by the "Test connection" action.
 *
 * A probe opens an independent MCP client connection (never touching the
 * running mcp-client instance for that server), performs `initialize` +
 * `tools/list` under a hard timeout, then closes the transport cleanly. For
 * stdio servers the child process is spawned and killed by the probe itself;
 * for streamable-http it is a short-lived HTTP session.
 *
 * The MCP SDK is imported lazily: a `link:` install has no node_modules next
 * to the plugin source, and a probe must report that as a normal failure
 * instead of killing the whole plugin at import time.
 */
import type { McpServerConfig, ProbeOutcome } from './types.ts';
/**
 * The child's environment for a stdio probe. The MCP SDK uses `env` as the
 * child's FULL environment (it only inherits the host environment when `env`
 * is undefined), and the panel defines `env` as "overrides" — so an empty or
 * missing override map must become `undefined` (inherit), never `{}` (which
 * would strip PATH and make npx-style commands unspawnable).
 */
export declare function stdioEnv(overrides: Record<string, string> | undefined): Record<string, string | undefined> | undefined;
/** Run a connectivity probe against the given server config. */
export declare function probeServer(config: Partial<McpServerConfig>, timeoutMs?: number): Promise<ProbeOutcome>;
//# sourceMappingURL=probe.d.ts.map