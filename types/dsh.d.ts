/**
 * Ambient type declarations for the DSH host platform surface consumed by
 * this plugin (host half: `lib/index.js`, `lib/status.js`).
 *
 * The real services are injected by the harness at runtime
 * (`inject: ['skills', 'tools', 'agents', 'loader']`); these declarations are
 * intentionally minimal and describe only the members the plugin actually
 * touches. This file is a global script (no top-level import/export), so the
 * interfaces below are visible to all checked JS files without imports.
 */

/** Options threaded through skill registry list/get calls. */
interface SkillQueryOptions {
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Requesting scope (e.g. an agent); opaque to this plugin. */
  scope?: unknown;
}

/** A skill entry as returned by `ctx.skills.list()`. */
interface SkillCatalogEntry {
  name: string;
  description?: string | undefined;
  whenToUse?: string | undefined;
  resourceBase?: string | undefined;
  source?: string | undefined;
  invocation?: { modelInvocable: boolean; userInvocable: boolean } | undefined;
  [key: string]: unknown;
}

/** Invalidation handle handed to a skill-provider factory. */
interface SkillProviderControl {
  invalidate(): void;
}

/** A skill-catalog candidate passed back into `provider.get()`. */
interface SkillCandidate {
  name: string;
  [key: string]: unknown;
}

/** Shadow provider object returned by a skill-provider factory. */
interface SkillProvider {
  name: string;
  list(options: SkillQueryOptions): Promise<Record<string, unknown>[]>;
  get(candidate: SkillCandidate, options: SkillQueryOptions): Promise<unknown>;
}

/** The `skills` registry service surface used by this plugin. */
interface SkillRegistry {
  list(options?: SkillQueryOptions): Promise<SkillCatalogEntry[]>;
  get(name: string, options?: SkillQueryOptions): Promise<unknown>;
  /** Register a layered provider; returns a disposer. */
  registerProvider(
    factory: (control: SkillProviderControl) => SkillProvider,
  ): () => void;
}

/** Definition accepted by `tools.register` (compact spec, pre-conversion). */
interface ToolDefinitionInput {
  name: string;
  description?: string | undefined;
  /** Compact parameter spec; `required: true` flags are hoisted by parameterSchema(). */
  parameters?: Record<string, unknown> | undefined;
  /** Compact output spec with an optional render callback. */
  output?: {
    schema?: Record<string, unknown> | undefined;
    render?: (args: Record<string, unknown>, value: unknown) => unknown;
  } | undefined;
  execute(args: Record<string, unknown>, exec?: ToolExecContext): unknown | Promise<unknown>;
  [key: string]: unknown;
}

/** Tool execution context (carries the calling agent when present). */
interface ToolExecContext {
  agent?: { id?: string } | undefined;
  [key: string]: unknown;
}

/** A schema row yielded by `tools.schemas()`. */
interface ToolSchemaRow {
  name?: string | undefined;
  [key: string]: unknown;
}

/** The `tools` registry service surface used by this plugin. */
interface ToolRegistry {
  register(definition: ToolDefinitionInput): () => void;
  schemas(): Iterable<ToolSchemaRow>;
}

/** A live agent entry as returned by `ctx.agents.list()`. */
interface AgentEntry {
  id: string;
  session?: { header?: { cwd?: string | undefined } | undefined } | undefined;
  ctx: { get(key: string): unknown };
  [key: string]: unknown;
}

/** The `agents` registry service surface used by this plugin. */
interface AgentRegistry {
  list(): AgentEntry[];
}

/** A live loader-composition entry (one plugin instance in the tree). */
interface LoaderEntryLive {
  id: string;
  disabled?: boolean | undefined;
  fiber?: { state: number } | undefined;
  options: {
    group?: unknown;
    name?: unknown;
    config?: unknown;
    [key: string]: unknown;
  };
}

/** The `loader` service surface used by this plugin. */
interface LoaderRegistry {
  entries(): Iterable<LoaderEntryLive>;
}

/** An exact-path HTTP route registration for the web-server service. */
interface WebServerRoute {
  kind: 'exact';
  path: string;
  handler(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> | void;
}

/** The web-server service surface used by this plugin (RPC route mounting). */
interface WebServerService {
  register(route: WebServerRoute): void;
}

/**
 * The bundle-plugin context: the plugin `apply()` receives this object, and
 * per-service registries are also reachable through `ctx.get(key)`.
 */
interface HostPluginContext {
  logger: {
    info?: (message?: unknown, ...rest: unknown[]) => void;
    warn?: (message?: unknown, ...rest: unknown[]) => void;
    error?: (message?: unknown, ...rest: unknown[]) => void;
  };
  /** Resolve an injected service by key (e.g. 'webServer' / 'httpServer'). */
  get(key: string): unknown;
  /** Register a fiber-scoped side effect; the returned disposer (if any) runs on dispose. */
  effect(setup: () => unknown, label?: string): void;
  /** Subscribe to a lifecycle event (`agent/created`, `agent/disposed`, `internal/service`). */
  on(event: string, listener: (payload: never) => void): void;
  skills: SkillRegistry;
  tools: ToolRegistry;
  agents: AgentRegistry;
  loader: LoaderRegistry;
}
