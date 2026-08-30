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
import type { Logger, McpServerConfig, ServerStatus } from './types.ts';
/** The package that implements an MCP server bridge in the harness. */
export declare const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
/**
 * The composed loader nests every row under the root include group, so tree
 * entry ids look like `include:<file-id>` (nested groups add more segments).
 * The user patch file addresses rows by their file-level id, so the plugin
 * strips the leading root-group segment for all id comparisons.
 */
export declare function normalizeEntryId(id: string): string;
/** Normalize a raw mcp-client row config into the shared shape. */
export declare function toServerConfig(raw: unknown): McpServerConfig;
/** Count tools registered on the harness registry under a server namespace. */
export declare function countServerTools(ctx: HostPluginContext, serverName: string): number;
/** Enumerate every live mcp-client instance with its status projection. */
export declare function listMcpServers(ctx: HostPluginContext, userManaged: (id: string) => boolean, logger: Logger | undefined): ServerStatus[];
/** Whether a serverName is already taken by a live mcp-client instance. */
export declare function serverNameTaken(ctx: HostPluginContext, serverName: string, exceptId?: string): boolean;
/** Whether a loader entry id is already taken (across all plugins). */
export declare function entryIdTaken(ctx: HostPluginContext, id: string, exceptId?: string): boolean;
//# sourceMappingURL=status.d.ts.map