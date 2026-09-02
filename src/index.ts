/**
 * dsh-mcp-skill-manager — host half.
 *
 * A bundle plugin (installed via `dsh plugin --profile <p> add <path>`; the
 * cordis.patch.yml row mounts it into the host composition). It provides:
 *
 *  1. State model & persistence — a plugin-owned state file
 *     (`<harness home>/mcp-skill-manager/state.json`, atomic write; the
 *     directory is removed together with the plugin via the package's
 *     `postuninstall` script). State: skill groups (id/name/enabled/skills)
 *     plus per-session overrides (`sessions[sessionId].enabledGroupIds`;
 *     absent = follow the global enabled-group union, agent.id === sessionId).
 *     MCP servers are NOT in this file — see (3).
 *  2. Skill-catalog filtering — a per-agent shadow skill provider
 *     (`skill-manager-filter`) registered on `agent.ctx` at `agent/created`.
 *     Its list() returns the FULL global catalog with the invocation of
 *     skills outside the session's enabled set (override ?? global union)
 *     rewritten to
 *     { modelInvocable: false, userInvocable: false }; the registry merges by
 *     skill name with the nearest layer winning, so disabled skills are
 *     removed from the model catalog and the `skill` tool refuses them.
 *  3. MCP management — the profile's `cordis.patch.yml` is the single source
 *     of truth. Servers are enumerated from live loader entries
 *     (`@deepseek-ai/dsh-mcp-client` rows) merged with the patch layer;
 *     enable/disable/add/edit/remove edit the patch file and the harness HMR
 *     watcher hot-reloads the tree (real start/stop, no restart). An
 *     on-demand connectivity probe opens an independent MCP client
 *     (`initialize` + `tools/list`) against any entry or unsaved form config.
 *  4. The 15 `manager_*` tools in the shared tools registry.
 *  5. The RPC surface for the browser half. NOTE: `harness.handle`/`host.call`
 *     exist only for sandboxed dynamic plugins; a bundle plugin exposes JSON
 *     methods over the web server instead. The method names are served as a
 *     single POST route `/plugins/@jkljkluiouio/dsh-skills-mcp-group-manager/rpc` with body
 *     { method, args } → { ok, value } | { ok: false, error }. The error is
 *     structured: { code, message, fields? } where `fields` carries
 *     field-level validation messages for the form to display inline.
 *
 * Lifecycle: every side effect is fiber-scoped or explicitly disposed
 * (store writes, tools.register, skills.registerProvider, webServer
 * routes, ctx.on listeners). No live data is ever serialized: only scalar
 * fields are extracted into fresh JSON.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { McpError } from './errors.ts'
import { mcpConfigParams, parameterSchema, sessionStateOutput, valueSchema } from './tool-schemas.ts'
import {
  addSkillsToGroup,
  enabledSkillNamesFor,
  groupById,
  pickServerConfig,
  removeSkillsFromGroup,
  snapshotState,
  validateMcpConfig,
} from './state.ts'
import { createStateStore } from './store.ts'
import {
  addMcpRow,
  editPatchList,
  isUserManaged,
  patchEntryName,
  readPatchList,
  removeMcpRow,
  resolvePatchPath,
  setMcpEnabled,
  updateMcpConfig,
} from './patch.ts'
import {
  entryIdTaken,
  listMcpServers,
  MCP_CLIENT_PACKAGE,
  normalizeEntryId,
  serverNameTaken,
  toServerConfig,
} from './status.ts'
import { probeServer } from './probe.ts'
import type {
  GroupCreateArgs,
  GroupIdArgs,
  GroupRenameArgs,
  GroupSetEnabledArgs,
  GroupSkillsArgs,
  ManagerState,
  McpAddArgs,
  McpListResult,
  McpProbeArgs,
  McpServerConfig,
  McpToggleArgs,
  SessionGetArgs,
  SessionSetArgs,
  SessionStateResult,
  SkillGroup,
  SkillsListArgs,
} from './types.ts'

export const name = 'mcp-skill-manager'
export const inject = ['skills', 'tools', 'agents', 'loader']

/** Unique shadow provider name; the registry merges by skill name, not provider name. */
const SHADOW_PROVIDER_NAME = 'skill-manager-filter'
/** Re-entrancy marker for the shadow provider's nested catalog pass. */
const catalogReentry = new AsyncLocalStorage<unknown>()
/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
/** Base path of the browser-half RPC route. */
const RPC_PATH = '/plugins/@jkljkluiouio/dsh-skills-mcp-group-manager/rpc'
/** Max RPC request body bytes. */
const MAX_RPC_BODY_BYTES = 64 * 1024

