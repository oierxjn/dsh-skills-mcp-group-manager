/**
 * Ambient type declarations for the DSH browser platform surface consumed by
 * this plugin (client half: `src/client/index.ts`, built to `lib/client.js`).
 *
 * The real services are injected by the client-modules runtime at boot; these
 * declarations are intentionally minimal and describe only the members the
 * client bundle actually touches. This file is a global script (no top-level
 * import/export), so the interfaces below are visible to the client source
 * without imports.
 */

/** One locale dictionary (flat key → text table). */
type LocaleDictionary = Record<string, string>;

/** The dictionary pair a locale namespace registers. */
interface LocaleDicts {
  zh: LocaleDictionary;
  en: LocaleDictionary;
}

/** A bound translator (optionally interpolating `{name}` placeholders). */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/** Options for one `settings.section` / header-action slot registration. */
interface SlotRegistrationOptions {
  name: string;
  id: string;
  order: number;
  /** Either a fixed label or a render-time closure (locale-aware). */
  label?: string | (() => string);
  /** Namespace the label resolves against. */
  locale?: string;
  /** Keyed slot entries (e.g. `tool.call.toolview`) use this instead of id. */
  key?: string;
}

/**
 * The browser plugin context: `apply()` receives this object, and per-service
 * registries are also reachable through `ctx.get(key)`.
 */
interface ClientPluginContext {
  /** Register a fiber-scoped side effect; the setup's returned disposer (if any) runs on dispose. */
  effect(setup: () => (() => void) | void, label?: string): unknown;
  locale: {
    /** Register a namespace's dictionaries; returns a disposer. */
    register(ns: string, dicts: LocaleDicts): () => void;
    /** Bind a namespace translator (the locale service's fallback ladder applies). */
    bind(ns: string): Translate;
  };
  slots: {
    /** Queue a slot registration for a slot name. */
    inject(slotName: string, callback: () => void): void;
    /** Register a slot entry; `component` is called with the slot's props. */
    register(options: SlotRegistrationOptions, component: (props: never) => unknown): () => void;
  };
  /** Resolve an injected service by key (e.g. 'inputTriggers' / 'connection' / 'sessions'). */
  get(key: string): unknown;
}