/**
 * dsh-mcp-skill-manager — dedicated state store.
 *
 * The user asked for group state to live OUTSIDE `settings.yaml`, in a
 * plugin-owned location that is removed together with the plugin on
 * uninstall. This module persists state to:
 *
 *   `<harness home>/mcp-skill-manager/state.json`
 *
 * (`<harness home>` = `$DSH_HOME` or `~/.dsh`). Writes are atomic
 * (temp file + rename) and serialized through a promise chain; reads fall
 * back to the empty state on missing or corrupt files. The whole directory
 * is plugin-owned, so uninstalling the plugin (which runs the package's
 * `postuninstall` script, `scripts/cleanup.mjs`) removes the data with it.
 *
 * The store exposes the same surface the host half used on the settings
 * scope — `get()` / `update(patch)` — plus `load()` for startup.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Resolve the plugin-owned state directory under the harness home.
 * @param {string | undefined} dshHome
 * @returns {string}
 */
export function resolveStateDir(dshHome) {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'mcp-skill-manager');
}

/**
 * Synchronous atomic file write (temp file + rename, parent directory
 * created). Shared by the state store and the cordis.patch.yml editor so both
 * persist through the same crash-safe path.
 * @param {string} file
 * @param {string} content
 * @returns {void}
 */
export function writeFileAtomicSync(file, content) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/**
 * Normalize an untrusted parsed document into the state shape.
 * @param {unknown} raw
 * @returns {import('./types.js').ManagerState}
 */
export function normalizeState(raw) {
  const doc = /** @type {{ groups?: unknown, sessions?: unknown }} */ (raw ?? {});
  const groups = Array.isArray(doc.groups)
    ? doc.groups.filter((/** @type {any} */ g) => g !== null && typeof g === 'object'
      && typeof g.id === 'string' && typeof g.name === 'string'
      && typeof g.enabled === 'boolean' && Array.isArray(g.skills)
      && g.skills.every((/** @type {any} */ s) => typeof s === 'string'))
    : [];
  /** @type {Record<string, import('./types.js').SessionOverride>} */
  const sessions = {};
  if (doc.sessions !== null && typeof doc.sessions === 'object' && !Array.isArray(doc.sessions)) {
    for (const [sessionId, entry] of Object.entries(doc.sessions)) {
      if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.enabledGroupIds)) continue;
      // Non-string ids inside a kept entry are dropped; the entry itself is
      // dropped only when enabledGroupIds is not an array at all.
      sessions[sessionId] = {
        enabledGroupIds: entry.enabledGroupIds.filter((/** @type {any} */ id) => typeof id === 'string'),
      };
    }
  }
  // The legacy `mcp` section is deliberately dropped: MCP servers now live in
  // cordis.patch.yml (see lib/patch.js); state.json only owns skill groups and
  // per-session group overrides.
  return { groups, sessions };
}

/**
 * Create the state store.
 * @param {object} [options]
 * @param {string} [options.dshHome] explicit harness home (tests pass a temp dir).
 * @param {import('./types.js').Logger} [options.logger] optional `{ warn, error }` logger (defaults to console).
 * @returns {import('./types.js').StateStore}
 */
export function createStateStore({ dshHome, logger = console } = {}) {
  const dir = resolveStateDir(dshHome);
  const file = join(dir, 'state.json');
  /** @type {import('./types.js').ManagerState} */
  let state = { groups: [], sessions: {} };
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();

  /**
   * Load state from disk SYNCHRONOUSLY (idempotent; safe to call once at
   * startup). The host plugin's apply() must stay synchronous — Cordis
   * treats a prototype-bearing function as a constructor and ignores its
   * returned promise, so an async apply would turn any post-await throw
   * into an unhandled rejection that crashes the whole dsh process.
   */
  function loadSync() {
    try {
      state = normalizeState(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      const code = /** @type {{ code?: unknown }} */ (error)?.code;
      if (code !== 'ENOENT') {
        logger.warn?.(`mcp-skill-manager: state file unreadable (${file}): ${String(error)}; starting empty`);
      }
      state = { groups: [], sessions: {} };
    }
    return state;
  }

  /** Load state from disk (async variant; kept for tests and tooling). */
  async function load() {
    try {
      const raw = await readFile(file, 'utf8');
      state = normalizeState(JSON.parse(raw));
    } catch (error) {
      const code = /** @type {{ code?: unknown }} */ (error)?.code;
      if (code !== 'ENOENT') {
        logger.warn?.(`mcp-skill-manager: state file unreadable (${file}): ${String(error)}; starting empty`);
      }
      state = { groups: [], sessions: {} };
    }
    return state;
  }

  /** Current in-memory state (plain data; callers must not mutate it). */
  function get() {
    return state;
  }

  /**
   * Merge a patch into the state and persist atomically.
   * @param {Partial<import('./types.js').ManagerState>} patch
   * @returns {Promise<void>}
   */
  function update(patch) {
    state = { ...state, ...patch };
    return persist();
  }

  /**
   * Replace the whole state and persist atomically.
   * @param {unknown} next
   * @returns {Promise<void>}
   */
  function replace(next) {
    state = normalizeState(next);
    return persist();
  }

  /** Serialized atomic write; failures never poison the chain. */
  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain
      .then(async () => {
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
        await writeFile(tmp, snapshot, 'utf8');
        await rename(tmp, file);
      })
      .catch((error) => {
        logger.error?.(`mcp-skill-manager: state write failed (${file}): ${String(error)}`);
      });
    return writeChain;
  }

  return { load, loadSync, get, update, replace, persist, dir, file };
}
