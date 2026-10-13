/**
 * Ambient type declarations for the DSH host platform surface consumed by
 * this plugin (host half: `src/index.ts`, `src/status.ts`, built to `lib/`).
 *
 * The real services are injected by the harness at runtime
 * (`inject: ['skills', 'tools', 'agents', 'loader', 'workspaceRegistry']`);
 * these declarations are intentionally minimal and describe only the members
 * the plugin actually touches. This file is a global script (no top-level
 * import/export), so the interfaces below are visible to all checked JS files
 * without imports.
 */

/** Provider-facing lookup options: only `cwd` and `signal` are part of a provider's contract. */
interface SkillLookupOptions {
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** Registry-facing view options: provider options plus the viewing scope. */
interface SkillViewOptions extends SkillLookupOptions {
  /** Viewing scope (the calling agent); omitted reads the global layer alone. */
  scope?: unknown;
}

/** Resolved model/user invocation controls carried by every catalog entry. */
interface SkillInvocationPolicy {
  modelInvocable: boolean;
  userInvocable: boolean;
}

/** Invocation-neutral skill metadata returned by `ctx.skills.list()`. */
interface SkillSummary {
  /** Absolute instruction file path when supplied by the provider; absent for virtual skills. */
  path?: string | undefined;
  /** Kebab-case identifier used to address the skill. */
  name: string;
  /** Short routing description (non-empty). */
  description: string;
  /** Optional extra routing guidance. */
  whenToUse?: string | undefined;
  /** Resolved model and user invocation controls. */
  invocation: SkillInvocationPolicy;
  /** Discovery source that produced this winning skill. */
  source: string;
  /** Provider that owns this skill body. */
  provider: string;
  /** Provider-specific base for relative resources. */
  resourceBase?: unknown;
}

/** Provider catalog entry used by the registry to merge and later load skills. */
interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names before provider registration order is considered. */
  rank: number;
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  locator: unknown;
  /** Parsed optional metadata object from provider-specific frontmatter. */
  metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after provider-specific metadata removal. */
  content: string;
  /** Parsed optional metadata object from frontmatter. */
  metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** Provider candidates plus whether the current discovery is authoritative. */
interface SkillProviderObservation {
  readonly candidates: readonly SkillCandidate[];
  readonly complete: boolean;
}

/** Invalidation handle handed to a skill-provider factory. */
interface SkillProviderControl {
  /** Aborts when the exact provider registration is disposed. */
  signal: AbortSignal;
  invalidate(): void;
}

/** Shadow provider object returned by a skill-provider factory. */
interface SkillProvider {
  name: string;
  list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation>;
  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>;
}

/** The `skills` registry service surface used by this plugin. */
interface SkillRegistry {
  list(options?: SkillViewOptions): Promise<SkillSummary[]>;
  get(name: string, options?: SkillViewOptions): Promise<SkillDefinition | undefined>;
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

/** A registered workspace entity as returned by `workspaceRegistry.list()`. */
interface WorkspaceEntity {
  /** Canonical absolute path of the workspace directory. */
  readonly path: string;
  readonly title: string;
  [key: string]: unknown;
}

/**
 * The `workspaceRegistry` service surface used by this plugin: the durable,
 * persisted registry of workspaces (the GUI workspace switcher's list).
 * `list()` is synchronous and independent of any live session, so the picker
 * can enumerate project skills even when every workspace is idle.
 */
interface WorkspaceRegistry {
  list(): WorkspaceEntity[];
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
 * The composition's `connection` service, as far as this plugin consumes it:
 * the Host/Origin fence plus browser authentication that first-party routes
 * apply to every request (mirrors the browser-side connection package's
 * `requestRejection`; locally typed because that package never reaches the
 * host typecheck). `403` = untrusted Host/Origin (DNS rebinding / cross-site),
 * `401` = trusted origin but unauthenticated browser, `undefined` = allow.
 */
interface ConnectionService {
  requestRejection(request: {
    readonly headers: import('node:http').IncomingMessage['headers'];
  }): 401 | 403 | undefined;
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
  /** Resolve an injected service by key (e.g. 'webServer' / 'connection'); strict=false yields undefined when absent. */
  get(key: string, strict?: boolean): unknown;
  /** Register a fiber-scoped side effect; the returned disposer (if any) runs on dispose. */
  effect(setup: () => unknown, label?: string): void;
  /** Subscribe to agent lifecycle events (payload carries the agent). */
  on(event: 'agent/created' | 'agent/disposed', listener: (payload: { agent: AgentEntry }) => void): void;
  /** Subscribe to internal service registration events (payload is the service key). */
  on(event: 'internal/service', listener: (payload: string) => void): void;
  /** Subscribe to any other lifecycle event (payload shape unspecified). */
  on(event: string, listener: (payload: unknown) => void): void;
  skills: SkillRegistry;
  tools: ToolRegistry;
  agents: AgentRegistry;
  loader: LoaderRegistry;
  workspaceRegistry: WorkspaceRegistry;
}
