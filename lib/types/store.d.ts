import type { Logger, ManagerState, StateStore } from './types.ts';
/** Resolve the plugin-owned state directory under the harness home. */
export declare function resolveStateDir(dshHome: string | undefined): string;
/**
 * Synchronous atomic file write (temp file + rename, parent directory
 * created). Shared by the state store and the cordis.patch.yml editor so both
 * persist through the same crash-safe path.
 */
export declare function writeFileAtomicSync(file: string, content: string): void;
/** Normalize an untrusted parsed document into the state shape. */
export declare function normalizeState(raw: unknown): ManagerState;
/** Create the state store. */
export declare function createStateStore(options?: {
    dshHome?: string | undefined;
    logger?: Logger;
}): StateStore;
//# sourceMappingURL=store.d.ts.map