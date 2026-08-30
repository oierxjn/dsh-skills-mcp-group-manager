/**
 * Shared structured error for the host half's RPC and tool surfaces.
 *
 * `McpError` carries a stable `code` (e.g. 'invalid-args', 'not-found',
 * 'duplicate-id', 'duplicate-server-name', 'invalid-config') plus an optional
 * field-level map. The RPC layer (src/index.ts) reads `code`/`fields` to build
 * the `{ code, message, fields? }` envelope, and the browser form reads
 * `fields` for inline validation. Every rejection that flows through that
 * surface must throw this (or at least carry a `code`) so callers can tell a
 * caller error (bad args / unknown id) from a real internal failure.
 *
 * Lives in its own dependency-free module so both src/index.ts (the RPC/tool
 * surface) and src/state.ts (pure state logic) share the SAME class without
 * importing each other.
 */

/** RPC/tool error carrying a stable code and optional field-level details. */
export class McpError extends Error {
  code: string
  fields?: Record<string, string>

  constructor(code: string, message: string, fields?: Record<string, string>) {
    super(message)
    this.code = code
    if (fields !== undefined) this.fields = fields
  }
}