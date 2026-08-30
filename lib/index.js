import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
//#region lib/types/errors.js
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
var McpError = class extends Error {
	code;
	fields;
	constructor(code, message, fields) {
		super(message);
		this.code = code;
		if (fields !== void 0) this.fields = fields;
	}
};
//#endregion
//#region lib/types/tool-schemas.js
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
function parameterSchema(spec) {
	const properties = {};
	const required = [];
	for (const [name, fieldRaw] of Object.entries(spec ?? {})) {
		const { required: isRequired, ...rest } = fieldRaw;
		properties[name] = rest;
		if (isRequired) required.push(name);
	}
	return {
		type: "object",
		additionalProperties: false,
		properties,
		...required.length > 0 ? { required } : {}
	};
}
/**
* Convert a compact value spec (required flags inside properties) to raw JSON schema.
*/
function valueSchema(spec) {
	if (spec === void 0) return void 0;
	const convert = (node) => {
		if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
		const out = {};
		const required = [];
		for (const [key, value] of Object.entries(node)) {
			if (key === "required" && value === true) continue;
			if (key === "properties" && typeof value === "object" && value !== null) {
				const props = {};
				for (const [pname, pnode] of Object.entries(value)) if (pnode !== null && typeof pnode === "object" && !Array.isArray(pnode) && pnode.required === true) {
					required.push(pname);
					const { required: _drop, ...rest } = pnode;
					props[pname] = convert(rest);
				} else props[pname] = convert(pnode);
				out.properties = props;
			} else if (key === "items" && typeof value === "object" && value !== null) out.items = convert(value);
			else out[key] = value;
		}
		if (required.length > 0) out.required = required;
		return out;
	};
	return convert(spec);
}
/** Shared output schema of manager_session_get / manager_session_set. */
const sessionStateOutput = {
	type: "object",
	additionalProperties: false,
	properties: {
		override: {
			oneOf: [{
				type: "object",
				additionalProperties: false,
				properties: { enabledGroupIds: {
					type: "array",
					items: { type: "string" }
				} },
				required: ["enabledGroupIds"]
			}, { type: "null" }],
			required: true
		},
		effectiveGroupIds: {
			type: "array",
			required: true,
			items: { type: "string" }
		}
	}
};
/** Shared parameter spec of manager_mcp_add / manager_mcp_update. */
const mcpConfigParams = {
	id: {
		type: "string",
		required: true,
		description: "Loader entry id (^[A-Za-z0-9_-]{1,64}$); unique across all loader entries."
	},
	serverName: {
		type: "string",
		required: true,
		description: "Unique server name (^[A-Za-z0-9_-]{1,32}$); tools appear as mcp__<serverName>__*."
	},
	transport: {
		type: "string",
		required: true,
		description: "\"stdio\" or \"streamable-http\"."
	},
	command: {
		type: "string",
		description: "stdio: executable command."
	},
	args: {
		type: "array",
		items: { type: "string" },
		description: "stdio: command arguments."
	},
	env: {
		type: "object",
		additionalProperties: true,
		description: "stdio: environment overrides (string values)."
	},
	cwd: {
		type: "string",
		description: "stdio: working directory of the child process."
	},
	url: {
		type: "string",
		description: "streamable-http: endpoint URL."
	},
	headers: {
		type: "object",
		additionalProperties: true,
		description: "streamable-http: extra request headers (string values)."
	},
	toolCallTimeoutMs: {
		type: "number",
		description: "Per-callTool timeout in ms (dsh-mcp-client default 60000)."
	},
	failOnStartupError: {
		type: "boolean",
		description: "Reject activation when the initial connection/sync fails."
	}
};
//#endregion
//#region lib/types/state.js
/**
* Pure state logic for the dsh-mcp-skill-manager host half.
*
* Deliberately dependency-free (no Cordis, no schemastery): every function
* here is unit-testable with plain `node --test` and is the single source of
* truth for the state semantics shared by the manager_* tools, the RPC
* surface, and the skill-catalog shadow provider in src/index.ts.
*
* All functions operate on plain JSON-shaped state objects:
*   state = {
*     groups: [{ id, name, enabled, skills: string[] }],
*     sessions: { [sessionId]: { enabledGroupIds: string[] } },
*   }
*
* `sessions[sessionId]` is that session's explicit group selection; a session
* without an entry follows the global enabled-group union. An empty array
* means the session injects nothing.
*
* MCP servers no longer live in this state: they are rows in the profile's
* cordis.patch.yml (see src/patch.ts); this module only hosts the field-level
* config validation shared by the add/update/probe paths.
*/
/** Same domain as dsh-mcp-client's SERVER_NAME_PATTERN. Mirrored in lib/client.js (the browser bundle cannot import this module). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Loader entry id domain for user-managed MCP rows. Mirrored in lib/client.js. */
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/**
* The injected skill set: the union of skill names across all enabled groups.
* A skill listed in several enabled groups appears exactly once (Set dedup);
* disabled groups contribute nothing.
*/
function enabledSkillNames(state) {
	const set = /* @__PURE__ */ new Set();
	for (const group of state.groups) {
		if (!group.enabled) continue;
		for (const skill of group.skills) set.add(skill);
	}
	return set;
}
/**
* The injected skill set for ONE session. A session without an entry in
* `state.sessions` follows the global union (identical to
* enabledSkillNames); an entry is an explicit set of group ids whose skills
* are injected regardless of the groups' global enabled flags — an override
* detaches the session from the global toggles. Ids of deleted groups are
* dropped on read; `[]` injects nothing.
*/
function enabledSkillNamesFor(state, sessionId) {
	const override = state.sessions?.[sessionId];
	if (override === void 0) return enabledSkillNames(state);
	const byId = new Map(state.groups.map((group) => [group.id, group]));
	const set = /* @__PURE__ */ new Set();
	for (const id of override.enabledGroupIds) {
		const group = byId.get(id);
		if (group === void 0) continue;
		for (const skill of group.skills) set.add(skill);
	}
	return set;
}
/** Find one group by stable id; undefined when absent. */
function groupById(state, id) {
	return state.groups.find((group) => group.id === id);
}
/**
* Append multiple skill names to a group in ONE immutable update (deduped).
* The host batch RPC uses this so adding N skills costs one write + one
* catalog invalidation instead of N writes + N invalidations.
*/
function addSkillsToGroup(state, id, names) {
	const group = state.groups.find((g) => g.id === id);
	if (group === void 0) throw new McpError("not-found", `group "${id}" does not exist`);
	const seen = new Set(group.skills);
	const added = [];
	for (const name of names) if (!seen.has(name)) {
		seen.add(name);
		added.push(name);
	}
	if (added.length === 0) return state;
	return {
		...state,
		groups: state.groups.map((g) => g.id === id ? {
			...g,
			skills: [...g.skills, ...added]
		} : g)
	};
}
/**
* Remove multiple skill names from a group in ONE immutable update.
*/
function removeSkillsFromGroup(state, id, names) {
	const group = state.groups.find((g) => g.id === id);
	if (group === void 0) throw new McpError("not-found", `group "${id}" does not exist`);
	const remove = new Set(names);
	const remaining = group.skills.filter((name) => !remove.has(name));
	if (remaining.length === group.skills.length) return state;
	return {
		...state,
		groups: state.groups.map((g) => g.id === id ? {
			...g,
			skills: remaining
		} : g)
	};
}
function isStringRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((v) => typeof v === "string");
}
/**
* Pick the known dsh-mcp-client config fields out of a raw args object (tool
* or RPC input). Values are picked verbatim — validateMcpConfig flags the
* type errors, so nothing is silently dropped.
*/
function pickServerConfig(input) {
	const config = {
		serverName: input.serverName,
		transport: input.transport === "stdio" ? "stdio" : "streamable-http"
	};
	const loose = config;
	for (const key of [
		"url",
		"command",
		"args",
		"env",
		"cwd",
		"headers",
		"toolCallTimeoutMs",
		"failOnStartupError"
	]) if (input[key] !== void 0) loose[key] = input[key];
	return config;
}
/**
* Validate a proposed MCP server config; returns field-level errors keyed by
* field name (empty object = valid). Every rule mirrors the dsh-mcp-client
* schema so the panel rejects invalid input with the same semantics the
* plugin would enforce at load. Replaces the old throw-on-first-error
* validateMcpServerInput so the UI can display every violation inline.
*/
function validateMcpConfig(id, config) {
	const errors = {};
	if (typeof id !== "string" || !ENTRY_ID_PATTERN.test(id)) errors.id = `Entry id must match ${ENTRY_ID_PATTERN.source}`;
	if (typeof config.serverName !== "string" || !SERVER_NAME_PATTERN.test(config.serverName)) errors.serverName = `serverName must match ${SERVER_NAME_PATTERN.source}`;
	if ((config.transport === "stdio" ? "stdio" : "streamable-http") === "streamable-http") {
		if (typeof config.url !== "string" || !/^https?:\/\/.+/.test(config.url)) errors.url = "A valid http(s):// URL is required for streamable-http";
	} else {
		if (typeof config.command !== "string" || config.command.trim() === "") errors.command = "An executable command is required for stdio";
		if (config.args !== void 0 && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string"))) errors.args = "args must be an array of strings";
		if (config.cwd !== void 0 && typeof config.cwd !== "string") errors.cwd = "cwd must be a string";
	}
	if (config.env !== void 0 && !isStringRecord(config.env)) errors.env = "env must be a string-to-string map";
	if (config.headers !== void 0 && !isStringRecord(config.headers)) errors.headers = "headers must be a string-to-string map";
	if (config.toolCallTimeoutMs !== void 0 && (typeof config.toolCallTimeoutMs !== "number" || config.toolCallTimeoutMs < 1)) errors.toolCallTimeoutMs = "toolCallTimeoutMs must be a positive number";
	return errors;
}
/** Fresh plain-JSON copy of the state (scalar fields only; never live data). */
function snapshotState(state) {
	return {
		groups: state.groups.map((group) => ({
			id: group.id,
			name: group.name,
			enabled: group.enabled,
			skills: [...group.skills]
		})),
		sessions: Object.fromEntries(Object.entries(state.sessions ?? {}).map(([sessionId, entry]) => [sessionId, { enabledGroupIds: [...entry.enabledGroupIds] }]))
	};
}
//#endregion
//#region lib/types/store.js
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
/** Resolve the plugin-owned state directory under the harness home. */
function resolveStateDir(dshHome) {
	const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "mcp-skill-manager");
}
/**
* Synchronous atomic file write (temp file + rename, parent directory
* created). Shared by the state store and the cordis.patch.yml editor so both
* persist through the same crash-safe path.
*/
function writeFileAtomicSync(file, content) {
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, file);
}
/** Normalize an untrusted parsed document into the state shape. */
function normalizeState(raw) {
	const doc = raw ?? {};
	const groups = Array.isArray(doc.groups) ? doc.groups.filter((g) => g !== null && typeof g === "object" && typeof g.id === "string" && typeof g.name === "string" && typeof g.enabled === "boolean" && Array.isArray(g.skills) && g.skills.every((s) => typeof s === "string")).map((g) => g) : [];
	const sessions = {};
	if (doc.sessions !== null && typeof doc.sessions === "object" && !Array.isArray(doc.sessions)) for (const [sessionId, entry] of Object.entries(doc.sessions)) {
		if (entry === null || typeof entry !== "object" || !Array.isArray(entry.enabledGroupIds)) continue;
		sessions[sessionId] = { enabledGroupIds: entry.enabledGroupIds.filter((id) => typeof id === "string") };
	}
	return {
		groups,
		sessions
	};
}
/** Create the state store. */
function createStateStore(options = {}) {
	const { dshHome, logger = console } = options;
	const dir = resolveStateDir(dshHome);
	const file = join(dir, "state.json");
	let state = {
		groups: [],
		sessions: {}
	};
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
			state = normalizeState(JSON.parse(readFileSync(file, "utf8")));
		} catch (error) {
			if (error?.code !== "ENOENT") logger.warn?.(`mcp-skill-manager: state file unreadable (${file}): ${String(error)}; starting empty`);
			state = {
				groups: [],
				sessions: {}
			};
		}
		return state;
	}
	/** Load state from disk (async variant; kept for tests and tooling). */
	async function load() {
		try {
			const raw = await readFile(file, "utf8");
			state = normalizeState(JSON.parse(raw));
		} catch (error) {
			if (error?.code !== "ENOENT") logger.warn?.(`mcp-skill-manager: state file unreadable (${file}): ${String(error)}; starting empty`);
			state = {
				groups: [],
				sessions: {}
			};
		}
		return state;
	}
	/** Current in-memory state (plain data; callers must not mutate it). */
	function get() {
		return state;
	}
	/** Merge a patch into the state and persist atomically. */
	function update(patch) {
		state = {
			...state,
			...patch
		};
		return persist();
	}
	/** Replace the whole state and persist atomically. */
	function replace(next) {
		state = normalizeState(next);
		return persist();
	}
	/** Serialized atomic write; failures never poison the chain. */
	function persist() {
		const snapshot = JSON.stringify(state, null, 2);
		writeChain = writeChain.then(async () => {
			await mkdir(dir, { recursive: true });
			const tmp = join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
			await writeFile(tmp, snapshot, "utf8");
			await rename(tmp, file);
		}).catch((error) => {
			logger.error?.(`mcp-skill-manager: state write failed (${file}): ${String(error)}`);
		});
		return writeChain;
	}
	return {
		load,
		loadSync,
		get,
		update,
		replace,
		persist,
		dir,
		file
	};
}
//#endregion
//#region lib/types/patch.js
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
*/
/**
* Mirrors `isJsExpr` from @deepseek-ai/cordis-plugin-loader (the harness's own
* `cordis-plugin-include` uses it as the `!!js` yaml predicate). Replicated
* inline so the host half has zero runtime imports of @deepseek-ai packages —
* the plugin may be installed anywhere (e.g. via a `link:`), where bare
* @deepseek-ai specifiers may not be resolvable from its real path.
*/
function isJsExpr(value) {
	return value instanceof Object && "__jsExpr" in value;
}
/**
* Mirrors `resolveDshHome` from @deepseek-ai/dsh-home-paths (same precedence:
* an explicit configured path, `$DSH_HOME`, then `~/.dsh`). Replicated inline
* for the same portability reason as isJsExpr.
*/
function resolveDshHome(configured) {
	if (configured !== void 0 && configured.trim() !== "") return configured.trim();
	const env = process.env.DSH_HOME;
	if (env !== void 0 && env.trim() !== "") return env.trim();
	return join(homedir(), ".dsh");
}
/** Header comment written ahead of the managed entry rows. */
const PATCH_HEADER = `# MCP servers managed by the dsh-skills-mcp-group-manager plugin.
# Format: a top-level YAML array of loader patch entries (\`!!js\` expressions
# allowed). Edit here, or use the MCP tab of the manager panel in the web GUI.
`;
/**
* Resolve the user patch file for the target profile (explicit path wins).
*/
function resolvePatchPath(options = {}) {
	const { patchFile, profile, dshHome } = options;
	if (typeof patchFile === "string" && patchFile.trim() !== "") return patchFile.trim();
	const profileName = typeof profile === "string" && profile.trim() !== "" ? profile.trim() : "web";
	return join(resolveDshHome(dshHome), "profiles", profileName, "cordis.patch.yml");
}
let yamlPromise;
function loadYaml() {
	yamlPromise ??= import("js-yaml");
	return yamlPromise;
}
let schemaCache;
/**
* The entry-list YAML dialect used by the harness include: plain JSON schema
* extended with a `!!js` scalar type that round-trips expression nodes
* (mirrors the dialect `dsh-app-boot` mounts).
*/
async function entryListSchema() {
	if (schemaCache !== void 0) return schemaCache;
	const yaml = await loadYaml();
	const JsExprType = new yaml.Type("tag:yaml.org,2002:js", {
		kind: "scalar",
		resolve: (data) => typeof data === "string",
		construct: (data) => ({ __jsExpr: data }),
		predicate: isJsExpr,
		represent: (data) => data.__jsExpr
	});
	schemaCache = yaml.JSON_SCHEMA.extend(JsExprType);
	return schemaCache;
}
/** Read and parse the patch file; a missing file yields an empty list. */
async function readPatchList(file) {
	if (!existsSync(file)) return [];
	const content = readFileSync(file, "utf8");
	if (content.trim() === "") return [];
	const parsed = (await loadYaml()).load(content, { schema: await entryListSchema() });
	if (parsed === void 0 || parsed === null) return [];
	if (!Array.isArray(parsed)) throw new Error(`patch file ${file} must be a top-level array`);
	return parsed;
}
/** Serialize and write the patch list atomically, preserving `!!js` expressions. */
async function writePatchList(file, rows) {
	const yaml = await loadYaml();
	const schema = await entryListSchema();
	const body = rows.length > 0 ? yaml.dump(rows, {
		schema,
		lineWidth: 120
	}) : "[]\n";
	writeFileAtomicSync(file, `${PATCH_HEADER}${body}`);
}
/** Apply an edit function and persist; returns the rows after the edit. */
async function editPatchList(file, edit) {
	const next = await edit(await readPatchList(file));
	await writePatchList(file, next);
	return next;
}
/** Whether any row (top-level or inside an insert list) carries the id. */
function patchHasId(rows, id) {
	return rows.some((row) => row.id === id || Array.isArray(row.insert) && row.insert.some((item) => item.id === id));
}
function locate(rows, id) {
	for (const row of rows) {
		if (row.id === id) return {
			kind: "row",
			row
		};
		if (Array.isArray(row.insert)) {
			const item = row.insert.find((entry) => entry.id === id);
			if (item !== void 0) return {
				kind: "insert",
				row,
				item
			};
		}
	}
}
/**
* Append a new MCP server as an id-less insert row (the only patch form that
* creates brand-new entries in the composed tree).
*/
function addMcpRow(rows, id, config) {
	return [...rows, { insert: [{
		id,
		name: "@deepseek-ai/dsh-mcp-client",
		config
	}] }];
}
/**
* Remove every trace of an entry id: top-level rows and items inside insert
* lists; an insert row that becomes empty is dropped.
*/
function removeMcpRow(rows, id) {
	const next = [];
	for (const row of rows) {
		if (row.id === id) continue;
		if (Array.isArray(row.insert)) {
			const filtered = row.insert.filter((item) => item.id !== id);
			if (filtered.length === 0) continue;
			next.push({
				...row,
				insert: filtered
			});
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
function setMcpEnabled(rows, id, enabled) {
	const found = locate(rows, id);
	if (found === void 0) return [...rows, {
		id,
		name: "@deepseek-ai/dsh-mcp-client",
		disabled: !enabled
	}];
	if (found.kind === "row") return rows.map((row) => row === found.row ? {
		...row,
		disabled: !enabled
	} : row);
	const item = found.item;
	return rows.map((row) => row === found.row ? {
		...row,
		insert: row.insert.map((entry) => entry === item ? {
			...entry,
			disabled: !enabled
		} : entry)
	} : row);
}
/**
* Replace the config of an existing entry. When the entry is not in the user
* patch (bundle-defined), a matching override row is appended.
*/
function updateMcpConfig(rows, id, config) {
	const found = locate(rows, id);
	if (found === void 0) return [...rows, {
		id,
		name: "@deepseek-ai/dsh-mcp-client",
		config
	}];
	if (found.kind === "row") return rows.map((row) => row === found.row ? {
		...row,
		config
	} : row);
	const item = found.item;
	return rows.map((row) => row === found.row ? {
		...row,
		insert: row.insert.map((entry) => entry === item ? {
			...entry,
			config
		} : entry)
	} : row);
}
/** Whether an entry id is present in the user patch (removable/editable). */
function isUserManaged(rows, id) {
	return patchHasId(rows, id);
}
/**
* The plugin name recorded for the entry id in the user patch (top-level row
* or insert item), or undefined when the id is not in the patch. Callers use
* it to verify that a patch row with a given id really is an MCP client entry
* before mutating it — the id alone is not proof (any plugin can own a row).
*/
function patchEntryName(rows, id) {
	for (const row of rows) {
		if (row.id === id) return typeof row.name === "string" ? row.name : void 0;
		if (Array.isArray(row.insert)) {
			const item = row.insert.find((entry) => entry.id === id);
			if (item !== void 0) return typeof item.name === "string" ? item.name : void 0;
		}
	}
}
/** Runtime mirror of the cross-package Cordis FiberState const enum. */
const FIBER_STATE = {
	PENDING: 0,
	LOADING: 1,
	ACTIVE: 2,
	FAILED: 3,
	DISPOSED: 4,
	UNLOADING: 5
};
/**
* The composed loader nests every row under the root include group, so tree
* entry ids look like `include:<file-id>` (nested groups add more segments).
* The user patch file addresses rows by their file-level id, so the plugin
* strips the leading root-group segment for all id comparisons.
*/
function normalizeEntryId(id) {
	return id.startsWith("include:") ? id.slice(8) : id;
}
/** Complete public projection of the Cordis Fiber states. */
const FIBER_PHASE = {
	[FIBER_STATE.PENDING]: "pending",
	[FIBER_STATE.LOADING]: "loading",
	[FIBER_STATE.ACTIVE]: "active",
	[FIBER_STATE.FAILED]: "failed",
	[FIBER_STATE.DISPOSED]: null,
	[FIBER_STATE.UNLOADING]: "unloading"
};
/**
* Project a raw fiber state number. A state outside the mirrored enum means
* the host Cordis version drifted from this mirror — warn and degrade to
* `null` instead of silently misreporting the phase.
*/
function fiberPhaseOf(state, logger) {
	const phase = FIBER_PHASE[state];
	if (phase === void 0) {
		logger?.warn?.(`mcp-skill-manager: unknown fiber state ${String(state)}; reporting status as not-loaded`);
		return null;
	}
	return phase;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Normalize a raw mcp-client row config into the shared shape. */
function toServerConfig(raw) {
	const cfg = raw ?? {};
	return {
		serverName: typeof cfg.serverName === "string" ? cfg.serverName : "",
		transport: cfg.transport === "stdio" ? "stdio" : "streamable-http",
		url: typeof cfg.url === "string" ? cfg.url : void 0,
		command: typeof cfg.command === "string" ? cfg.command : void 0,
		args: Array.isArray(cfg.args) ? cfg.args : void 0,
		env: isRecord(cfg.env) ? cfg.env : void 0,
		cwd: typeof cfg.cwd === "string" ? cfg.cwd : void 0,
		headers: isRecord(cfg.headers) ? cfg.headers : void 0,
		toolCallTimeoutMs: typeof cfg.toolCallTimeoutMs === "number" ? cfg.toolCallTimeoutMs : void 0,
		failOnStartupError: typeof cfg.failOnStartupError === "boolean" ? cfg.failOnStartupError : void 0,
		reconnect: isRecord(cfg.reconnect) ? cfg.reconnect : void 0
	};
}
/** Count tools registered on the harness registry under a server namespace. */
function countServerTools(ctx, serverName) {
	if (serverName === "") return 0;
	const prefix = `mcp__${serverName}__`;
	let count = 0;
	for (const schema of ctx.tools.schemas()) if (schema.name !== void 0 && schema.name.startsWith(prefix)) count += 1;
	return count;
}
/** Enumerate every live mcp-client instance with its status projection. */
function listMcpServers(ctx, userManaged, logger) {
	const servers = [];
	for (const entry of ctx.loader.entries()) {
		if (entry.options.group) continue;
		if (entry.options.name !== "@deepseek-ai/dsh-mcp-client") continue;
		const config = toServerConfig(entry.options.config);
		const phase = entry.fiber === void 0 ? null : fiberPhaseOf(entry.fiber.state, logger);
		const id = normalizeEntryId(entry.id);
		servers.push({
			...config,
			id,
			enabled: !entry.disabled,
			fiberPhase: phase,
			toolCount: countServerTools(ctx, config.serverName),
			userManaged: userManaged(id)
		});
	}
	return servers;
}
/** Whether a serverName is already taken by a live mcp-client instance. */
function serverNameTaken(ctx, serverName, exceptId) {
	for (const entry of ctx.loader.entries()) {
		if (entry.options.group) continue;
		if (entry.options.name !== "@deepseek-ai/dsh-mcp-client") continue;
		if (exceptId !== void 0 && normalizeEntryId(entry.id) === exceptId) continue;
		if ((entry.options.config ?? {}).serverName === serverName) return true;
	}
	return false;
}
/** Whether a loader entry id is already taken (across all plugins). */
function entryIdTaken(ctx, id, exceptId) {
	for (const entry of ctx.loader.entries()) if (normalizeEntryId(entry.id) === id && entry.id !== exceptId) return true;
	return false;
}
//#endregion
//#region lib/types/probe.js
/** Default probe budget in ms. */
const PROBE_TIMEOUT_MS = 8e3;
/**
* The child's environment for a stdio probe. The MCP SDK uses `env` as the
* child's FULL environment (it only inherits the host environment when `env`
* is undefined), and the panel defines `env` as "overrides" — so an empty or
* missing override map must become `undefined` (inherit), never `{}` (which
* would strip PATH and make npx-style commands unspawnable).
*/
function stdioEnv(overrides) {
	if (overrides === void 0 || Object.keys(overrides).length === 0) return void 0;
	return {
		...process.env,
		...overrides
	};
}
/** Run a connectivity probe against the given server config. */
async function probeServer(config, timeoutMs = PROBE_TIMEOUT_MS) {
	const started = Date.now();
	const finish = (result) => ({
		...result,
		latencyMs: Date.now() - started
	});
	const withTimeout = (promise) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(/* @__PURE__ */ new Error(`probe timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
	let client;
	try {
		const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
			import("@modelcontextprotocol/sdk/client/index.js"),
			import("@modelcontextprotocol/sdk/client/stdio.js"),
			import("@modelcontextprotocol/sdk/client/streamableHttp.js")
		]);
		client = new Client({
			name: "dsh-skills-mcp-group-manager-probe",
			version: "0.1.0"
		}, { capabilities: {} });
		let transport;
		if (config.transport === "stdio") transport = new StdioClientTransport({
			command: config.command ?? "",
			args: config.args,
			env: stdioEnv(config.env),
			cwd: config.cwd
		});
		else transport = new StreamableHTTPClientTransport(new URL(config.url ?? ""), { requestInit: { headers: config.headers ?? {} } });
		await withTimeout(client.connect(transport));
		const tools = await withTimeout(client.listTools());
		return finish({
			ok: true,
			toolCount: Array.isArray(tools?.tools) ? tools.tools.length : 0
		});
	} catch (error) {
		return finish({
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		});
	} finally {
		try {
			await client?.close();
		} catch {}
	}
}
//#endregion
//#region lib/types/index.js
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
*     single POST route `/plugins/dsh-skills-mcp-group-manager/rpc` with body
*     { method, args } → { ok, value } | { ok: false, error }. The error is
*     structured: { code, message, fields? } where `fields` carries
*     field-level validation messages for the form to display inline.
*
* Lifecycle: every side effect is fiber-scoped or explicitly disposed
* (store writes, tools.register, skills.registerProvider, webServer
* routes, ctx.on listeners). No live data is ever serialized: only scalar
* fields are extracted into fresh JSON.
*/
const name = "mcp-skill-manager";
const inject = [
	"skills",
	"tools",
	"agents",
	"loader"
];
/** Unique shadow provider name; the registry merges by skill name, not provider name. */
const SHADOW_PROVIDER_NAME = "skill-manager-filter";
/** Re-entrancy marker for the shadow provider's nested catalog pass. */
const catalogReentry = new AsyncLocalStorage();
/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ["webServer", "httpServer"];
/** Base path of the browser-half RPC route. */
const RPC_PATH = "/plugins/dsh-skills-mcp-group-manager/rpc";
/** Max RPC request body bytes. */
const MAX_RPC_BODY_BYTES = 65536;
/**
* Host half plugin.
*
* MUST stay synchronous: Cordis treats a prototype-bearing function as a
* constructor and ignores its returned promise, so an async apply would
* turn any post-await throw into an unhandled rejection that crashes the
* whole dsh process (observed as the service crash-restart "flicker").
*/
function apply(ctx, config = {}) {
	const store = createStateStore({
		dshHome: process.env.DSH_HOME,
		logger: ctx.logger
	});
	store.loadSync();
	const patchFile = resolvePatchPath(config);
	const shadowControls = /* @__PURE__ */ new Map();
	let writeChain = Promise.resolve();
	function applyAgentFilter(agent) {
		if (shadowControls.has(agent.id)) return;
		const skills = agent.ctx.get("skills");
		if (skills === void 0) return;
		let controlRef;
		const dispose = skills.registerProvider((control) => {
			controlRef = control;
			return {
				name: SHADOW_PROVIDER_NAME,
				async list(options) {
					if (catalogReentry.getStore() !== void 0) return [];
					const all = await catalogReentry.run({}, () => ctx.skills.list({
						cwd: options.cwd,
						signal: options.signal,
						scope: options.scope
					}));
					const enabled = enabledSkillNamesFor(store.get(), agent.id);
					return all.map((skill) => ({
						name: skill.name,
						description: skill.description,
						...skill.whenToUse !== void 0 ? { whenToUse: skill.whenToUse } : {},
						invocation: enabled.has(skill.name) ? skill.invocation : {
							modelInvocable: false,
							userInvocable: false
						},
						source: skill.source,
						provider: SHADOW_PROVIDER_NAME,
						...skill.resourceBase !== void 0 ? { resourceBase: skill.resourceBase } : {},
						rank: 0,
						locator: skill.name
					}));
				},
				async get(candidate, options) {
					if (catalogReentry.getStore() !== void 0) return void 0;
					controlRef?.invalidate();
					try {
						return await catalogReentry.run({}, () => ctx.skills.get(candidate.name, {
							cwd: options.cwd,
							signal: options.signal,
							scope: options.scope
						}));
					} finally {
						controlRef?.invalidate();
					}
				}
			};
		});
		shadowControls.set(agent.id, {
			control: controlRef,
			dispose
		});
	}
	function refreshSkillCatalogs() {
		for (const { control } of shadowControls.values()) control.invalidate();
	}
	/**
	* Pick the agent whose skill catalog the browser picker should display.
	* Prefers the requested session id; falls back to the first live agent.
	* Returns undefined when no live agent exists.
	*/
	function resolveCatalogAgent(sessionId) {
		let agents;
		try {
			agents = ctx.agents.list();
		} catch {
			return;
		}
		if (!Array.isArray(agents) || agents.length === 0) return void 0;
		if (typeof sessionId === "string" && sessionId.length > 0) {
			const found = agents.find((agent) => agent.id === sessionId);
			if (found !== void 0) return found;
		}
		return agents[0];
	}
	/**
	* Invalidate ONLY the catalog of the agent whose id equals the session id
	* (agent.id === sessionId). A session-override change affects exactly that
	* session; other agents keep their catalogs untouched. A session without a
	* live agent needs no invalidation — its override is read on first list().
	*/
	function refreshSkillCatalogFor(sessionId) {
		shadowControls.get(sessionId)?.control.invalidate();
	}
	/** Serialize one read-modify-write cycle; failures never poison the chain. */
	function withWriteLock(task) {
		const run = writeChain.then(task, task);
		writeChain = run.catch(() => {});
		return run;
	}
	/** Re-apply every dynamic effect after a state change. */
	function applyStateEffects() {
		refreshSkillCatalogs();
	}
	function requireGroup(state, id) {
		const group = groupById(state, id);
		if (group === void 0) throw new McpError("not-found", `group "${id}" does not exist`);
		return group;
	}
	/** Validate an add/update payload; throws McpError with field details. */
	function requireValidServer(id, config) {
		const fields = validateMcpConfig(id, config);
		if (Object.keys(fields).length > 0) throw new McpError("invalid-config", "Invalid MCP server configuration", fields);
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
	async function requireMcpTarget(id) {
		for (const entry of ctx.loader.entries()) {
			if (entry.options.group) continue;
			if (entry.options.name !== "@deepseek-ai/dsh-mcp-client") continue;
			if (normalizeEntryId(entry.id) === id) return;
		}
		if (patchEntryName(await readPatchList(patchFile), id) === "@deepseek-ai/dsh-mcp-client") return;
		throw new McpError("not-found", `No MCP server entry with id "${id}"`);
	}
	const api = {
		async stateGet() {
			return snapshotState(store.get());
		},
		/**
		* The browser half has no per-session context; when a live agent exists,
		* list through its scope so the shadow provider's catalog (the union of
		* the global and preset layers) is what the picker displays. Without a
		* live agent the global layer is listed as-is (empty when the host skill
		* discovery is disabled by a patch row).
		*/
		async skillsList(args) {
			const agent = resolveCatalogAgent(args?.sessionId);
			return { skills: (agent === void 0 ? await ctx.skills.list() : await ctx.skills.list({
				cwd: agent.session?.header?.cwd,
				scope: agent
			})).map((skill) => ({
				name: skill.name,
				description: skill.description,
				invocation: {
					modelInvocable: skill.invocation.modelInvocable,
					userInvocable: skill.invocation.userInvocable
				}
			})) };
		},
		async groupsCreate(args) {
			const nameArg = typeof args?.name === "string" ? args.name.trim() : "";
			if (nameArg.length === 0) throw new McpError("invalid-args", "group name must be a non-empty string");
			const id = randomUUID();
			await withWriteLock(async () => {
				const state = store.get();
				await store.update({ groups: [...state.groups, {
					id,
					name: nameArg,
					enabled: true,
					skills: []
				}] });
				applyStateEffects();
			});
			return { id };
		},
		async groupsRename(args) {
			const { id } = args ?? {};
			const nameArg = typeof args?.name === "string" ? args.name.trim() : "";
			if (typeof id !== "string" || nameArg.length === 0) throw new McpError("invalid-args", "rename requires { id, name }");
			await withWriteLock(async () => {
				const state = store.get();
				requireGroup(state, id);
				await store.update({ groups: state.groups.map((group) => group.id === id ? {
					...group,
					name: nameArg
				} : group) });
				applyStateEffects();
			});
			return {
				id,
				name: nameArg
			};
		},
		async groupsDelete(args) {
			const { id } = args ?? {};
			if (typeof id !== "string") throw new McpError("invalid-args", "delete requires { id }");
			await withWriteLock(async () => {
				const state = store.get();
				requireGroup(state, id);
				await store.update({ groups: state.groups.filter((group) => group.id !== id) });
				applyStateEffects();
			});
			return { id };
		},
		async groupsSetEnabled(args) {
			const { id, enabled } = args ?? {};
			if (typeof id !== "string" || typeof enabled !== "boolean") throw new McpError("invalid-args", "setEnabled requires { id, enabled: boolean }");
			await withWriteLock(async () => {
				const state = store.get();
				requireGroup(state, id);
				await store.update({ groups: state.groups.map((group) => group.id === id ? {
					...group,
					enabled
				} : group) });
				applyStateEffects();
			});
			return {
				id,
				enabled
			};
		},
		async groupsAddSkill(args) {
			const { id } = args ?? {};
			const names = Array.isArray(args?.skills) ? args.skills.filter((s) => typeof s === "string" && s.length > 0) : typeof args?.skill === "string" && args.skill.length > 0 ? [args.skill] : [];
			if (typeof id !== "string" || names.length === 0) throw new McpError("invalid-args", "addSkill requires { id, skill } or { id, skills: [...] }");
			return {
				id,
				skills: [...await withWriteLock(async () => {
					const next = addSkillsToGroup(store.get(), id, names);
					if (next !== store.get()) {
						await store.update({ groups: next.groups });
						applyStateEffects();
					}
					return requireGroup(store.get(), id).skills;
				})]
			};
		},
		async groupsRemoveSkill(args) {
			const { id } = args ?? {};
			const names = Array.isArray(args?.skills) ? args.skills.filter((s) => typeof s === "string" && s.length > 0) : typeof args?.skill === "string" && args.skill.length > 0 ? [args.skill] : [];
			if (typeof id !== "string" || names.length === 0) throw new McpError("invalid-args", "removeSkill requires { id, skill } or { id, skills: [...] }");
			return {
				id,
				skills: [...await withWriteLock(async () => {
					const next = removeSkillsFromGroup(store.get(), id, names);
					if (next !== store.get()) {
						await store.update({ groups: next.groups });
						applyStateEffects();
					}
					return requireGroup(store.get(), id).skills;
				})]
			};
		},
		async sessionGet(args) {
			const { sessionId } = args ?? {};
			if (typeof sessionId !== "string" || sessionId.length === 0) throw new McpError("invalid-args", "session.get requires { sessionId }");
			const state = store.get();
			const known = new Set(state.groups.map((group) => group.id));
			const entry = state.sessions[sessionId];
			const override = entry === void 0 ? null : { enabledGroupIds: entry.enabledGroupIds.filter((id) => known.has(id)) };
			return {
				override,
				effectiveGroupIds: override?.enabledGroupIds ?? state.groups.filter((group) => group.enabled).map((group) => group.id)
			};
		},
		async sessionSet(args) {
			const { sessionId, enabledGroupIds } = args ?? {};
			if (typeof sessionId !== "string" || sessionId.length === 0 || enabledGroupIds !== null && (!Array.isArray(enabledGroupIds) || enabledGroupIds.some((id) => typeof id !== "string"))) throw new McpError("invalid-args", "session.set requires { sessionId, enabledGroupIds: string[] | null }");
			await withWriteLock(async () => {
				const state = store.get();
				if (enabledGroupIds !== null) {
					for (const id of enabledGroupIds) if (groupById(state, id) === void 0) throw new McpError("not-found", `group "${id}" does not exist`);
				}
				const sessions = { ...state.sessions };
				if (enabledGroupIds === null) delete sessions[sessionId];
				else sessions[sessionId] = { enabledGroupIds: [...new Set(enabledGroupIds)] };
				await store.update({ sessions });
				refreshSkillCatalogFor(sessionId);
			});
			return api.sessionGet({ sessionId });
		},
		async mcpList() {
			const rows = await readPatchList(patchFile);
			return {
				servers: listMcpServers(ctx, (id) => isUserManaged(rows, id), ctx.logger),
				patch: {
					path: patchFile,
					exists: existsSync(patchFile)
				}
			};
		},
		async mcpToggle(args) {
			const { id, enabled } = args ?? {};
			if (typeof id !== "string" || typeof enabled !== "boolean") throw new McpError("invalid-args", "toggle requires { id, enabled: boolean }");
			await withWriteLock(async () => {
				await requireMcpTarget(id);
				await editPatchList(patchFile, (rows) => setMcpEnabled(rows, id, enabled));
			});
			return {
				id,
				enabled
			};
		},
		async mcpAdd(args) {
			const id = typeof args?.id === "string" ? args.id.trim() : "";
			const config = pickServerConfig(args ?? {});
			requireValidServer(id, config);
			await withWriteLock(async () => {
				if (entryIdTaken(ctx, id)) throw new McpError("duplicate-id", `Entry id "${id}" is already in use`);
				if (isUserManaged(await readPatchList(patchFile), id)) throw new McpError("duplicate-id", `Entry id "${id}" is already in use`);
				if (serverNameTaken(ctx, config.serverName)) throw new McpError("duplicate-server-name", `serverName "${config.serverName}" is already used by another MCP server`);
				await editPatchList(patchFile, (current) => addMcpRow(current, id, config));
			});
			return { id };
		},
		async mcpUpdate(args) {
			const id = typeof args?.id === "string" ? args.id.trim() : "";
			const config = pickServerConfig(args ?? {});
			requireValidServer(id, config);
			await withWriteLock(async () => {
				await requireMcpTarget(id);
				if (serverNameTaken(ctx, config.serverName, id)) throw new McpError("duplicate-server-name", `serverName "${config.serverName}" is already used by another MCP server`);
				await editPatchList(patchFile, (rows) => updateMcpConfig(rows, id, config));
			});
			return { id };
		},
		async mcpRemove(args) {
			const { id } = args ?? {};
			if (typeof id !== "string") throw new McpError("invalid-args", "remove requires { id }");
			await withWriteLock(async () => {
				await requireMcpTarget(id);
				await editPatchList(patchFile, (rows) => removeMcpRow(rows, id));
			});
			return { id };
		},
		async mcpProbe(args) {
			let config;
			if (args?.config !== null && typeof args?.config === "object") config = pickServerConfig(args.config);
			else {
				const id = typeof args?.id === "string" ? args.id : "";
				for (const entry of ctx.loader.entries()) {
					if (entry.options.group) continue;
					if (entry.options.name !== "@deepseek-ai/dsh-mcp-client") continue;
					if (normalizeEntryId(entry.id) === id) {
						config = toServerConfig(entry.options.config);
						break;
					}
				}
				if (config === void 0) throw new McpError("not-found", `No MCP server entry with id "${id}"`);
			}
			return probeServer(config);
		}
	};
	const toolDisposers = [];
	const tool = (definition) => {
		toolDisposers.push(ctx.tools.register({
			...definition,
			parameters: parameterSchema(definition.parameters),
			...definition.output !== void 0 ? { output: {
				...definition.output,
				schema: valueSchema(definition.output.schema)
			} } : {}
		}));
	};
	tool({
		name: "manager_groups_list",
		description: "List every skill group with its enabled flag and member skill names.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { groups: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "string",
								required: true
							},
							name: {
								type: "string",
								required: true
							},
							enabled: {
								type: "boolean",
								required: true
							},
							skills: {
								type: "array",
								required: true,
								items: { type: "string" }
							}
						}
					}
				} }
			},
			render: (args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute() {
			return { groups: (await api.stateGet()).groups };
		}
	});
	tool({
		name: "manager_groups_create",
		description: "Create a new skill group (enabled by default, empty member list). Returns the stable group id.",
		parameters: { name: {
			type: "string",
			required: true,
			description: "Display name of the new group."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { id: {
					type: "string",
					required: true
				} }
			},
			render: (args, value) => [{
				type: "text",
				text: `Group "${args.name}" created (id ${value.id}).`
			}]
		},
		async execute(args) {
			return api.groupsCreate(args);
		}
	});
	tool({
		name: "manager_groups_delete",
		description: "Delete a skill group by id. Its skills are not removed from other groups.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Stable group id."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { id: {
					type: "string",
					required: true
				} }
			},
			render: (args) => [{
				type: "text",
				text: `Group ${args.id} deleted.`
			}]
		},
		async execute(args) {
			return api.groupsDelete(args);
		}
	});
	tool({
		name: "manager_groups_rename",
		description: "Rename a skill group by id.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Stable group id."
			},
			name: {
				type: "string",
				required: true,
				description: "New display name."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					name: {
						type: "string",
						required: true
					}
				}
			},
			render: (args) => [{
				type: "text",
				text: `Group ${args.id} renamed to "${args.name}".`
			}]
		},
		async execute(args) {
			return api.groupsRename(args);
		}
	});
	tool({
		name: "manager_groups_set_enabled",
		description: "Enable or disable a skill group. Disabling removes its skills from the injected catalog; enabling re-injects them (union-deduped across enabled groups).",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Stable group id."
			},
			enabled: {
				type: "boolean",
				required: true,
				description: "New enabled state."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					enabled: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (args) => [{
				type: "text",
				text: `Group ${args.id} ${args.enabled ? "enabled" : "disabled"}.`
			}]
		},
		async execute(args) {
			return api.groupsSetEnabled(args);
		}
	});
	tool({
		name: "manager_groups_add_skill",
		description: "Add a skill name to a group. The same skill may exist in several groups; injection dedups by union.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Stable group id."
			},
			skill: {
				type: "string",
				required: true,
				description: "Skill name (kebab-case) to add."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					skills: {
						type: "array",
						required: true,
						items: { type: "string" }
					}
				}
			},
			render: (args, value) => [{
				type: "text",
				text: `Group ${args.id} now has skills: ${value.skills.join(", ")}.`
			}]
		},
		async execute(args) {
			return api.groupsAddSkill(args);
		}
	});
	tool({
		name: "manager_groups_remove_skill",
		description: "Remove a skill name from a group.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Stable group id."
			},
			skill: {
				type: "string",
				required: true,
				description: "Skill name to remove."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					skills: {
						type: "array",
						required: true,
						items: { type: "string" }
					}
				}
			},
			render: (args, value) => [{
				type: "text",
				text: `Group ${args.id} now has skills: ${value.skills.join(", ")}.`
			}]
		},
		async execute(args) {
			return api.groupsRemoveSkill(args);
		}
	});
	tool({
		name: "manager_skills_list",
		description: "List every skill currently available in the global catalog (name, description, invocation policy) for picking group members.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { skills: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							name: {
								type: "string",
								required: true
							},
							description: {
								type: "string",
								required: true
							},
							invocation: {
								type: "object",
								additionalProperties: false,
								properties: {
									modelInvocable: {
										type: "boolean",
										required: true
									},
									userInvocable: {
										type: "boolean",
										required: true
									}
								}
							}
						}
					}
				} }
			},
			render: (args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute(args, exec) {
			return api.skillsList({ sessionId: exec?.agent?.id });
		}
	});
	/**
	* Resolve the calling session id from the tool execution context. Both
	* session tools are scoped to the caller's own session (exec.agent.id);
	* without an agent context there is no session to read or write.
	*/
	function requireSessionId(exec) {
		const sessionId = exec?.agent?.id;
		if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("session tools require the calling agent context (exec.agent.id)");
		return sessionId;
	}
	tool({
		name: "manager_session_get",
		description: "Show this session's skill-group selection: the explicit per-session override (null = following the global group toggles) and the effective enabled group ids.",
		parameters: {},
		output: {
			schema: sessionStateOutput,
			render: (args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute(args, exec) {
			return api.sessionGet({ sessionId: requireSessionId(exec) });
		}
	});
	tool({
		name: "manager_session_set",
		description: "Set this session's skill-group selection: enabledGroupIds lists the groups injected into THIS session only (empty array = inject none); pass null to follow the global group toggles again. Other sessions are unaffected.",
		parameters: { enabledGroupIds: {
			oneOf: [{
				type: "array",
				items: { type: "string" }
			}, { type: "null" }],
			required: true,
			description: "Group ids enabled for this session, or null to follow the global toggles."
		} },
		output: {
			schema: sessionStateOutput,
			render: (args, value) => {
				const state = value;
				return [{
					type: "text",
					text: state.override === null ? "This session follows the global group toggles." : `This session enables groups: ${state.override.enabledGroupIds.join(", ") || "(none)"}.`
				}];
			}
		},
		async execute(args, exec) {
			return api.sessionSet({
				sessionId: requireSessionId(exec),
				enabledGroupIds: args.enabledGroupIds
			});
		}
	});
	tool({
		name: "manager_mcp_list",
		description: "List every MCP server (loader composition merged with the user patch layer) with entry id, enabled flag, fiber phase, live tool count, and whether it is user-managed. The single source of truth is the profile cordis.patch.yml.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					servers: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: {
									type: "string",
									required: true
								},
								serverName: {
									type: "string",
									required: true
								},
								transport: {
									type: "string",
									required: true
								},
								enabled: {
									type: "boolean",
									required: true
								},
								fiberPhase: {
									oneOf: [{ type: "string" }, { type: "null" }],
									required: true
								},
								toolCount: {
									type: "number",
									required: true
								},
								userManaged: {
									type: "boolean",
									required: true
								}
							}
						}
					},
					patch: {
						type: "object",
						required: true,
						additionalProperties: false,
						properties: {
							path: {
								type: "string",
								required: true
							},
							exists: {
								type: "boolean",
								required: true
							}
						}
					}
				}
			},
			render: (args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute() {
			return api.mcpList();
		}
	});
	tool({
		name: "manager_mcp_toggle",
		description: "Enable or disable an MCP server by editing the profile cordis.patch.yml; the harness hot-reloads the tree, so the server really starts/stops. Bundle-defined servers get an {id, name, disabled} override row appended.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Loader entry id of the MCP server."
			},
			enabled: {
				type: "boolean",
				required: true,
				description: "New enabled state."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					enabled: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (args) => [{
				type: "text",
				text: `MCP server "${args.id}" ${args.enabled ? "enabled" : "disabled"}.`
			}]
		},
		async execute(args) {
			return api.mcpToggle(args);
		}
	});
	tool({
		name: "manager_mcp_add",
		description: "Add a new MCP server by appending an insert row to the profile cordis.patch.yml; the harness hot-reloads and connects the server. stdio needs command; streamable-http needs url.",
		parameters: mcpConfigParams,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { id: {
					type: "string",
					required: true
				} }
			},
			render: (args) => [{
				type: "text",
				text: `MCP server "${args.id}" added.`
			}]
		},
		async execute(args) {
			return api.mcpAdd(args);
		}
	});
	tool({
		name: "manager_mcp_update",
		description: "Replace the config of an existing MCP server entry (patch-file edit, hot-reloaded). Bundle-defined entries get a config override row appended.",
		parameters: mcpConfigParams,
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { id: {
					type: "string",
					required: true
				} }
			},
			render: (args) => [{
				type: "text",
				text: `MCP server "${args.id}" updated.`
			}]
		},
		async execute(args) {
			return api.mcpUpdate(args);
		}
	});
	tool({
		name: "manager_mcp_remove",
		description: "Remove every patch-file trace of an MCP server entry (insert rows and disable/config overrides); the harness hot-reloads and disconnects it.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Loader entry id of the MCP server."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { id: {
					type: "string",
					required: true
				} }
			},
			render: (args) => [{
				type: "text",
				text: `MCP server "${args.id}" removed.`
			}]
		},
		async execute(args) {
			return api.mcpRemove(args);
		}
	});
	const rpcMethods = {
		"manager.state.get": async () => api.stateGet(),
		"manager.skills.list": async (args) => api.skillsList(args),
		"manager.groups.create": async (args) => api.groupsCreate(args),
		"manager.groups.rename": async (args) => api.groupsRename(args),
		"manager.groups.delete": async (args) => api.groupsDelete(args),
		"manager.groups.setEnabled": async (args) => api.groupsSetEnabled(args),
		"manager.groups.addSkill": async (args) => api.groupsAddSkill(args),
		"manager.groups.removeSkill": async (args) => api.groupsRemoveSkill(args),
		"manager.session.get": async (args) => api.sessionGet(args),
		"manager.session.set": async (args) => api.sessionSet(args),
		"manager.mcp.list": async () => api.mcpList(),
		"manager.mcp.toggle": async (args) => api.mcpToggle(args),
		"manager.mcp.add": async (args) => api.mcpAdd(args),
		"manager.mcp.update": async (args) => api.mcpUpdate(args),
		"manager.mcp.remove": async (args) => api.mcpRemove(args),
		"manager.mcp.probe": async (args) => api.mcpProbe(args)
	};
	async function readJsonBody(req) {
		const chunks = [];
		let received = 0;
		for await (const chunk of req) {
			received += chunk.byteLength;
			if (received > MAX_RPC_BODY_BYTES) throw new Error("request body too large");
			chunks.push(chunk);
		}
		if (chunks.length === 0) return {};
		const text = Buffer.concat(chunks).toString("utf8");
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
		return parsed;
	}
	function sendJson(res, status, payload) {
		const body = JSON.stringify(payload);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		});
		res.end(body);
	}
	const LOOPBACK_ORIGIN_HOSTS = /* @__PURE__ */ new Set([
		"127.0.0.1",
		"localhost",
		"[::1]",
		"::1"
	]);
	/**
	* CSRF guard: allow the request only when it carries no Origin header
	* (same-origin form, or a non-browser caller like curl/another plugin) or
	* its Origin names a loopback host (the default bind posture).
	*/
	function isAllowedOrigin(req) {
		const origin = req.headers.origin;
		if (origin === void 0 || origin === "") return true;
		try {
			const url = new URL(origin);
			if (url.username !== "" || url.password !== "") return false;
			return LOOPBACK_ORIGIN_HOSTS.has(url.hostname.toLowerCase());
		} catch {
			return false;
		}
	}
	let webRegistered = false;
	const registerWebSurface = () => {
		if (webRegistered) return;
		const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
		if (webServer === void 0) return;
		webRegistered = true;
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: RPC_PATH,
			handler: async (req, res) => {
				if (!isAllowedOrigin(req)) {
					sendJson(res, 403, {
						ok: false,
						error: {
							code: "forbidden-origin",
							message: "cross-origin requests are not allowed"
						}
					});
					return;
				}
				try {
					const body = await readJsonBody(req);
					const method = body.method;
					const handler = typeof method === "string" ? rpcMethods[method] : void 0;
					if (handler === void 0) {
						sendJson(res, 400, {
							ok: false,
							error: {
								code: "unknown-method",
								message: `unknown method ${JSON.stringify(method)}`
							}
						});
						return;
					}
					sendJson(res, 200, {
						ok: true,
						value: await handler(body.args ?? {})
					});
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					sendJson(res, 200, {
						ok: false,
						error: {
							code: typeof err.code === "string" ? err.code : "internal",
							message: err.message,
							...err.fields !== void 0 ? { fields: err.fields } : {}
						}
					});
				}
			}
		}), "mcp-skill-manager: rpc route");
	};
	registerWebSurface();
	ctx.on("internal/service", (serviceName) => {
		if (WEB_SERVER_KEYS.includes(serviceName)) registerWebSurface();
	});
	ctx.effect(() => () => {
		for (const dispose of toolDisposers) dispose();
		toolDisposers.length = 0;
		for (const { dispose } of shadowControls.values()) dispose();
		shadowControls.clear();
	}, "mcp-skill-manager: agent-layer cleanup");
	for (const agent of ctx.agents.list()) applyAgentFilter(agent);
	ctx.on("agent/created", ({ agent }) => {
		applyAgentFilter(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		shadowControls.delete(agent.id);
	});
}
//#endregion
export { apply, inject, name };
