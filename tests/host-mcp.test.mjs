/**
 * Integration tests for the MCP mutation API (manager.mcp.*) of the host half.
 *
 * Guards the 0.4.0 patch-file semantics:
 *  - a mutation target must BE an MCP client entry (loader entry or a patch
 *    row whose recorded plugin name is `dsh-mcp-client`) — the id alone is
 *    not proof, and an unguarded remove/toggle would delete or override rows
 *    of unrelated plugins;
 *  - tool output values match their registered output schema (the host may
 *    validate tool results; a return value outside the schema fails calls).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { apply } from '../src/index.ts';
import { writePatchList, readPatchList } from '../src/patch.ts';
import { MCP_CLIENT_PACKAGE } from '../src/status.ts';

/** Fake loader entry (the subset of the composed-tree API the plugin reads). */
function loaderEntry(id, name, config) {
  return { id, options: { name, config }, disabled: false };
}

/** Minimal fake ctx; `entries` is swapped per test. */
function fakeCtx() {
  const tools = [];
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    tools: {
      register(def) { tools.push(def); return () => {}; },
      schemas() { return []; },
    },
    skills: {
      registerProvider() { return () => {}; },
      async list() { return []; },
      async get() { return undefined; },
    },
    agents: { list() { return []; } },
    loader: { entries() { return []; } },
    on() { return () => {}; },
    effect() { return () => {}; },
    get() { return undefined; },
  };
  return { ctx, tools };
}

/** Apply the plugin against a temp home; returns the registered tool map. */
async function withPlugin(entries, run) {
  const home = await mkdtemp(join(tmpdir(), 'msm-host-mcp-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const patchFile = join(home, 'profiles', 'web', 'cordis.patch.yml');
  try {
    const { ctx, tools } = fakeCtx();
    ctx.loader.entries = () => entries;
    apply(ctx, { patchFile });
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    await run({ toolMap, patchFile, home });
  } finally {
    process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}

/** Assert the error is an McpError with the given code. */
function assertErrorCode(promise, code, message) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code, message);
    return true;
  }, message);
}

test('mcpToggle: unknown id → not-found, no patch file is created', async () => {
  await withPlugin([], async ({ toolMap, patchFile }) => {
    await assertErrorCode(toolMap.manager_mcp_toggle.execute({ id: 'ghost', enabled: false }), 'not-found');
    assert.equal(existsSync(patchFile), false, 'a rejected toggle must not write the patch file');
  });
});

test('mcpToggle: non-MCP loader entry → not-found', async () => {
  const entries = [loaderEntry('include:skills', '@deepseek-ai/dsh-skills', {})];
  await withPlugin(entries, async ({ toolMap, patchFile }) => {
    await assertErrorCode(toolMap.manager_mcp_toggle.execute({ id: 'skills', enabled: false }), 'not-found');
    assert.equal(existsSync(patchFile), false, 'a foreign entry must not get an override row');
  });
});

test('mcpToggle: bundle mcp-client entry → override row appended, schema-valid value', async () => {
  const entries = [loaderEntry('include:gh', MCP_CLIENT_PACKAGE, { serverName: 'gh', transport: 'stdio', command: 'npx' })];
  await withPlugin(entries, async ({ toolMap, patchFile }) => {
    const value = await toolMap.manager_mcp_toggle.execute({ id: 'gh', enabled: false });
    assert.deepEqual(value, { id: 'gh', enabled: false });
    const rows = await readPatchList(patchFile);
    assert.deepEqual(rows, [{ id: 'gh', name: MCP_CLIENT_PACKAGE, disabled: true }]);
  });
});

test('mcpToggle: patch row not yet hot-reloaded (HMR lag) → flag flips in place', async () => {
  await withPlugin([], async ({ toolMap, patchFile }) => {
    await writePatchList(patchFile, [{ insert: [{ id: 'srv', name: MCP_CLIENT_PACKAGE, config: { serverName: 'srv', transport: 'stdio', command: 'node' } }] }]);
    const value = await toolMap.manager_mcp_toggle.execute({ id: 'srv', enabled: false });
    assert.deepEqual(value, { id: 'srv', enabled: false });
    const rows = await readPatchList(patchFile);
    assert.equal(rows[0].insert[0].disabled, true, 'the insert item carries the disabled flag');
  });
});

test('mcpRemove: mcp-client insert row removed, foreign insert rows preserved', async () => {
  await withPlugin([], async ({ toolMap, patchFile }) => {
    await writePatchList(patchFile, [
      { insert: [{ id: 'srv', name: MCP_CLIENT_PACKAGE, config: { serverName: 'srv', transport: 'stdio', command: 'node' } }] },
      { insert: [{ id: 'other', name: '@deepseek-ai/dsh-skills', config: {} }] },
    ]);
    const value = await toolMap.manager_mcp_remove.execute({ id: 'srv' });
    assert.deepEqual(value, { id: 'srv' });
    const rows = await readPatchList(patchFile);
    assert.equal(rows.length, 1, 'only the foreign insert row remains');
    assert.deepEqual(rows[0].insert, [{ id: 'other', name: '@deepseek-ai/dsh-skills', config: {} }]);
  });
});

test('mcpRemove: foreign patch row with the same id → not-found, row preserved', async () => {
  await withPlugin([], async ({ toolMap, patchFile }) => {
    const foreign = { insert: [{ id: 'victim', name: '@deepseek-ai/dsh-skills', config: {} }] };
    await writePatchList(patchFile, [foreign]);
    await assertErrorCode(toolMap.manager_mcp_remove.execute({ id: 'victim' }), 'not-found');
    const rows = await readPatchList(patchFile);
    assert.deepEqual(rows, [foreign], 'the foreign row must survive');
  });
});

test('mcpUpdate: unknown id → not-found (no orphan override row appended)', async () => {
  await withPlugin([], async ({ toolMap, patchFile }) => {
    await assertErrorCode(
      toolMap.manager_mcp_update.execute({ id: 'ghost', serverName: 'x', transport: 'stdio', command: 'node' }),
      'not-found',
    );
    assert.equal(existsSync(patchFile), false, 'a rejected update must not write the patch file');
  });
});

test('mcpAdd/mcpUpdate/mcpRemove/mcpToggle: returned values match their output schemas', async () => {
  await withPlugin(
    [loaderEntry('include:gh', MCP_CLIENT_PACKAGE, { serverName: 'gh', transport: 'stdio', command: 'npx' })],
    async ({ toolMap, patchFile }) => {
      await writePatchList(patchFile, [{ insert: [{ id: 'srv', name: MCP_CLIENT_PACKAGE, config: { serverName: 'srv', transport: 'stdio', command: 'node' } }] }]);
      const checks = [
        ['manager_mcp_toggle', { id: 'gh', enabled: false }],
        ['manager_mcp_add', { id: 'new-srv', serverName: 'newSrv', transport: 'stdio', command: 'node' }],
        ['manager_mcp_update', { id: 'srv', serverName: 'srv', transport: 'stdio', command: 'node2' }],
        ['manager_mcp_remove', { id: 'srv' }],
      ];
      for (const [name, args] of checks) {
        const tool = toolMap[name];
        const value = await tool.execute(args);
        const schema = tool.output.schema;
        for (const key of Object.keys(value)) {
          assert.ok(schema.properties[key], `${name}: returned "${key}" is declared in the output schema`);
        }
        for (const req of schema.required ?? []) {
          assert.ok(req in value, `${name}: schema-required "${req}" present in the returned value`);
        }
      }
    },
  );
});
