import type { McpServerConfig, PatchRow } from './types.ts';
/**
 * Resolve the user patch file for the target profile (explicit path wins).
 */
export declare function resolvePatchPath(options?: {
    patchFile?: unknown;
    profile?: unknown;
    dshHome?: string | undefined;
}): string;
/** Read and parse the patch file; a missing file yields an empty list. */
export declare function readPatchList(file: string): Promise<PatchRow[]>;
/** Serialize and write the patch list atomically, preserving `!!js` expressions. */
export declare function writePatchList(file: string, rows: PatchRow[]): Promise<void>;
/** Apply an edit function and persist; returns the rows after the edit. */
export declare function editPatchList(file: string, edit: (rows: PatchRow[]) => PatchRow[] | Promise<PatchRow[]>): Promise<PatchRow[]>;
/** Whether any row (top-level or inside an insert list) carries the id. */
export declare function patchHasId(rows: PatchRow[], id: string): boolean;
/**
 * Append a new MCP server as an id-less insert row (the only patch form that
 * creates brand-new entries in the composed tree).
 */
export declare function addMcpRow(rows: PatchRow[], id: string, config: McpServerConfig): PatchRow[];
/**
 * Remove every trace of an entry id: top-level rows and items inside insert
 * lists; an insert row that becomes empty is dropped.
 */
export declare function removeMcpRow(rows: PatchRow[], id: string): PatchRow[];
/**
 * Enable/disable an entry. When the entry is defined in the user patch
 * (top-level or insert item) its own flag flips; otherwise a bundle-defined
 * entry is overridden with a matching `{id, name, disabled}` row (the patch
 * layer later in the stack wins).
 */
export declare function setMcpEnabled(rows: PatchRow[], id: string, enabled: boolean): PatchRow[];
/**
 * Replace the config of an existing entry. When the entry is not in the user
 * patch (bundle-defined), a matching override row is appended.
 */
export declare function updateMcpConfig(rows: PatchRow[], id: string, config: McpServerConfig): PatchRow[];
/** Whether an entry id is present in the user patch (removable/editable). */
export declare function isUserManaged(rows: PatchRow[], id: string): boolean;
/**
 * The plugin name recorded for the entry id in the user patch (top-level row
 * or insert item), or undefined when the id is not in the patch. Callers use
 * it to verify that a patch row with a given id really is an MCP client entry
 * before mutating it — the id alone is not proof (any plugin can own a row).
 */
export declare function patchEntryName(rows: PatchRow[], id: string): string | undefined;
//# sourceMappingURL=patch.d.ts.map