/**
 * Pure tool-schema data + converters for the manager_* tool registration.
 *
 * The host half registers its `manager_*` tools (src/index.ts) using a compact
 * spec dialect: parameters are `{ name: { type, required?, description? } }`,
 * and output values mark required fields inline with `required: true`. This
 * module owns the two converters that translate that dialect into the raw
 * JSON-schema objects the shared tools registry expects, plus the two specs
 * shared by more than one tool (the session-state output and the MCP
 * add/update parameter set).
 *
 * Everything here is PURE data / free functions — no closure over ctx, the
 * state store, or the api object — so it is independently unit-testable and
 * keeps src/index.ts focused on orchestration. Each tool's `execute`/`render`
 * halves stay in src/index.ts next to their schema.
 */
/**
 * Convert the compact parameter spec to a raw JSON-schema object root.
 */
export declare function parameterSchema(spec: Record<string, unknown> | undefined): Record<string, unknown>;
/**
 * Convert a compact value spec (required flags inside properties) to raw JSON schema.
 */
export declare function valueSchema(spec: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
/** Shared output schema of manager_session_get / manager_session_set. */
export declare const sessionStateOutput: Record<string, unknown>;
/** Shared parameter spec of manager_mcp_add / manager_mcp_update. */
export declare const mcpConfigParams: Record<string, unknown>;
//# sourceMappingURL=tool-schemas.d.ts.map