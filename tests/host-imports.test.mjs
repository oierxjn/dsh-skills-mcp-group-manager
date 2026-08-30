/**
 * TDD tests for the single-command install requirement.
 *
 * `dsh plugin add` links the package into the profile; Node resolves the
 * plugin's imports from the source directory, which for a `link:` install has
 * no node_modules. The host half therefore keeps every runtime dependency
 * behind a lazy `import()` (js-yaml in src/patch.ts, the MCP SDK in
 * src/probe.ts) so plugin boot and the groups half never hard-require them —
 * only the MCP features degrade (with a clear error) when the dependency is
 * missing. This static test guards that the external surface stays limited to
 * exactly those two packages (registry installs get them via
 * package.json `dependencies`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/** External packages the host half may import (lazily). */
const ALLOWED_EXTERNAL = new Set(['js-yaml', '@modelcontextprotocol/sdk']);

const srcDir = new URL('../src/', import.meta.url);
// Host half only: lib/client.js is the hand-written browser bundle (its own
// contract tests read it directly); src/*.ts is the host half's source.
const hostFiles = readdirSync(srcDir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => [name, readFileSync(new URL(name, srcDir), 'utf8')]);

/** Package root of a specifier (`@scope/pkg/sub` → `@scope/pkg`). */
function packageRoot(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function externalImports(code) {
  const found = [];
  // static: `import ... from '...'` / `import '...'` (dynamic import( is excluded
  // by the required whitespace + non-`(` character class)
  for (const match of code.matchAll(/^\s*import\s+[^'"(]*['"]([^'"]+)['"]/gm)) found.push(match[1]);
  // dynamic: `import('...')`
  for (const match of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]);
  return found.filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'));
}

for (const [name, code] of hostFiles) {
  test(`host half ${name}: external imports limited to the allowlist`, () => {
    const external = externalImports(code);
    const unexpected = external.filter((spec) => !ALLOWED_EXTERNAL.has(packageRoot(spec)));
    assert.deepEqual(unexpected, [], `unexpected external imports in ${name}: ${unexpected.join(', ')}`);
  });
}

test('host half has no require() of external packages', () => {
  for (const [name, code] of hostFiles) {
    const requires = [...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)]
      .map((m) => m[1])
      .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'));
    assert.deepEqual(requires, [], `no external require() in ${name} (found: ${requires.join(', ')})`);
  }
});

test('runtime dependencies stay lazy (no static import of the allowlist)', () => {
  for (const [name, code] of hostFiles) {
    const staticExternal = [...code.matchAll(/^\s*import\s+[^'"(]*['"]([^'"]+)['"]/gm)]
      .map((m) => m[1])
      .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'));
    assert.deepEqual(staticExternal, [], `${name} must lazy-load its dependencies (found static: ${staticExternal.join(', ')})`);
  }
});
