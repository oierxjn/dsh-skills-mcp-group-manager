/**
 * Build config for the dsh-skills-mcp-group-manager bundle plugin.
 *
 * Mirrors the official two-face chain:
 *  1. `tsc -p tsconfig.json` emits the Node half `lib/types/*.{js,d.ts,map}`;
 *     `tsc -p tsconfig.client.json` emits the browser half
 *     `lib/types/client/index.js` + declaration.
 *  2. tsdown bundles the Node half into a single ESM `lib/index.js` (the
 *     Loader's import target) and the browser half into the classic
 *     client-modules script `lib/client.js`
 *     (`window.__ModuleLoader__.load({ id, factory })`).
 *
 * Node-face external policy: production dependencies stay external
 * (real-install imports, preserving the lazy `import('js-yaml')` /
 * `import('@modelcontextprotocol/sdk')` behavior); everything else non-builtin
 * inlines. Client-face external policy: only the loader module-table rows the
 * bundle actually requires stay external (`react`); everything else inlines.
 */
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { defineConfig } from 'tsdown'

interface Manifest {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as Manifest

const production = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])

/** Package root of a specifier (`@scope/pkg/sub` → `@scope/pkg`). */
function packageRoot(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] ?? specifier
}

const isProductionDependency = (specifier: string): boolean => production.has(packageRoot(specifier))

/** Client module-table rows this bundle requires from the loader. */
const clientExternals = new Set(['react'])
const isClientRequested = (specifier: string): boolean => clientExternals.has(specifier)

const nodeFace = {
  name: pkg.name,
  entry: 'lib/types/index.js',
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    // The Node half runs from a real install: a production dependency is on
    // disk there and stays an import, everything else inlines.
    neverBundle: isProductionDependency,
    alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
  },
} as const

const clientFace = {
  name: `${pkg.name}/client`,
  entry: { client: 'lib/types/client/index.js' },
  // Browser bundle lands next to the node half (single lib/ artifact dir; the
  // entryFileNames pin keeps it exactly lib/client.js). clean must stay off —
  // a default clean would wipe the node-half output emitted above.
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // Anything NOT requested from the loader module table must inline (a
    // require() the table cannot answer is a guaranteed runtime throw).
    neverBundle: isClientRequested,
    alwaysBundle: (specifier: string) => !isClientRequested(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} as const

export default defineConfig([nodeFace, clientFace])