/**
 * Host half plugin.
 *
 * MUST stay synchronous: Cordis treats a prototype-bearing function as a
 * constructor and ignores its returned promise, so an async apply would
 * turn any post-await throw into an unhandled rejection that crashes the
 * whole dsh process (observed as the service crash-restart "flicker").
 */
export function apply(ctx: HostPluginContext, config: { patchFile?: unknown; profile?: unknown } = {}): void {
  // ── 1) state model & persistence ─────────────────────────────────────────
  // Plugin-owned state file (NOT settings.yaml): `<harness home>/
  // mcp-skill-manager/state.json`, removed on uninstall via postuninstall.
  const store = createStateStore({ dshHome: process.env.DSH_HOME, logger: ctx.logger })
  store.loadSync()

  // The MCP single source of truth: the profile's cordis.patch.yml.
  const patchFile = resolvePatchPath(config)

  // Per-apply runtime bookkeeping (all plain data, no live objects).
  // agent.id -> { control, dispose } of the shadow provider registration.
  const shadowControls = new Map<string, { control: SkillProviderControl; dispose: () => void }>()
  // Serializes read-modify-write cycles so concurrent calls never interleave.
  let writeChain: Promise<unknown> = Promise.resolve()

  // ── 2) skill-catalog filtering ──────────────────────────────────────────
  function applyAgentFilter(agent: AgentEntry): void {
    if (shadowControls.has(agent.id)) return
    // IMPORTANT: use agent.ctx.get('skills') — NOT agent.ctx.skills. In the
    // running process the agent ctx's inject map lacks 'skills', so the
    // property access throws the Cordis Guard error ("cannot get property
    // skills without inject") and crashes the plugin tree at boot when
    // sessions are restored; get() resolves the service directly.
    const skills = agent.ctx.get('skills') as SkillRegistry | undefined
    if (skills === undefined) return
    let controlRef: SkillProviderControl | undefined
    const dispose = skills.registerProvider((control) => {
      controlRef = control // factory runs synchronously; captured for invalidate()
      return {
        name: SHADOW_PROVIDER_NAME,
        async list(options) {
          // List through the requesting scope; a re-entrant call (our own
          // nested collect) yields [] so the lower layers (preset standing
          // scope) win and the nested pass resolves the unfiltered catalog.
          // Disabled skills get a double-false invocation so dsh-tool-skill's
          // isModelInvocable filter drops them and the `skill` tool refuses
          // to load them.
          if (catalogReentry.getStore() !== undefined) return []
          const all = await catalogReentry.run({}, () =>
            ctx.skills.list({ cwd: options.cwd, signal: options.signal, scope: options.scope }))
          // Per-session selection: this agent's session override when present,
          // otherwise the global enabled-group union.
          const enabled = enabledSkillNamesFor(store.get(), agent.id)
          return all.map((skill) => ({
            name: skill.name,
            description: skill.description,
            ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
            invocation: enabled.has(skill.name)
              ? skill.invocation
              : { modelInvocable: false, userInvocable: false },
            source: skill.source,
            provider: SHADOW_PROVIDER_NAME, // must equal this provider's name
            ...(skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {}),
            rank: 0, // sole provider in this layer
            locator: skill.name, // opaque handle, passed back to get()
          }))
        },
        async get(candidate, options) {
          // Delegate body loading through the requesting scope: the re-entrant
          // guard makes the nested collect's agent layer empty, so the winning
          // candidate resolves to the real filesystem provider's entry and its
          // locator loads the true body.
          //
          // CRITICAL: the registry's collect cache is keyed by
          // {cwd, scopeChain, revision} ONLY (dsh-skill/lib/index.js
          // collectCacheKey) — it does NOT know about our re-entry state. A
          // nested ctx.skills.get() with the same view would HIT the cache
          // populated by the outer collect, which still holds THIS provider's
          // winning candidates; the nested get() would dispatch back to this
          // provider, whose re-entry guard returns undefined, and the `skill`
          // tool would fail with "unknown or no longer available" for EVERY
          // enabled skill. Invalidate before delegating so the nested collect
          // actually re-runs collectFresh (guard active → the real filesystem
          // provider wins), and invalidate again afterwards so the nested
          // UNFILTERED result cannot poison later list()/get() reads (it
          // would otherwise resurrect disabled skills into the catalog).
          if (catalogReentry.getStore() !== undefined) return undefined
          controlRef?.invalidate()
          try {
            return await catalogReentry.run({}, () =>
              ctx.skills.get(candidate.name, { cwd: options.cwd, signal: options.signal, scope: options.scope }))
          } finally {
            controlRef?.invalidate()
          }
        },
      }
    })
    // The factory ran synchronously, so controlRef is set by now (the type
    // system cannot see the side effect — the cast documents the guarantee).
    shadowControls.set(agent.id, {
      control: controlRef as SkillProviderControl,
      dispose,
    })
  }

  function refreshSkillCatalogs(): void {
    for (const { control } of shadowControls.values()) control.invalidate()
  }

  /**
   * Pick the agent whose skill catalog the browser picker should display.
   * Prefers the requested session id; falls back to the first live agent.
   * Returns undefined when no live agent exists.
   */
  function resolveCatalogAgent(sessionId: string | undefined): AgentEntry | undefined {
    let agents: AgentEntry[]
    try { agents = ctx.agents.list() } catch { return undefined }
    if (!Array.isArray(agents) || agents.length === 0) return undefined
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const found = agents.find((agent) => agent.id === sessionId)
      if (found !== undefined) return found
    }
    return agents[0]
  }

  /**
   * Invalidate ONLY the catalog of the agent whose id equals the session id
   * (agent.id === sessionId). A session-override change affects exactly that
   * session; other agents keep their catalogs untouched. A session without a
   * live agent needs no invalidation — its override is read on first list().
   */
  function refreshSkillCatalogFor(sessionId: string): void {
    shadowControls.get(sessionId)?.control.invalidate()
  }

  // ── 3) shared business logic (tools + RPC) ───────────────────────────────
  /** Serialize one read-modify-write cycle; failures never poison the chain. */
  function withWriteLock<T>(task: () => T | Promise<T>): Promise<T> {
    const run = writeChain.then(task, task)
    writeChain = run.catch(() => {})
    return run
  }

  /** Re-apply every dynamic effect after a state change. */
  function applyStateEffects(): void {
    refreshSkillCatalogs()
  }

  function requireGroup(state: ManagerState, id: string): SkillGroup {
    const group = groupById(state, id)
    if (group === undefined) throw new McpError('not-found', `group "${id}" does not exist`)
    return group
  }

  /** Validate an add/update payload; throws McpError with field details. */
  function requireValidServer(id: string, config: Partial<McpServerConfig>): void {
    const fields = validateMcpConfig(id, config)
    if (Object.keys(fields).length > 0) {
      throw new McpError('invalid-config', 'Invalid MCP server configuration', fields)
    }
  }

  /**
   * The mutation target must be an MCP client entry. The id alone is not
   * proof: removeMcpRow drops ANY patch row carrying the id (including rows
   * of other plugins), and setMcpEnabled/updateMcpConfig append an override
   * row for unknown ids. Accept an id only when it names a live
   * `dsh-mcp-client` loader entry, or — covering the HMR lag window, where a
   * just-written patch row is not yet in the loader tree — a patch row whose
   * recorded plugin name is `dsh-mcp-client`.
   */
  async function requireMcpTarget(id: string): Promise<void> {
    for (const entry of ctx.loader.entries()) {
      if (entry.options.group) continue
      if (entry.options.name !== MCP_CLIENT_PACKAGE) continue
      if (normalizeEntryId(entry.id) === id) return
    }
    const rows = await readPatchList(patchFile)
    if (patchEntryName(rows, id) === MCP_CLIENT_PACKAGE) return
    throw new McpError('not-found', `No MCP server entry with id "${id}"`)
  }

  const api = {
    async stateGet(): Promise<ManagerState> {
      return snapshotState(store.get())
    },
    /**
     * The browser half has no per-session context; when a live agent exists,
     * list through its scope so the shadow provider's catalog (the union of
     * the global and preset layers) is what the picker displays. Without a
     * live agent the global layer is listed as-is (empty when the host skill
     * discovery is disabled by a patch row).
     */
    async skillsList(args?: SkillsListArgs) {
      const agent = resolveCatalogAgent(args?.sessionId)
      const all = agent === undefined
        ? await ctx.skills.list()
        : await ctx.skills.list({ cwd: agent.session?.header?.cwd, scope: agent })
      return {
        skills: all.map((skill) => ({
          name: skill.name,
          description: skill.description,
          // The catalog guarantees an invocation policy; the cast preserves
          // the original throw-on-missing runtime behavior.
          invocation: {
            modelInvocable: (skill.invocation as { modelInvocable: boolean; userInvocable: boolean }).modelInvocable,
            userInvocable: (skill.invocation as { modelInvocable: boolean; userInvocable: boolean }).userInvocable,
          },
        })),
      }
    },
    async groupsCreate(args?: GroupCreateArgs) {
      const nameArg = typeof args?.name === 'string' ? args.name.trim() : ''
      if (nameArg.length === 0) throw new McpError('invalid-args', 'group name must be a non-empty string')
      const id = randomUUID()
      await withWriteLock(async () => {
        const state = store.get()
        await store.update({ groups: [...state.groups, { id, name: nameArg, enabled: true, skills: [] }] })
        applyStateEffects()
      })
      return { id }
    },
    async groupsRename(args?: GroupRenameArgs) {
      const { id } = args ?? {}
      const nameArg = typeof args?.name === 'string' ? args.name.trim() : ''
      if (typeof id !== 'string' || nameArg.length === 0) throw new McpError('invalid-args', 'rename requires { id, name }')
      await withWriteLock(async () => {
        const state = store.get()
        requireGroup(state, id)
        await store.update({
          groups: state.groups.map((group) => (group.id === id ? { ...group, name: nameArg } : group)),
        })
        applyStateEffects()
      })
      return { id, name: nameArg }
    },
    async groupsDelete(args?: GroupIdArgs) {
      const { id } = args ?? {}
      if (typeof id !== 'string') throw new McpError('invalid-args', 'delete requires { id }')
      await withWriteLock(async () => {
        const state = store.get()
        requireGroup(state, id)
        await store.update({ groups: state.groups.filter((group) => group.id !== id) })
        applyStateEffects()
      })
      return { id }
    },
    async groupsSetEnabled(args?: GroupSetEnabledArgs) {
      const { id, enabled } = args ?? {}
      if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new McpError('invalid-args', 'setEnabled requires { id, enabled: boolean }')
      await withWriteLock(async () => {
        const state = store.get()
        requireGroup(state, id)
        await store.update({
          groups: state.groups.map((group) => (group.id === id ? { ...group, enabled } : group)),
        })
        applyStateEffects()
      })
      return { id, enabled }
    },
    async groupsAddSkill(args?: GroupSkillsArgs) {
      const { id } = args ?? {}
      const names = Array.isArray(args?.skills)
        ? args.skills.filter((s) => typeof s === 'string' && s.length > 0)
        : typeof args?.skill === 'string' && args.skill.length > 0
          ? [args.skill]
          : []
      if (typeof id !== 'string' || names.length === 0) {
        throw new McpError('invalid-args', 'addSkill requires { id, skill } or { id, skills: [...] }')
      }
      // Batch: ONE write + ONE catalog invalidation for N names (the client
      // used to send one RPC per skill, which was slow over HTTP). Echo the
      // post-operation membership so the tool output schema has a real payload.
      const skills = await withWriteLock(async () => {
        const next = addSkillsToGroup(store.get(), id, names)
        if (next !== store.get()) {
          await store.update({ groups: next.groups })
          applyStateEffects()
        }
        return requireGroup(store.get(), id).skills
      })
      return { id, skills: [...skills] }
    },
    async groupsRemoveSkill(args?: GroupSkillsArgs) {
      const { id } = args ?? {}
      const names = Array.isArray(args?.skills)
        ? args.skills.filter((s) => typeof s === 'string' && s.length > 0)
        : typeof args?.skill === 'string' && args.skill.length > 0
          ? [args.skill]
          : []
      if (typeof id !== 'string' || names.length === 0) {
        throw new McpError('invalid-args', 'removeSkill requires { id, skill } or { id, skills: [...] }')
      }
      const skills = await withWriteLock(async () => {
        const next = removeSkillsFromGroup(store.get(), id, names)
        if (next !== store.get()) {
          await store.update({ groups: next.groups })
          applyStateEffects()
        }
        return requireGroup(store.get(), id).skills
      })
      return { id, skills: [...skills] }
    },
    // ── Per-session group selection ───────────────────────────────────────
    // state.sessions[sessionId] is that session's explicit override; absent =
    // follow the global enabled-group union (agent.id === sessionId).
    async sessionGet(args?: SessionGetArgs): Promise<SessionStateResult> {
      const { sessionId } = args ?? {}
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new McpError('invalid-args', 'session.get requires { sessionId }')
      }
      const state = store.get()
      const known = new Set(state.groups.map((group) => group.id))
      const entry = state.sessions[sessionId]
      // Deleted group ids are filtered out of the reported override, matching
      // the read-side filtering of enabledSkillNamesFor.
      const override = entry === undefined
        ? null
        : { enabledGroupIds: entry.enabledGroupIds.filter((id) => known.has(id)) }
      return {
        override,
        effectiveGroupIds: override?.enabledGroupIds
          ?? state.groups.filter((group) => group.enabled).map((group) => group.id),
      }
    },
    async sessionSet(args?: SessionSetArgs) {
      const { sessionId, enabledGroupIds } = args ?? {}
      if (typeof sessionId !== 'string' || sessionId.length === 0
        || (enabledGroupIds !== null
          && (!Array.isArray(enabledGroupIds) || enabledGroupIds.some((id) => typeof id !== 'string')))) {
        throw new McpError('invalid-args', 'session.set requires { sessionId, enabledGroupIds: string[] | null }')
      }
      await withWriteLock(async () => {
        const state = store.get()
        if (enabledGroupIds !== null) {
          for (const id of enabledGroupIds) {
            if (groupById(state, id) === undefined) {
              throw new McpError('not-found', `group "${id}" does not exist`)
            }
          }
        }
        const sessions = { ...state.sessions }
        if (enabledGroupIds === null) delete sessions[sessionId]
        else sessions[sessionId] = { enabledGroupIds: [...new Set(enabledGroupIds)] }
        await store.update({ sessions })
        // Only this session's catalog changes; a global refresh would churn
        // every other agent's catalog for no reason.
        refreshSkillCatalogFor(sessionId)
      })
      return api.sessionGet({ sessionId })
    },
    // ── MCP: every mutation is a cordis.patch.yml edit; the harness HMR
    // watcher hot-reloads the loader tree, so changes apply live. ──────────
    async mcpList(): Promise<McpListResult> {
      const rows = await readPatchList(patchFile)
      return {
        servers: listMcpServers(ctx, (id) => isUserManaged(rows, id), ctx.logger),
        patch: { path: patchFile, exists: existsSync(patchFile) },
      }
    },
    async mcpToggle(args?: McpToggleArgs) {
      const { id, enabled } = args ?? {}
      if (typeof id !== 'string' || typeof enabled !== 'boolean') {
        throw new McpError('invalid-args', 'toggle requires { id, enabled: boolean }')
      }
      // Bundle-defined entries get an override row appended (the patch layer
      // later in the stack wins); patch-defined entries flip their own flag.
      await withWriteLock(async () => {
        await requireMcpTarget(id)
        await editPatchList(patchFile, (rows) => setMcpEnabled(rows, id, enabled))
      })
      return { id, enabled }
    },
    async mcpAdd(args?: McpAddArgs) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      const config = pickServerConfig((args ?? {}) as Record<string, unknown>)
      requireValidServer(id, config)
      await withWriteLock(async () => {
        if (entryIdTaken(ctx, id)) {
          throw new McpError('duplicate-id', `Entry id "${id}" is already in use`)
        }
        // HMR lag: an id added moments ago is in the patch but not yet in the
        // loader tree, so the patch itself is the authoritative dedup source.
        const rows = await readPatchList(patchFile)
        if (isUserManaged(rows, id)) {
          throw new McpError('duplicate-id', `Entry id "${id}" is already in use`)
        }
        // requireValidServer above guarantees serverName is a present string.
        if (serverNameTaken(ctx, config.serverName as string)) {
          throw new McpError('duplicate-server-name', `serverName "${config.serverName}" is already used by another MCP server`)
        }
        await editPatchList(patchFile, (current) => addMcpRow(current, id, config as McpServerConfig))
      })
      return { id }
    },
    async mcpUpdate(args?: McpAddArgs) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      const config = pickServerConfig((args ?? {}) as Record<string, unknown>)
      requireValidServer(id, config)
      await withWriteLock(async () => {
        // An unknown id must fail, not silently append an override row for an
        // entry that will never exist (bundle entries live in the loader and
        // are matched there; patch rows are matched with their plugin name).
        await requireMcpTarget(id)
        // requireValidServer above guarantees serverName is a present string.
        if (serverNameTaken(ctx, config.serverName as string, id)) {
          throw new McpError('duplicate-server-name', `serverName "${config.serverName}" is already used by another MCP server`)
        }
        await editPatchList(patchFile, (rows) => updateMcpConfig(rows, id, config as McpServerConfig))
      })
      return { id }
    },
    async mcpRemove(args?: GroupIdArgs) {
      const { id } = args ?? {}
      if (typeof id !== 'string') throw new McpError('invalid-args', 'remove requires { id }')
      await withWriteLock(async () => {
        // removeMcpRow drops EVERY patch row carrying the id regardless of
        // plugin; the target check keeps a foreign plugin's row unremovable.
        await requireMcpTarget(id)
        await editPatchList(patchFile, (rows) => removeMcpRow(rows, id))
      })
      return { id }
    },
    async mcpProbe(args?: McpProbeArgs) {
      let config: McpServerConfig | undefined
      if (args?.config !== null && typeof args?.config === 'object') {
        // Unsaved form config: normalize and probe as-is (the probe itself
        // reports connection/config failures; it never throws).
        config = pickServerConfig(args.config as Record<string, unknown>) as McpServerConfig
      } else {
        const id = typeof args?.id === 'string' ? args.id : ''
        for (const entry of ctx.loader.entries()) {
          if (entry.options.group) continue
          if (entry.options.name !== MCP_CLIENT_PACKAGE) continue
          if (normalizeEntryId(entry.id) === id) {
            config = toServerConfig(entry.options.config)
            break
          }
        }
        if (config === undefined) {
          throw new McpError('not-found', `No MCP server entry with id "${id}"`)
        }
      }
      return probeServer(config)
    },
  }

  // ── 4) manager_* tools (shared registry) ────────────────────────────────
  // The compact parameter/value specs are converted to raw JSON schema by
  // src/tool-schemas.ts (pure, closure-free). Runtime dependencies (js-yaml,
  // the MCP SDK) are lazy-loaded by src/patch.ts and src/probe.ts, so
  // registering tools never requires them.

  const toolDisposers: Array<() => void> = []
  const tool = (definition: ToolDefinitionInput): void => {
    toolDisposers.push(ctx.tools.register({
      ...definition,
      parameters: parameterSchema(definition.parameters),
      ...(definition.output !== undefined
        ? { output: { ...definition.output, schema: valueSchema(definition.output.schema) } }
        : {}),
    }))
  }

  tool({
    name: 'manager_groups_list',
    description: 'List every skill group with its enabled flag and member skill names.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                skills: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      // Return only the groups half: the output schema declares just
      // `groups`, and MCP server data is exposed via manager_mcp_list.
      const state = await api.stateGet()
      return { groups: state.groups }
    },
  })

  tool({
    name: 'manager_groups_create',
    description: 'Create a new skill group (enabled by default, empty member list). Returns the stable group id.',
    parameters: {
      name: { type: 'string', required: true, description: 'Display name of the new group.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true } },
      },
      render: (args, value) => [{ type: 'text', text: `Group "${args.name}" created (id ${(value as { id: string }).id}).` }],
    },
    async execute(args) {
      return api.groupsCreate(args as unknown as GroupCreateArgs)
    },
  })

  tool({
    name: 'manager_groups_delete',
    description: 'Delete a skill group by id. Its skills are not removed from other groups.',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable group id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `Group ${args.id} deleted.` }],
    },
    async execute(args) {
      return api.groupsDelete(args as unknown as GroupIdArgs)
    },
  })

  tool({
    name: 'manager_groups_rename',
    description: 'Rename a skill group by id.',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable group id.' },
      name: { type: 'string', required: true, description: 'New display name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `Group ${args.id} renamed to "${args.name}".` }],
    },
    async execute(args) {
      return api.groupsRename(args as unknown as GroupRenameArgs)
    },
  })

  tool({
    name: 'manager_groups_set_enabled',
    description: 'Enable or disable a skill group. Disabling removes its skills from the injected catalog; enabling re-injects them (union-deduped across enabled groups).',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable group id.' },
      enabled: { type: 'boolean', required: true, description: 'New enabled state.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `Group ${args.id} ${args.enabled ? 'enabled' : 'disabled'}.` }],
    },
    async execute(args) {
      return api.groupsSetEnabled(args as unknown as GroupSetEnabledArgs)
    },
  })

  tool({
    name: 'manager_groups_add_skill',
    description: 'Add a skill name to a group. The same skill may exist in several groups; injection dedups by union.',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable group id.' },
      skill: { type: 'string', required: true, description: 'Skill name (kebab-case) to add.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          skills: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      // The batch form ({ id, skills: [...] }) has no args.skill, so render
      // from the echoed payload (post-operation membership) instead of args.
      render: (args, value) => [{ type: 'text', text: `Group ${args.id} now has skills: ${(value as { skills: string[] }).skills.join(', ')}.` }],
    },
    async execute(args) {
      return api.groupsAddSkill(args as unknown as GroupSkillsArgs)
    },
  })

  tool({
    name: 'manager_groups_remove_skill',
    description: 'Remove a skill name from a group.',
    parameters: {
      id: { type: 'string', required: true, description: 'Stable group id.' },
      skill: { type: 'string', required: true, description: 'Skill name to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          skills: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (args, value) => [{ type: 'text', text: `Group ${args.id} now has skills: ${(value as { skills: string[] }).skills.join(', ')}.` }],
    },
    async execute(args) {
      return api.groupsRemoveSkill(args as unknown as GroupSkillsArgs)
    },
  })

  tool({
    name: 'manager_skills_list',
    description: 'List every skill currently available in the global catalog (name, description, invocation policy) for picking group members.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skills: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                invocation: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    modelInvocable: { type: 'boolean', required: true },
                    userInvocable: { type: 'boolean', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      return api.skillsList({ sessionId: exec?.agent?.id })
    },
  })

  /**
   * Resolve the calling session id from the tool execution context. Both
   * session tools are scoped to the caller's own session (exec.agent.id);
   * without an agent context there is no session to read or write.
   */
  function requireSessionId(exec: ToolExecContext | undefined): string {
    const sessionId = exec?.agent?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('session tools require the calling agent context (exec.agent.id)')
    }
    return sessionId
  }

  tool({
    name: 'manager_session_get',
    description: 'Show this session\'s skill-group selection: the explicit per-session override (null = following the global group toggles) and the effective enabled group ids.',
    parameters: {},
    output: {
      schema: sessionStateOutput,
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      return api.sessionGet({ sessionId: requireSessionId(exec) })
    },
  })

  tool({
    name: 'manager_session_set',
    description: 'Set this session\'s skill-group selection: enabledGroupIds lists the groups injected into THIS session only (empty array = inject none); pass null to follow the global group toggles again. Other sessions are unaffected.',
    parameters: {
      enabledGroupIds: {
        oneOf: [
          { type: 'array', items: { type: 'string' } },
          { type: 'null' },
        ],
        required: true,
        description: 'Group ids enabled for this session, or null to follow the global toggles.',
      },
    },
    output: {
      schema: sessionStateOutput,
      render: (args, value) => {
        const state = value as SessionStateResult
        return [{
          type: 'text',
          text: state.override === null
            ? 'This session follows the global group toggles.'
            : `This session enables groups: ${state.override.enabledGroupIds.join(', ') || '(none)'}.`,
        }]
      },
    },
    async execute(args, exec) {
      return api.sessionSet({
        sessionId: requireSessionId(exec),
        enabledGroupIds: args.enabledGroupIds as string[] | null,
      })
    },
  })

  tool({
    name: 'manager_mcp_list',
    description: 'List every MCP server (loader composition merged with the user patch layer) with entry id, enabled flag, fiber phase, live tool count, and whether it is user-managed. The single source of truth is the profile cordis.patch.yml.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          servers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                serverName: { type: 'string', required: true },
                transport: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                fiberPhase: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                toolCount: { type: 'number', required: true },
                userManaged: { type: 'boolean', required: true },
              },
            },
          },
          patch: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              exists: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return api.mcpList()
    },
  })

  tool({
    name: 'manager_mcp_toggle',
    description: 'Enable or disable an MCP server by editing the profile cordis.patch.yml; the harness hot-reloads the tree, so the server really starts/stops. Bundle-defined servers get an {id, name, disabled} override row appended.',
    parameters: {
      id: { type: 'string', required: true, description: 'Loader entry id of the MCP server.' },
      enabled: { type: 'boolean', required: true, description: 'New enabled state.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `MCP server "${args.id}" ${args.enabled ? 'enabled' : 'disabled'}.` }],
    },
    async execute(args) {
      return api.mcpToggle(args as unknown as McpToggleArgs)
    },
  })

  tool({
    name: 'manager_mcp_add',
    description: 'Add a new MCP server by appending an insert row to the profile cordis.patch.yml; the harness hot-reloads and connects the server. stdio needs command; streamable-http needs url.',
    parameters: mcpConfigParams,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `MCP server "${args.id}" added.` }],
    },
    async execute(args) {
      return api.mcpAdd(args as McpAddArgs)
    },
  })

  tool({
    name: 'manager_mcp_update',
    description: 'Replace the config of an existing MCP server entry (patch-file edit, hot-reloaded). Bundle-defined entries get a config override row appended.',
    parameters: mcpConfigParams,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `MCP server "${args.id}" updated.` }],
    },
    async execute(args) {
      return api.mcpUpdate(args as McpAddArgs)
    },
  })

  tool({
    name: 'manager_mcp_remove',
    description: 'Remove every patch-file trace of an MCP server entry (insert rows and disable/config overrides); the harness hot-reloads and disconnects it.',
    parameters: {
      id: { type: 'string', required: true, description: 'Loader entry id of the MCP server.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `MCP server "${args.id}" removed.` }],
    },
    async execute(args) {
      return api.mcpRemove(args as unknown as GroupIdArgs)
    },
  })

  // ── 5) RPC surface for the browser half ─────────────────────────────────
  // Bundle plugins have no `harness.handle`/`host.call` (those exist only for
  // sandboxed dynamic plugins); the browser half calls the same business
  // logic over one JSON POST route. The probe is RPC-only (not a tool): it is
  // an operator diagnostic, not something the model should trigger.
  const rpcMethods: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    'manager.state.get': async () => api.stateGet(),
    'manager.skills.list': async (args) => api.skillsList(args as SkillsListArgs),
    'manager.groups.create': async (args) => api.groupsCreate(args as unknown as GroupCreateArgs),
    'manager.groups.rename': async (args) => api.groupsRename(args as unknown as GroupRenameArgs),
    'manager.groups.delete': async (args) => api.groupsDelete(args as unknown as GroupIdArgs),
    'manager.groups.setEnabled': async (args) => api.groupsSetEnabled(args as unknown as GroupSetEnabledArgs),
    'manager.groups.addSkill': async (args) => api.groupsAddSkill(args as unknown as GroupSkillsArgs),
    'manager.groups.removeSkill': async (args) => api.groupsRemoveSkill(args as unknown as GroupSkillsArgs),
    'manager.session.get': async (args) => api.sessionGet(args as unknown as SessionGetArgs),
    'manager.session.set': async (args) => api.sessionSet(args as unknown as SessionSetArgs),
    'manager.mcp.list': async () => api.mcpList(),
    'manager.mcp.toggle': async (args) => api.mcpToggle(args as unknown as McpToggleArgs),
    'manager.mcp.add': async (args) => api.mcpAdd(args as McpAddArgs),
    'manager.mcp.update': async (args) => api.mcpUpdate(args as McpAddArgs),
    'manager.mcp.remove': async (args) => api.mcpRemove(args as unknown as GroupIdArgs),
    'manager.mcp.probe': async (args) => api.mcpProbe(args as McpProbeArgs),
  }

  async function readJsonBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of req) {
      received += chunk.byteLength
      if (received > MAX_RPC_BODY_BYTES) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  }

  function sendJson(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  // The host webserver provides no origin policy (its README: "No TLS, auth,
  // or origin policy"), while this route accepts untrusted JSON that mutates
  // state and can spawn MCP child processes (a stdio `command` via
  // manager.mcp.add / manager.mcp.probe). A cross-origin browser POST always
  // carries an `Origin` header naming the attacker's site, so requiring any
  // present Origin to name a loopback host blocks CSRF (and DNS-rebinding)
  // while leaving the loopback-served GUI and non-browser callers (no Origin
  // header) untouched. Binding `0.0.0.0` deliberately exposes the server; that
  // posture should be fronted by a real reverse proxy (the harness recommends
  // the same), not handled here.
  const LOOPBACK_ORIGIN_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

  /**
   * CSRF guard: allow the request only when it carries no Origin header
   * (same-origin form, or a non-browser caller like curl/another plugin) or
   * its Origin names a loopback host (the default bind posture).
   */
  function isAllowedOrigin(req: import('node:http').IncomingMessage): boolean {
    const origin = req.headers.origin
    if (origin === undefined || origin === '') return true
    try {
      const url = new URL(origin)
      // Reject URL userinfo smuggling (e.g. http://evil.example@127.0.0.1).
      if (url.username !== '' || url.password !== '') return false
      return LOOPBACK_ORIGIN_HOSTS.has(url.hostname.toLowerCase())
    } catch {
      return false // unparseable origin (including the literal "null")
    }
  }

  let webRegistered = false
  const registerWebSurface = (): void => {
    if (webRegistered) return
    const webServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as WebServerService | undefined
    if (webServer === undefined) return
    webRegistered = true
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler: async (req, res) => {
        if (!isAllowedOrigin(req)) {
          sendJson(res, 403, { ok: false, error: { code: 'forbidden-origin', message: 'cross-origin requests are not allowed' } })
          return
        }
        try {
          const body = await readJsonBody(req)
          const method = body.method
          const handler = typeof method === 'string' ? rpcMethods[method] : undefined
          if (handler === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'unknown-method', message: `unknown method ${JSON.stringify(method)}` } })
            return
          }
          const value = await handler((body.args ?? {}) as Record<string, unknown>)
          sendJson(res, 200, { ok: true, value })
        } catch (error) {
          // McpError carries {code, fields} on the Error object; the widening
          // cast keeps the structured error contract visible to the reader.
          const err = (error instanceof Error ? error : new Error(String(error))) as Error & { code?: unknown; fields?: Record<string, string> | undefined }
          sendJson(res, 200, {
            ok: false,
            error: {
              code: typeof err.code === 'string' ? err.code : 'internal',
              message: err.message,
              ...(err.fields !== undefined ? { fields: err.fields } : {}),
            },
          })
        }
      },
    }), 'mcp-skill-manager: rpc route')
  }
  registerWebSurface()
  ctx.on('internal/service', (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName as 'webServer' | 'httpServer')) registerWebSurface()
  })

  // ── 6) apply to live agents + lifecycle wiring ──────────────────────────
  // Shadow providers are registered on AGENT fibers (they must live as long
  // as the agent), so they are NOT auto-disposed with this plugin fiber. On
  // plugin unload/reload (HMR) dispose them explicitly — otherwise a reload
  // would hit duplicate provider names in the agent layer.
  ctx.effect(() => () => {
    for (const dispose of toolDisposers) dispose()
    toolDisposers.length = 0
    for (const { dispose } of shadowControls.values()) dispose()
    shadowControls.clear()
  }, 'mcp-skill-manager: agent-layer cleanup')

  for (const agent of ctx.agents.list()) {
    applyAgentFilter(agent)
  }

  ctx.on('agent/created', ({ agent }) => {
    applyAgentFilter(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    shadowControls.delete(agent.id)
  })
}