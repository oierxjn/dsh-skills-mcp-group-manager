/**
 * skillsList view-selection tests.
 *
 * The browser picker calls `manager.skills.list` (and manager_skills_list
 * without exec) with NO sessionId. Two anchored regressions:
 *
 * 1. (original) The path used to fall back to `agents[0]`, so the picker only
 *    offered the FIRST live agent's workspace skills — other workspaces'
 *    skills were ungroupable.
 * 2. (follow-up) The first fix collected WITHOUT a scope, but the web-app
 *    composition disables the base host skill-filesystem row and presets
 *    mount their own — the provider lives in the preset layer, reachable only
 *    through a live agent's scope chain. A scope-less collect returns an
 *    empty catalog in production even though the mocked tests stayed green.
 *
 * Contract now:
 * - sessionId → scoped view of that exact agent (cwd + scope forwarded).
 * - no sessionId + live agent → per-cwd collect through a live agent as the
 *   scope carrier, unioned by name (first occurrence wins, registry order).
 * - no sessionId + idle host → disk scan of the same directories the
 *   provider would read (project roots via the .git walk), plus the bare
 *   global-layer collect.
 * - a workspace whose collect throws must not blank out the others.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.ts';

/**
 * Fake ctx recording every skills.list() call. `options.skills` models the
 * production layering: with a scope the full per-cwd catalog resolves
 * (preset-layer filesystem provider); without one only the global layer —
 * empty unless the test says otherwise.
 */
function fakeCtx(options = {}) {
  const tools = [];
  const lists = []; // { options } per ctx.skills.list() call
  const warnings = [];
  const ctx = {
    logger: { warn(msg) { warnings.push(msg); }, error() {}, info() {} },
    tools: {
      register(def) { tools.push(def); return () => {}; },
      schemas() { return []; },
      restrict() { return () => {}; },
    },
    skills: {
      registerProvider() { return () => {}; },
      async list(listOptions) {
        lists.push({ options: listOptions });
        if (listOptions?.scope === undefined && !options.globalLayerSkills) return [];
        return options.skills?.(listOptions) ?? [];
      },
      async get() { return undefined; },
    },
    agents: { list() { return options.agents ?? []; } },
    loader: { entries() { return options.loaderEntries ?? []; } },
    workspaceRegistry: options.noRegistry ? undefined : {
      list() { return options.workspaces ?? []; },
    },
    on() { return () => {}; },
    effect() { return () => {}; },
    get() { return undefined; },
    plugin() { throw new Error('ctx.plugin should not be called in this test'); },
  };
  return { ctx, tools, lists, warnings };
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'msm-skills-list-'));
  const oldHome = process.env.DSH_HOME;
  const oldAgentsHome = process.env.DSH_AGENTS_HOME;
  process.env.DSH_HOME = home;
  // Isolate the user-level skill roots too — the disk-scan fallback reads the
  // real ~/.agents/skills when this is unset.
  process.env.DSH_AGENTS_HOME = join(home, 'agents-home');
  try {
    await fn(home);
  } finally {
    process.env.DSH_HOME = oldHome;
    process.env.DSH_AGENTS_HOME = oldAgentsHome;
    await rm(home, { recursive: true, force: true });
  }
}

function skillEntry(name, extra = {}) {
  return { name, description: `desc-${name}`, invocation: { modelInvocable: true, userInvocable: true }, ...extra };
}

function fakeAgent(id) {
  return { id, session: { header: { cwd: `E:\\ws-${id}` } }, ctx: { get() { return undefined; } } };
}

test('picker path unions workspace catalogs through a live agent scope, deduped by name', async () => {
  await withTempHome(async () => {
    const { ctx, tools, lists } = fakeCtx({
      workspaces: [{ path: 'E:\\ws-a', title: 'A' }, { path: 'E:\\ws-b', title: 'B' }],
      agents: [fakeAgent('sess-1')],
      skills: (options) => {
        if (options?.cwd === 'E:\\ws-a') return [skillEntry('shared'), skillEntry('only-a')];
        if (options?.cwd === 'E:\\ws-b') return [skillEntry('shared'), skillEntry('only-b')];
        return [skillEntry('user-level')];
      },
    });
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const value = await toolMap.manager_skills_list.execute({});
    assert.deepEqual(
      value.skills.map((skill) => skill.name),
      ['shared', 'only-a', 'only-b', 'user-level'],
      'union of both workspaces plus the agent cwd; first occurrence of a shared name wins',
    );
    for (const call of lists) {
      assert.equal(call.options.scope?.id, 'sess-1', 'every collect goes through the live agent scope');
    }
    assert.deepEqual(
      lists.map((call) => call.options?.cwd).sort(),
      ['E:\\ws-a', 'E:\\ws-b', 'E:\\ws-sess-1'],
      'exactly one scoped collect per known cwd',
    );
  });
});

