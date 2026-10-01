/**
 * skillsList view-selection tests.
 *
 * The browser picker calls `manager.skills.list` (and manager_skills_list
 * without exec) with NO sessionId. Regression being anchored: that path used
 * to fall back to `agents[0]`, so the picker only ever showed the FIRST live
 * agent's workspace skills (plus user-level ones) — workspace skills of any
 * other workspace were ungroupable, and an idle host showed none at all.
 *
 * Contract now:
 * - sessionId → scoped view of that exact agent (cwd + scope forwarded).
 * - no sessionId → union of the unfiltered root catalog across every
 *   registered workspace path plus every live agent cwd, merged by name
 *   (first occurrence wins, registry order).
 * - no workspaces and no agents → bare collect (user-level roots only).
 * - a workspace whose collect throws must not blank out the others.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.ts';

/** Fake ctx recording every skills.list() call with its options. */
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
      async list(listOptions) { lists.push({ options: listOptions }); return options.skills?.(listOptions) ?? []; },
      async get() { return undefined; },
    },
    agents: { list() { return options.agents ?? []; } },
    loader: { entries() { return []; } },
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
  process.env.DSH_HOME = home;
  try {
    await fn(home);
  } finally {
    process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}

function skillEntry(name, extra = {}) {
  return { name, description: `desc-${name}`, invocation: { modelInvocable: true, userInvocable: true }, ...extra };
}

test('picker path unions every registered workspace catalog, deduped by name', async () => {
  await withTempHome(async () => {
    const { ctx, tools, lists } = fakeCtx({
      workspaces: [{ path: 'E:\\ws-a', title: 'A' }, { path: 'E:\\ws-b', title: 'B' }],
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
      ['shared', 'only-a', 'only-b'],
      'union of both workspaces, first occurrence of a shared name wins',
    );
    assert.deepEqual(
      lists.map((call) => call.options?.cwd).sort(),
      ['E:\\ws-a', 'E:\\ws-b'],
      'exactly one collect per workspace cwd, no bare collect',
    );
  });
});

test('idle host (no workspaces, no agents) falls back to the bare user-level collect', async () => {
  await withTempHome(async () => {
    const { ctx, tools, lists } = fakeCtx({
      workspaces: [],
      skills: () => [skillEntry('user-level')],
    });
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const value = await toolMap.manager_skills_list.execute({});
    assert.deepEqual(value.skills.map((skill) => skill.name), ['user-level']);
    assert.equal(lists.length, 1);
    assert.equal(lists[0].options, undefined, 'bare list() carries no cwd');
  });
});

test('live agents contribute their session cwds even without a workspace registry', async () => {
  await withTempHome(async () => {
    const { ctx, tools, lists } = fakeCtx({
      noRegistry: true,
      agents: [
        { id: 'sess-1', session: { header: { cwd: 'E:\\ws-a' } }, ctx: { get() { return undefined; } } },
        { id: 'sess-2', session: { header: {} }, ctx: { get() { return undefined; } } },
      ],
      skills: (options) => (options?.cwd === 'E:\\ws-a' ? [skillEntry('only-a')] : []),
    });
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const value = await toolMap.manager_skills_list.execute({});
    assert.deepEqual(value.skills.map((skill) => skill.name), ['only-a']);
    assert.deepEqual(lists.map((call) => call.options?.cwd), ['E:\\ws-a'], 'cwd-less sessions are skipped');
  });
});

test('sessionId resolves that exact agent only — no first-agent fallback', async () => {
  await withTempHome(async () => {
    const { ctx, tools, lists } = fakeCtx({
      agents: [
        { id: 'sess-1', session: { header: { cwd: 'E:\\ws-a' } }, ctx: { get() { return undefined; } } },
        { id: 'sess-2', session: { header: { cwd: 'E:\\ws-b' } }, ctx: { get() { return undefined; } } },
      ],
      skills: (options) => [{ ...skillEntry('scoped'), source: options?.cwd }],
    });
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const scoped = await toolMap.manager_skills_list.execute({}, { agent: { id: 'sess-2' } });
    assert.deepEqual(scoped.skills.map((skill) => skill.name), ['scoped']);
    const call = lists.at(-1);
    assert.equal(call.options.cwd, 'E:\\ws-b', 'the caller’s own cwd is used');
    assert.equal(call.options.scope.id, 'sess-2', 'the requesting scope is forwarded');

    // Unknown session id → union view (no silent wrong-workspace answer).
    lists.length = 0;
    await toolMap.manager_skills_list.execute({}, { agent: { id: 'gone' } });
    assert.deepEqual(
      lists.map((entry) => entry.options?.cwd),
      ['E:\\ws-a', 'E:\\ws-b'],
      'unresolvable sessionId falls through to the per-workspace union',
    );
  });
});

test('a failing workspace collect is skipped with a warning, not fatal', async () => {
  await withTempHome(async () => {
    const { ctx, tools, warnings } = fakeCtx({
      workspaces: [{ path: 'E:\\bad', title: 'Bad' }, { path: 'E:\\good', title: 'Good' }],
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
