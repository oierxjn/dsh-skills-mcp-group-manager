/**
 * User patch-layer editor for the profile's `cordis.patch.yml`.
 *
 * MCP servers live as `@deepseek-ai/dsh-mcp-client` plugin entries composed
 * into the loader tree. The user-editable layer is the profile patch file; the
 * harness watches it (HMR) and hot-reloads the tree when it changes, so every
 * edit here is applied live without a restart.
 *
 * The file is a top-level YAML array of loader patch entries in the
 * `cordis-plugin-include` dialect:
 *   - `{ insert: [ {id, name, config} ] }`  — append new entries (id-less insert
 *     appends to the root list);
 *   - `{ id, name, config?, disabled? }`     — override/disable a composed entry;
 *   - `!!js` scalar expressions round-trip unchanged.
 *
 * js-yaml is loaded lazily: a `link:` install has no node_modules next to the
 * plugin source, so a missing dependency must degrade the MCP tab to a clear
 * RPC error instead of killing the whole plugin at import time.
 *
 * @module dsh-skills-mcp-group-manager/patch
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicSync } from './store.js';

/**
 * Mirrors `isJsExpr` from @deepseek-ai/cordis-plugin-loader (the harness's own
 * `cordis-plugin-include` uses it as the `!!js` yaml predicate). Replicated
 * inline so the host half has zero runtime imports of @deepseek-ai packages —
 * the plugin may be installed anywhere (e.g. via a `link:`), where bare
 * @deepseek-ai specifiers may not be resolvable from its real path.
 */
function isJsExpr(value) {
  return value instanceof Object && '__jsExpr' in value;
}

/**
 * Mirrors `resolveDshHome` from @deepseek-ai/dsh-home-paths (same precedence:
 * an explicit configured path, `$DSH_HOME`, then `~/.dsh`). Replicated inline
 * for the same portability reason as {@link isJsExpr}.
 */
function resolveDshHome(configured) {
  if (configured !== undefined && configured.trim() !== '') return configured.trim();
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.trim() !== '') return env.trim();
  return join(homedir(), '.dsh');
}

/** Header comment written ahead of the managed entry rows. */
const PATCH_HEADER = `# MCP servers managed by the dsh-skills-mcp-group-manager plugin.
# Format: a top-level YAML array of loader patch entries (\`!!js\` expressions
# allowed). Edit here, or use the MCP tab of the manager panel in the web GUI.
`;

/** Resolve the user patch file for the target profile (explicit path wins). */
export function resolvePatchPath({ patchFile, profile, dshHome } = {}) {
  if (typeof patchFile === 'string' && patchFile.trim() !== '') return patchFile.trim();
  const profileName = typeof profile === 'string' && profile.trim() !== '' ? profile.trim() : 'web';
  return join(resolveDshHome(dshHome), 'profiles', profileName, 'cordis.patch.yml');
}

// js-yaml + the entry-list schema are built once, on first use (see the module
// header for why the import is lazy).
let yamlPromise;
function loadYaml() {
  yamlPromise ??= import('js-yaml');
  return yamlPromise;
}

let schemaCache;
/**
 * The entry-list YAML dialect used by the harness include: plain JSON schema
 * extended with a `!!js` scalar type that round-trips expression nodes
 * (mirrors the dialect `dsh-app-boot` mounts).
 */
async function entryListSchema() {
  if (schemaCache !== undefined) return schemaCache;
  const yaml = await loadYaml();
  const JsExprType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: isJsExpr,
    represent: (data) => data.__jsExpr,
  });
  schemaCache = yaml.JSON_SCHEMA.extend(JsExprType);
  return schemaCache;
}

/** Read and parse the patch file; a missing file yields an empty list. */
export async function readPatchList(file) {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, 'utf8');
  if (content.trim() === '') return [];
  const yaml = await loadYaml();
  const parsed = yaml.load(content, { schema: await entryListSchema() });
  if (parsed === undefined || parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error(`patch file ${file} must be a top-level array`);
  return parsed;
}

