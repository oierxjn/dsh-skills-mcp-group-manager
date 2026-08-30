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
export function parameterSchema(spec: Record<string, unknown> | undefined): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const [name, fieldRaw] of Object.entries(spec ?? {})) {
    const field = fieldRaw as Record<string, unknown>
    const { required: isRequired, ...rest } = field
    properties[name] = rest
    if (isRequired) required.push(name)
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/**
 * Convert a compact value spec (required flags inside properties) to raw JSON schema.
 */
export function valueSchema(spec: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (spec === undefined) return undefined
  const convert = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
    const out: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'required' && value === true) continue // hoisted to this level
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        const props: Record<string, unknown> = {}
        for (const [pname, pnode] of Object.entries(value as Record<string, unknown>)) {
          if (pnode !== null && typeof pnode === 'object' && !Array.isArray(pnode)
            && (pnode as Record<string, unknown>).required === true) {
            required.push(pname)
            const { required: _drop, ...rest } = pnode as Record<string, unknown>
            props[pname] = convert(rest)
          } else {
            props[pname] = convert(pnode)
          }
        }
        out.properties = props
      } else if (key === 'items' && typeof value === 'object' && value !== null) {
        out.items = convert(value)
      } else {
        out[key] = value
      }
    }
    if (required.length > 0) out.required = required
    return out
  }
  return convert(spec) as Record<string, unknown>
}

/** Shared output schema of manager_session_get / manager_session_set. */
export const sessionStateOutput: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // The dsh-tools schema subset has no type arrays; nullable is oneOf.
    // oneOf branches pass valueSchema() through untouched, so they are
    // written in final raw-schema form (required as an array).
    override: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabledGroupIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['enabledGroupIds'],
        },
        { type: 'null' },
      ],
      required: true,
    },
    effectiveGroupIds: { type: 'array', required: true, items: { type: 'string' } },
  },
}

/** Shared parameter spec of manager_mcp_add / manager_mcp_update. */
export const mcpConfigParams: Record<string, unknown> = {
  id: { type: 'string', required: true, description: 'Loader entry id (^[A-Za-z0-9_-]{1,64}$); unique across all loader entries.' },
  serverName: { type: 'string', required: true, description: 'Unique server name (^[A-Za-z0-9_-]{1,32}$); tools appear as mcp__<serverName>__*.' },
  transport: { type: 'string', required: true, description: '"stdio" or "streamable-http".' },
  command: { type: 'string', description: 'stdio: executable command.' },
  args: { type: 'array', items: { type: 'string' }, description: 'stdio: command arguments.' },
  env: { type: 'object', additionalProperties: true, description: 'stdio: environment overrides (string values).' },
  cwd: { type: 'string', description: 'stdio: working directory of the child process.' },
  url: { type: 'string', description: 'streamable-http: endpoint URL.' },
  headers: { type: 'object', additionalProperties: true, description: 'streamable-http: extra request headers (string values).' },
  toolCallTimeoutMs: { type: 'number', description: 'Per-callTool timeout in ms (dsh-mcp-client default 60000).' },
  failOnStartupError: { type: 'boolean', description: 'Reject activation when the initial connection/sync fails.' },
}