test('idle host falls back to the disk scan: workspace project roots plus user level', async () => {
  await withTempHome(async (home) => {
    // A workspace whose project root carries .agents/skills.
    const ws = join(home, 'ws-a');
    await mkdir(join(ws, '.git'), { recursive: true });
    await mkdir(join(ws, '.agents', 'skills', 'alpha'), { recursive: true });
    await writeFile(
      join(ws, '.agents', 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: Alpha skill\n---\n\nBody.\n',
    );
    // A second workspace WITHOUT .git: the project-root walk escapes to the
    // nearest ancestor — here the temp home itself — so only its own
    // .dsh/skills would be missed unless we plant one there. Plant it to
    // assert the walk-up behavior resolves the home as the root.
    const wsBare = join(home, 'ws-bare');
    await mkdir(join(wsBare), { recursive: true });
    // $DSH_HOME names the .dsh dir itself, so its user skill root is
    // $DSH_HOME/skills.
    await mkdir(join(home, 'skills', 'beta'), { recursive: true });
    await writeFile(
      join(home, 'skills', 'beta', 'SKILL.md'),
      '---\nname: beta\ndescription: Beta skill\n---\n\nBody.\n',
    );

    const { ctx, tools, lists } = fakeCtx({
      workspaces: [{ path: ws, title: 'A' }, { path: wsBare, title: 'B' }],
    });
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const value = await toolMap.manager_skills_list.execute({});
    assert.deepEqual(
      value.skills.map((skill) => skill.name).sort(),
      ['alpha', 'beta'],
      'disk scan covers the workspace project root and the user-level root',
    );
    const bare = lists.find((call) => call.options === undefined);
    assert.notEqual(bare, undefined, 'the global-layer bare collect still runs');
  });
});

test('idle host without any workspace still lists user-level skills from disk', async () => {
  await withTempHome(async (home) => {
    const gammaDir = join(home, 'agents-home', 'skills', 'gamma');
    await mkdir(gammaDir, { recursive: true });
    await writeFile(
      join(gammaDir, 'SKILL.md'),
      '---\nname: gamma\ndescription: Gamma skill\n---\n\nBody.\n',
    );
    const { ctx, tools } = fakeCtx({ workspaces: [] });
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const value = await toolMap.manager_skills_list.execute({});
    assert.deepEqual(value.skills.map((skill) => skill.name), ['gamma']);
  });
});

test('sessionId resolves that exact agent only — no first-agent fallback', async () => {
  await withTempHome(async () => {
    const { ctx, tools, lists } = fakeCtx({
      agents: [fakeAgent('sess-1'), fakeAgent('sess-2')],
      skills: (options) => [skillEntry('scoped', { source: options?.cwd })],
    });
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const scoped = await toolMap.manager_skills_list.execute({}, { agent: { id: 'sess-2' } });
    assert.deepEqual(scoped.skills.map((skill) => skill.name), ['scoped']);
    const call = lists.at(-1);
    assert.equal(call.options.cwd, 'E:\\ws-sess-2', 'the caller’s own cwd is used');
    assert.equal(call.options.scope.id, 'sess-2', 'the requesting scope is forwarded');

    // Unknown session id → union view (no silent wrong-workspace answer).
    lists.length = 0;
    await toolMap.manager_skills_list.execute({}, { agent: { id: 'gone' } });
    assert.deepEqual(
      lists.map((entry) => entry.options?.cwd).sort(),
      ['E:\\ws-sess-1', 'E:\\ws-sess-2'],
      'unresolvable sessionId falls through to the per-workspace union',
    );
  });
});

test('a failing workspace collect is skipped with a warning, not fatal', async () => {
  await withTempHome(async () => {
    const { ctx, tools, warnings } = fakeCtx({
      workspaces: [{ path: 'E:\\bad', title: 'Bad' }, { path: 'E:\\good', title: 'Good' }],
      agents: [fakeAgent('sess-1')],
      skills: (options) => {
        if (options?.cwd === 'E:\\bad') throw new Error('EACCES');
        if (options?.cwd === 'E:\\good') return [skillEntry('only-good')];
        return [];
      },
    });
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const value = await toolMap.manager_skills_list.execute({});
    assert.deepEqual(value.skills.map((skill) => skill.name), ['only-good']);
    assert.equal(warnings.filter((msg) => String(msg).includes('E:\\bad')).length, 1, 'failure surfaces as a warning');
  });
});