/** Serialize and write the patch list atomically, preserving `!!js` expressions. */
export async function writePatchList(file, rows) {
  const yaml = await loadYaml();
  const schema = await entryListSchema();
  const body = rows.length > 0 ? yaml.dump(rows, { schema, lineWidth: 120 }) : '[]\n';
  writeFileAtomicSync(file, `${PATCH_HEADER}${body}`);
}

/** Apply an edit function and persist; returns the rows after the edit. */
export async function editPatchList(file, edit) {
  const next = edit(await readPatchList(file));
  await writePatchList(file, next);
  return next;
}

/** Whether any row (top-level or inside an insert list) carries the id. */
export function patchHasId(rows, id) {
  return rows.some((row) =>
    row.id === id || (Array.isArray(row.insert) && row.insert.some((item) => item.id === id)),
  );
}

/** Find the in-patch location of an entry id. */
function locate(rows, id) {
  for (const row of rows) {
    if (row.id === id) return { kind: 'row', row };
    if (Array.isArray(row.insert)) {
      const item = row.insert.find((entry) => entry.id === id);
      if (item !== undefined) return { kind: 'insert', row, item };
    }
  }
  return undefined;
}

/**
 * Append a new MCP server as an id-less insert row (the only patch form that
 * creates brand-new entries in the composed tree).
 */
export function addMcpRow(rows, id, config) {
  return [
    ...rows,
    { insert: [{ id, name: '@deepseek-ai/dsh-mcp-client', config }] },
  ];
}

/**
 * Remove every trace of an entry id: top-level rows and items inside insert
 * lists; an insert row that becomes empty is dropped.
 */
export function removeMcpRow(rows, id) {
  const next = [];
  for (const row of rows) {
    if (row.id === id) continue;
    if (Array.isArray(row.insert)) {
      const filtered = row.insert.filter((item) => item.id !== id);
      if (filtered.length === 0) continue;
      next.push({ ...row, insert: filtered });
      continue;
    }
    next.push(row);
  }
  return next;
}

/**
 * Enable/disable an entry. When the entry is defined in the user patch
 * (top-level or insert item) its own flag flips; otherwise a bundle-defined
 * entry is overridden with a matching `{id, name, disabled}` row (the patch
 * layer later in the stack wins).
 */
export function setMcpEnabled(rows, id, enabled) {
  const found = locate(rows, id);
  if (found === undefined) {
    return [...rows, { id, name: '@deepseek-ai/dsh-mcp-client', disabled: !enabled }];
  }
  if (found.kind === 'row') {
    return rows.map((row) =>
      row === found.row
        ? { ...row, disabled: !enabled }
        : row,
    );
  }
  const item = found.item;
  return rows.map((row) =>
    row === found.row
      ? {
          ...row,
          insert: row.insert.map((entry) =>
            entry === item ? { ...entry, disabled: !enabled } : entry,
          ),
        }
      : row,
  );
}

/**
 * Replace the config of an existing entry. When the entry is not in the user
 * patch (bundle-defined), a matching override row is appended.
 */
export function updateMcpConfig(rows, id, config) {
  const found = locate(rows, id);
  if (found === undefined) {
    return [...rows, { id, name: '@deepseek-ai/dsh-mcp-client', config }];
  }
  if (found.kind === 'row') {
    return rows.map((row) => (row === found.row ? { ...row, config } : row));
  }
  const item = found.item;
  return rows.map((row) =>
    row === found.row
      ? {
          ...row,
          insert: row.insert.map((entry) =>
            entry === item ? { ...entry, config } : entry,
          ),
        }
      : row,
  );
}

/** Whether an entry id is present in the user patch (removable/editable). */
export function isUserManaged(rows, id) {
  return patchHasId(rows, id);
}

/**
 * The plugin name recorded for the entry id in the user patch (top-level row
 * or insert item), or undefined when the id is not in the patch. Callers use
 * it to verify that a patch row with a given id really is an MCP client entry
 * before mutating it — the id alone is not proof (any plugin can own a row).
 */
export function patchEntryName(rows, id) {
  for (const row of rows) {
    if (row.id === id) return typeof row.name === 'string' ? row.name : undefined;
    if (Array.isArray(row.insert)) {
      const item = row.insert.find((entry) => entry.id === id);
      if (item !== undefined) return typeof item.name === 'string' ? item.name : undefined;
    }
  }
  return undefined;
}
