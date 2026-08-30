/**
 * Shared structured error for the host half's RPC and tool surfaces.
 *
 * `McpError` carries a stable `code` (e.g. 'invalid-args', 'not-found',
 * 'duplicate-id', 'duplicate-server-name', 'invalid-config') plus an optional
 * field-level map. The RPC layer (lib/index.js) reads `code`/`fields` to build
 * the `{ code, message, fields? }` envelope, and the browser form reads
 * `fields` for inline validation. Every rejection that flows through that
 * surface must throw this (or at least carry a `code`) so callers can tell a
 * caller error (bad args / unknown id) from a real internal failure.
 *
 * Lives in its own dependency-free module so both lib/index.js (the RPC/tool
 * surface) and lib/state.js (pure state logic) share the SAME class without
 * importing each other.
 *
 * @module dsh-skills-mcp-group-manager/errors
 */

/** RPC/tool error carrying a stable code and optional field-level details. */
export class McpError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, string>} [fields]
   */
  constructor(code, message, fields) {
    super(message);
    this.code = code;
    if (fields !== undefined) this.fields = fields;
  }
}
