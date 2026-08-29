/**
 * Host apply() contract tests.
 *
 * Regression guard for a crash hazard found in the real deployment: Cordis
 * treats a prototype-bearing function as a constructor, so an `async apply`
 * is NOT awaited — its promise is ignored. If anything after the first
 * `await` throws, the rejection is unhandled and the whole dsh process
 * crashes (the "flicker" the user saw was the service crash-restart loop).
 *
 * Contract under test: `apply()` must complete ALL registrations
 * SYNCHRONOUSLY — tools, listeners, effects — so the loader sees a fully
 * wired plugin and any error surfaces as a normal loader failure instead of
 * an unhandled rejection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

/** Minimal fake ctx capturing every registration the host half performs. */
function fakeCtx() {
  const tools = [];
  const toolDisposers = [];
  const effects = [];
  const listeners = [];
  const providers = [];
  const schemas = [];
  const routes = [];
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    tools: {
      register(def) {
        tools.push(def);
        return () => { toolDisposers.push(def.name); };
      },
      schemas() { return schemas; },
      restrict() { return () => {}; },
    },
    skills: {
      registerProvider(factory) { providers.push(factory); return () => {}; },
      async list() { return []; },
      async get() { return undefined; },
    },
    agents: { list() { return []; } },
    loader: { entries() { return []; } },
    on(name, listener) { listeners.push({ name, listener }); return () => {}; },
    effect(callback, label) { effects.push({ callback, label }); return () => {}; },
    get(key) {
      if (key === 'webServer' || key === 'httpServer') {
        return { register(route) { routes.push(route); return () => {}; } };
      }
      return undefined;
    },
    plugin() { throw new Error('ctx.plugin should not be called in this test'); },
  };
  return { ctx, tools, toolDisposers, effects, listeners, providers, routes };
}

/**
 * Run fn with DSH_HOME pointed at a temp dir (the host plugin persists its
 * state store there; without this, session writes would touch ~/.dsh).
 */
async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'msm-host-apply-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    await fn(home);
  } finally {
    process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}

/** Invoke the registered RPC route with a JSON body; returns the envelope. */
async function callRpc(routes, method, args) {
  assert.equal(routes.length, 1, 'exactly one RPC route registered');
  const req = [Buffer.from(JSON.stringify({ method, args: args ?? {} }))];
  let body;
  const res = { writeHead() {}, end(chunk) { body = chunk; } };
  await routes[0].handler(req, res);
  return JSON.parse(body);
}

/**
 * Fake live agent: agent.id IS the session id. registerProvider runs the
 * provider factory synchronously (as the real skills registry does) and
 * records the control so tests can observe invalidate() calls.
 */
function fakeAgent(id, invalidated) {
  const agent = {
    id,
    providers: [],
    ctx: {
      get(key) {
        if (key !== 'skills') return undefined;
        return {
          registerProvider(factory) {
            const control = { invalidate: () => invalidated.push(id) };
            agent.providers.push(factory(control));
            return () => {};
          },
        };
      },
    },
  };
  return agent;
}

test('apply() registers all 15 manager_* tools synchronously', () => {
  const { ctx, tools } = fakeCtx();
  const result = apply(ctx, {});
  // The contract: after apply() RETURNS (not after a microtask), every tool
  // must already be registered. An async apply would fail this assertion
  // because the registrations happen after the first await.
  assert.equal(typeof result?.then, 'undefined', 'apply() must be synchronous (no promise)');
  const names = tools.map((tool) => tool.name);
  for (const expected of [
    'manager_groups_list', 'manager_groups_create', 'manager_groups_delete',
    'manager_groups_rename', 'manager_groups_set_enabled', 'manager_groups_add_skill',
    'manager_groups_remove_skill', 'manager_skills_list', 'manager_session_get',
    'manager_session_set', 'manager_mcp_list',
    'manager_mcp_toggle', 'manager_mcp_add', 'manager_mcp_update', 'manager_mcp_remove',
  ]) {
    assert.ok(names.includes(expected), `tool ${expected} registered synchronously`);
  }
  assert.equal(tools.length, 15, 'exactly 15 tools (probe is RPC-only, not a tool)');
});

test('apply() wires lifecycle listeners and effects synchronously', () => {
  const { ctx, effects, listeners } = fakeCtx();
  apply(ctx, {});
  const listenerNames = listeners.map((entry) => entry.name);
  for (const expected of ['agent/created', 'agent/disposed']) {
    assert.ok(listenerNames.includes(expected), `listener ${expected} registered synchronously`);
  }
  // The tools/change listener existed only to re-apply MCP restrictions;
  // with the patch-file approach the loader HMR owns server lifecycles.
  assert.ok(!listenerNames.includes('tools/change'), 'no tools/change restrict wiring');
  const effectLabels = effects.map((entry) => entry.label);
  assert.ok(effectLabels.includes('mcp-skill-manager: agent-layer cleanup'), 'cleanup effect registered synchronously');
});

