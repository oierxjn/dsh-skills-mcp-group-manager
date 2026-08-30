export declare const name = "mcp-skill-manager";
export declare const inject: string[];
/**
 * Host half plugin.
 *
 * MUST stay synchronous: Cordis treats a prototype-bearing function as a
 * constructor and ignores its returned promise, so an async apply would
 * turn any post-await throw into an unhandled rejection that crashes the
 * whole dsh process (observed as the service crash-restart "flicker").
 */
export declare function apply(ctx: HostPluginContext, config?: {
    patchFile?: unknown;
    profile?: unknown;
}): void;
//# sourceMappingURL=index.d.ts.map