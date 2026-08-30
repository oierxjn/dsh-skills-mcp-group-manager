/**
 * Host-face build for the dsh-skills-mcp-group-manager bundle plugin.
 *
 * Mirrors the official host chain: `tsc` emits `lib/types/*.{js,d.ts,map}`
 * from `src/*.ts`, then tsdown bundles the `lib/types/index.js` entry into a
 * single ESM `lib/index.js` (the Loader's import target). Production
 * dependencies stay external (real-install imports, preserving the lazy
 * `import('js-yaml')` / `import('@modelcontextprotocol/sdk')` behavior);
 * everything else non-builtin is inlined.
 */
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { defineConfig } from 'tsdown'

interface Manifest {
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

export default defineConfig({
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
})