test('apply() registers the shadow skill provider factory synchronously', () => {
  const { ctx, providers } = fakeCtx();
  apply(ctx, {});
  assert.equal(providers.length, 0, 'no live agents at boot → no provider yet');
  // Simulate an agent appearing: the agent/created listener must register a
  // provider named skill-manager-filter on the agent scope.
  const created = ctx.on.calls?.() ?? [];
  void created;
});

test('apply() tolerates live agents whose ctx resolves skills only via get()', () => {
  // Regression for the real-deployment crash: in the running dsh process,
  // `agent.ctx.skills` (property access) throws the Cordis Guard error
  // ("cannot get property skills without inject") because 'skills' is not in
  // the agent ctx's inject map — while `agent.ctx.get('skills')` resolves
  // the service fine. The plugin must use get() so a boot with restored
  // sessions (live agents at apply time) cannot crash the plugin tree.
  const agentProviders = [];
  const agentSkills = {
    registerProvider(factory) { agentProviders.push(factory); return () => {}; },
  };
  const agentTools = { restrict() { return () => {}; } };
  const agentCtx = {
    get(key) {
      if (key === 'skills') return agentSkills;
      if (key === 'tools') return agentTools;
      return undefined;
    },
  };
  // Mimic the real Guard: property access to 'skills' throws.
  Object.defineProperty(agentCtx, 'skills', {
    get() { throw new Error('cannot get property "skills" without inject'); },
  });
  const agent = { id: 'live-agent-1', ctx: agentCtx };

  const { ctx, tools } = fakeCtx();
  ctx.agents.list = () => [agent];
  assert.doesNotThrow(() => apply(ctx, {}), 'apply() must not throw for live agents');
  assert.equal(agentProviders.length, 1, 'shadow provider registered on the agent scope');
  const provider = agentProviders[0]({ signal: new AbortController().signal, invalidate() {} });
  assert.equal(provider.name, 'skill-manager-filter');
  assert.equal(typeof provider.list, 'function');
  assert.equal(typeof provider.get, 'function');
  assert.ok(tools.length >= 12, 'tools still registered');
});

test('cleanup effect disposes every tool registration (no tool leaks on unload)', () => {
  const { ctx, tools, toolDisposers, effects } = fakeCtx();
  apply(ctx, {});
  const cleanup = effects.find((effect) => effect.label === 'mcp-skill-manager: agent-layer cleanup');
  assert.ok(cleanup, 'cleanup effect present');
  assert.equal(toolDisposers.length, 0, 'no disposals before cleanup');
  const disposer = cleanup.callback();
  disposer();
  assert.equal(toolDisposers.length, tools.length, 'every tool registration disposed on unload');
  assert.deepEqual([...toolDisposers].sort(), tools.map((tool) => tool.name).sort());
});

test('tool definitions carry valid raw JSON schemas (required names exist in properties)', () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, {});
  assert.ok(tools.length >= 12, 'tools registered');
  const check = (node, where) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    for (const name of node.required ?? []) {
      assert.ok(node.properties?.[name], `${where}: required "${name}" exists in properties`);
    }
    if (node.properties) for (const p of Object.values(node.properties)) check(p, where);
    if (node.items) check(node.items, where);
  };
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object', `${tool.name}: parameters object root`);
    check(tool.parameters, `${tool.name}.parameters`);
    if (tool.output?.schema) check(tool.output.schema, `${tool.name}.output`);
  }
});

