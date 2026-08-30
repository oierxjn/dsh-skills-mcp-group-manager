/**
 * Unit tests for the cordis.patch.yml editor (src/patch.ts).
 * Uses a temp directory as the profile home; never touches ~/.dsh.
 *
 * Run: node --test tests/
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMcpRow,
  editPatchList,
  isUserManaged,
  patchHasId,
  readPatchList,
  removeMcpRow,
  resolvePatchPath,
  setMcpEnabled,
  updateMcpConfig,
  writePatchList,
} from '../src/patch.ts';

const STDIO_CONFIG = { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'server-github'] };

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'msm-patch-'));
}

test('resolvePatchPath: explicit patchFile wins, profile selects the directory', () => {
  assert.equal(resolvePatchPath({ patchFile: '/x/y.yml' }), '/x/y.yml');
  assert.equal(
    resolvePatchPath({ profile: 'web', dshHome: '/home' }),
    join('/home', 'profiles', 'web', 'cordis.patch.yml'),
  );
  assert.equal(
    resolvePatchPath({ dshHome: '/home' }),
    join('/home', 'profiles', 'web', 'cordis.patch.yml'),
    'profile defaults to web',
  );
});

test('readPatchList: missing or empty file yields an empty list', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'cordis.patch.yml');
    assert.deepEqual(await readPatchList(file), []);
    await writeFile(file, '  \n', 'utf8');
    assert.deepEqual(await readPatchList(file), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readPatchList: rejects a non-array top level', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'cordis.patch.yml');
    await writeFile(file, 'foo: bar\n', 'utf8');
    await assert.rejects(() => readPatchList(file), /top-level array/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('write/read round-trip: addMcpRow appends an id-less insert row', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'cordis.patch.yml');
    await writePatchList(file, addMcpRow([], 'mcp-github', STDIO_CONFIG));
    const rows = await readPatchList(file);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].insert, [{ id: 'mcp-github', name: '@deepseek-ai/dsh-mcp-client', config: STDIO_CONFIG }]);
    assert.ok(patchHasId(rows, 'mcp-github'));
    assert.ok(isUserManaged(rows, 'mcp-github'));
    assert.ok(!isUserManaged(rows, 'other'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('setMcpEnabled: flips the flag on an insert item in place', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'cordis.patch.yml');
    await editPatchList(file, (rows) => setMcpEnabled(addMcpRow(rows, 'mcp-github', STDIO_CONFIG), 'mcp-github', false));
    let rows = await readPatchList(file);
    assert.equal(rows[0].insert[0].disabled, true);
    await editPatchList(file, (next) => setMcpEnabled(next, 'mcp-github', true));
    rows = await readPatchList(file);
    assert.equal(rows[0].insert[0].disabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('setMcpEnabled: bundle-defined entry gets an override row appended', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'cordis.patch.yml');
    // 'bundle-server' is NOT in the patch: disabling appends {id, name, disabled}.
    await editPatchList(file, (rows) => setMcpEnabled(rows, 'bundle-server', false));
    let rows = await readPatchList(file);
    assert.deepEqual(rows, [{ id: 'bundle-server', name: '@deepseek-ai/dsh-mcp-client', disabled: true }]);
    // Re-enabling flips the same override row.
    await editPatchList(file, (next) => setMcpEnabled(next, 'bundle-server', true));
    rows = await readPatchList(file);
    assert.deepEqual(rows, [{ id: 'bundle-server', name: '@deepseek-ai/dsh-mcp-client', disabled: false }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateMcpConfig: replaces config in place; unknown id appends an override row', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'cordis.patch.yml');
    await editPatchList(file, (rows) => addMcpRow(rows, 'mcp-github', STDIO_CONFIG));
    const nextConfig = { serverName: 'github', transport: 'streamable-http', url: 'https://x/mcp' };
    await editPatchList(file, (rows) => updateMcpConfig(rows, 'mcp-github', nextConfig));
    let rows = await readPatchList(file);
    assert.deepEqual(rows[0].insert[0].config, nextConfig);
    // Bundle-defined entry: an override row carrying the new config.
    await editPatchList(file, (rows2) => updateMcpConfig(rows2, 'bundle-server', nextConfig));
    rows = await readPatchList(file);
    assert.deepEqual(rows[1], { id: 'bundle-server', name: '@deepseek-ai/dsh-mcp-client', config: nextConfig });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('removeMcpRow: drops top-level rows and insert items; empty insert rows go away', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'cordis.patch.yml');
    await editPatchList(file, (rows) => {
      let next = addMcpRow(rows, 'mcp-a', STDIO_CONFIG);
      next = addMcpRow(next, 'mcp-b', STDIO_CONFIG);
      return setMcpEnabled(next, 'bundle-server', false);
    });
    await editPatchList(file, (rows) => removeMcpRow(removeMcpRow(rows, 'mcp-a'), 'bundle-server'));
    const rows = await readPatchList(file);
    assert.equal(rows.length, 1, 'only the mcp-b insert row survives');
    assert.equal(rows[0].insert[0].id, 'mcp-b');
    assert.ok(!patchHasId(rows, 'mcp-a'));
    assert.ok(!patchHasId(rows, 'bundle-server'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('!!js expressions survive a write/read round-trip', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'cordis.patch.yml');
    const config = { serverName: 'srv', transport: 'streamable-http', url: { __jsExpr: "process.env['MCP_URL']" } };
    await writePatchList(file, addMcpRow([], 'mcp-srv', config));
    const content = await readFile(file, 'utf8');
    assert.ok(content.includes('!!js'), 'serialized file uses the !!js tag');
    const rows = await readPatchList(file);
    assert.deepEqual(rows[0].insert[0].config.url, { __jsExpr: "process.env['MCP_URL']" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writePatchList: atomic write leaves no temp files and creates the directory', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'nested', 'cordis.patch.yml');
    await writePatchList(file, addMcpRow([], 'mcp-a', STDIO_CONFIG));
    const names = await readdir(join(dir, 'nested'));
    assert.deepEqual(names, ['cordis.patch.yml'], 'no leftover .tmp files');
    // An empty list serializes as an empty array.
    await writePatchList(file, []);
    assert.deepEqual(await readPatchList(file), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