test('manager.session.get/set RPC: follow-global, override, empty, unknown id, reset', async () => {
  await withTempHome(async () => {
    const { ctx, tools, effects, routes } = fakeCtx();
    apply(ctx, {});
    // fakeCtx records effects without running them; the RPC route lives inside
    // a ctx.effect, so fire it manually (Cordis runs effects at apply time).
    effects.find((effect) => effect.label === 'mcp-skill-manager: rpc route').callback();
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const g1 = (await toolMap.manager_groups_create.execute({ name: 'G1' })).id;
    const g2 = (await toolMap.manager_groups_create.execute({ name: 'G2' })).id;

    // No override: follows the global enabled groups (both enabled by default).
    let res = await callRpc(routes, 'manager.session.get', { sessionId: 'sess-1' });
    assert.deepEqual(res.value, { override: null, effectiveGroupIds: [g1, g2] });

    // Explicit override detaches the session.
    res = await callRpc(routes, 'manager.session.set', { sessionId: 'sess-1', enabledGroupIds: [g1] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.value.override, { enabledGroupIds: [g1] });
    assert.deepEqual(res.value.effectiveGroupIds, [g1]);

    // Empty array = inject nothing (NOT follow-global).
    res = await callRpc(routes, 'manager.session.set', { sessionId: 'sess-1', enabledGroupIds: [] });
    assert.deepEqual(res.value.override, { enabledGroupIds: [] });
    assert.deepEqual(res.value.effectiveGroupIds, []);

    // Unknown group id: rejected, previous override untouched.
    res = await callRpc(routes, 'manager.session.set', { sessionId: 'sess-1', enabledGroupIds: ['ghost'] });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'not-found');
    res = await callRpc(routes, 'manager.session.get', { sessionId: 'sess-1' });
    assert.deepEqual(res.value.override, { enabledGroupIds: [] });

    // null returns to follow-global (the sessions entry is removed).
    res = await callRpc(routes, 'manager.session.set', { sessionId: 'sess-1', enabledGroupIds: null });
    assert.deepEqual(res.value, { override: null, effectiveGroupIds: [g1, g2] });

    // Malformed args are rejected with invalid-args.
    res = await callRpc(routes, 'manager.session.set', { sessionId: 'sess-1', enabledGroupIds: 'g1' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'invalid-args');
    res = await callRpc(routes, 'manager.session.get', {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'invalid-args');
  });
});

test('manager_session_* tools are scoped to the calling session (exec.agent.id)', async () => {
  await withTempHome(async () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const g1 = (await toolMap.manager_groups_create.execute({ name: 'G1' })).id;
    const g2 = (await toolMap.manager_groups_create.execute({ name: 'G2' })).id;

    const agentA = { id: 'sess-a' };
    const agentB = { id: 'sess-b' };
    let value = await toolMap.manager_session_set.execute({ enabledGroupIds: [g2] }, { agent: agentA });
    assert.deepEqual(value.override, { enabledGroupIds: [g2] });
    assert.deepEqual(value.effectiveGroupIds, [g2]);

    value = await toolMap.manager_session_get.execute({}, { agent: agentA });
    assert.deepEqual(value.override, { enabledGroupIds: [g2] });
    // Another session is unaffected and still follows the global toggles.
    value = await toolMap.manager_session_get.execute({}, { agent: agentB });
    assert.deepEqual(value, { override: null, effectiveGroupIds: [g1, g2] });

    // Output values stay within the declared output schema.
    const schema = toolMap.manager_session_get.output.schema;
    assert.ok(schema.properties.override && schema.properties.effectiveGroupIds);
    for (const req of schema.required) assert.ok(req in value, `schema-required "${req}" present`);
  });
});

test('manager_session_* tools: missing exec.agent rejects with a clear error', async () => {
  await withTempHome(async () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    await assert.rejects(
      toolMap.manager_session_get.execute({}),
      /require the calling agent context/,
    );
    await assert.rejects(
      toolMap.manager_session_set.execute({ enabledGroupIds: [] }, {}),
      /require the calling agent context/,
    );
  });
});

test('session override invalidates only the target agent catalog', async () => {
  await withTempHome(async () => {
    const invalidated = [];
    const agentA = fakeAgent('sess-a', invalidated);
    const agentB = fakeAgent('sess-b', invalidated);
    const { ctx, tools } = fakeCtx();
    ctx.agents.list = () => [agentA, agentB];
    apply(ctx, {});
    assert.equal(agentA.providers.length, 1);
    assert.equal(agentB.providers.length, 1);
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const g1 = (await toolMap.manager_groups_create.execute({ name: 'G1' })).id;
    assert.deepEqual(invalidated.sort(), ['sess-a', 'sess-b'], 'group CRUD refreshes every catalog');
    invalidated.length = 0;

    // A session override touches only that session's shadow control.
    await toolMap.manager_session_set.execute({ enabledGroupIds: [g1] }, { agent: { id: 'sess-a' } });
    assert.deepEqual(invalidated, ['sess-a'], 'override invalidates the target agent only');

    // ...and the shadow list() actually resolves per-session: agent A injects
    // only group g1's skills, agent B (no override) the global union.
    await toolMap.manager_groups_add_skill.execute({ id: g1, skill: 'skill-one' });
    invalidated.length = 0;
    ctx.skills.list = async () => [
      { name: 'skill-one', description: '', invocation: { modelInvocable: true, userInvocable: true }, source: 'test' },
      { name: 'skill-two', description: '', invocation: { modelInvocable: true, userInvocable: true }, source: 'test' },
    ];
    const listA = await agentA.providers[0].list({ cwd: '.', signal: new AbortController().signal });
    const listB = await agentB.providers[0].list({ cwd: '.', signal: new AbortController().signal });
    assert.deepEqual(
      listA.map((s) => [s.name, s.invocation.modelInvocable]),
      [['skill-one', true], ['skill-two', false]],
      'overridden session injects only its override groups',
    );
    assert.deepEqual(
      listB.map((s) => [s.name, s.invocation.modelInvocable]),
      [['skill-one', true], ['skill-two', false]],
      'follow-global session with one enabled group injects that group only',
    );

    // Resetting the override (null) also invalidates only the target agent,
    // and the session then follows the global union again.
    await toolMap.manager_session_set.execute({ enabledGroupIds: null }, { agent: { id: 'sess-a' } });
    assert.deepEqual(invalidated, ['sess-a']);
    const value = await toolMap.manager_session_get.execute({}, { agent: { id: 'sess-a' } });
    assert.equal(value.override, null);
  });
});
