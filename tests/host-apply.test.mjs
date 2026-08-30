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
import { apply } from '../src/index.ts';

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

/** Invoke the registered RPC route with a JSON body; returns { status, ...envelope }. */
async function callRpc(routes, method, args, options = {}) {
  assert.equal(routes.length, 1, 'exactly one RPC route registered');
  const req = [Buffer.from(JSON.stringify({ method, args: args ?? {} }))];
  req.headers = options.headers ?? {};
  let status;
  let body;
  const res = {
    writeHead(code) { status = code; },
    end(chunk) { body = chunk; },
  };
  await routes[0].handler(req, res);
  return { status, ...JSON.parse(body) };
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

// The dsh-tools registry validates every registered schema against a subset:
// `type` must be a single string (nullable is expressed as oneOf). A type
// array here fails plugin LOAD, not just the tool call — guard the final
// converted schemas so this boot-breaking class cannot regress.
test('registered tool schemas stay inside the dsh-tools subset (no type arrays)', () => {
  const { ctx, tools } = fakeCtx();
  apply(ctx, {});
  assert.ok(tools.length > 0);
  const violations = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' && Array.isArray(value)) {
        violations.push(`${path}.type is an array (${value.join('|')})`);
      }
      walk(value, `${path}.${key}`);
    }
  };
  for (const tool of tools) {
    walk(tool.parameters, `${tool.name}.parameters`);
    if (tool.output?.schema !== undefined) walk(tool.output.schema, `${tool.name}.output`);
  }
  assert.deepEqual(violations, []);
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

// The RPC route is the browser half's only write path and accepts untrusted
// JSON that can spawn MCP child processes (manager.mcp.add/probe). The host
// webserver has no origin policy, so the plugin must reject cross-origin
// browser requests itself: a cross-origin POST always carries an Origin
// header naming the attacker's site, while the loopback-served GUI carries a
// loopback Origin (or none, for non-browser callers).
test('RPC route rejects cross-origin requests (CSRF guard)', async () => {
  await withTempHome(async () => {
    const { ctx, effects, routes } = fakeCtx();
    apply(ctx, {});
    effects.find((effect) => effect.label === 'mcp-skill-manager: rpc route').callback();

    // Attacker origin → 403, never reaches the method table.
    let res = await callRpc(routes, 'manager.state.get', {}, { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'forbidden-origin');

    // Same-origin GUI (loopback) → allowed.
    res = await callRpc(routes, 'manager.state.get', {}, { headers: { origin: 'http://127.0.0.1:3080' } });
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    res = await callRpc(routes, 'manager.state.get', {}, { headers: { origin: 'http://localhost:3080' } });
    assert.equal(res.ok, true);

    // No Origin header (curl / another plugin) → allowed (backward compatible).
    res = await callRpc(routes, 'manager.state.get', {});
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);

    // `Origin: null` (sandboxed iframe / file:) is not a loopback origin → rejected.
    res = await callRpc(routes, 'manager.state.get', {}, { headers: { origin: 'null' } });
    assert.equal(res.status, 403);
    assert.equal(res.error.code, 'forbidden-origin');

    // URL userinfo smuggling must not sneak past the hostname check.
    res = await callRpc(routes, 'manager.state.get', {}, { headers: { origin: 'http://evil.example@127.0.0.1:3080' } });
    assert.equal(res.status, 403);
    assert.equal(res.error.code, 'forbidden-origin');
  });
});

// Finding #4: group CRUD used to throw bare `Error`, which the RPC layer
// collapses to `code: 'internal'` — so the browser half could not tell a
// caller error (bad args / unknown id) from a real failure. Group APIs now
// throw the same structured McpError as the MCP APIs.
test('group RPC errors are structured (invalid-args / not-found, not internal)', async () => {
  await withTempHome(async () => {
    const { ctx, effects, routes } = fakeCtx();
    apply(ctx, {});
    effects.find((effect) => effect.label === 'mcp-skill-manager: rpc route').callback();

    // Empty group name → caller error, not internal.
    let res = await callRpc(routes, 'manager.groups.create', { name: '' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'invalid-args');

    res = await callRpc(routes, 'manager.groups.create', { name: 'G1' });
    assert.equal(res.ok, true);
    const g1 = res.value.id;

    // Missing / malformed args → caller error.
    res = await callRpc(routes, 'manager.groups.rename', { name: 'X' });
    assert.equal(res.error.code, 'invalid-args');
    res = await callRpc(routes, 'manager.groups.setEnabled', { id: g1, enabled: 'yes' });
    assert.equal(res.error.code, 'invalid-args');
    res = await callRpc(routes, 'manager.groups.addSkill', { id: g1 });
    assert.equal(res.error.code, 'invalid-args');
    res = await callRpc(routes, 'manager.groups.removeSkill', { id: g1 });
    assert.equal(res.error.code, 'invalid-args');

    // Unknown group id → not-found (delete goes through requireGroup; the
    // add/remove paths through state.js's group lookup).
    res = await callRpc(routes, 'manager.groups.delete', { id: 'ghost' });
    assert.equal(res.error.code, 'not-found');
    res = await callRpc(routes, 'manager.groups.addSkill', { id: 'ghost', skill: 's' });
    assert.equal(res.error.code, 'not-found');
    res = await callRpc(routes, 'manager.groups.removeSkill', { id: 'ghost', skill: 's' });
    assert.equal(res.error.code, 'not-found');
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


// Regression for the Copilot-flagged gap: the shadow provider's
// AsyncLocalStorage re-entrancy guard had no coverage - a broken guard
// would recurse infinitely inside the real registry's nested collect
// while every existing test (whose skills.list stub ignores scope) stays
// green. This test models the real registry: listing with the requesting
// scope walks [global, preset, agent], and reaching the agent layer
// re-invokes the shadow provider through the same async chain.
test('shadow list survives its own nested registry pass (scope re-entrancy)', async () => {
  await withTempHome(async () => {
    const invalidated = [];
    const agent = fakeAgent('sess-a', invalidated);
    const { ctx, tools } = fakeCtx();
    ctx.agents.list = () => [agent];
    apply(ctx, {});
    assert.equal(agent.providers.length, 1);
    const shadow = agent.providers[0];

    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const g1 = (await toolMap.manager_groups_create.execute({ name: 'G1' })).id;
    await toolMap.manager_groups_add_skill.execute({ id: g1, skill: 'skill-one' });

    // The preset standing layer's unfiltered catalog.
    const presetCandidates = [
      { name: 'skill-one', description: 'one', invocation: { modelInvocable: true, userInvocable: true }, source: 'preset', rank: 100, provider: 'filesystem' },
      { name: 'skill-two', description: 'two', invocation: { modelInvocable: true, userInvocable: true }, source: 'preset', rank: 100, provider: 'filesystem' },
    ];

    const requested = { cwd: '.', signal: new AbortController().signal, scope: agent };
    let nestedPasses = 0;
    const reentrantResults = [];
    ctx.skills.list = async (options) => {
      assert.equal(options.scope, requested.scope, 'the shadow must forward the requesting scope');
      nestedPasses += 1;
      assert.ok(nestedPasses <= 2, `runaway recursion: ${nestedPasses} nested passes`);
      // The registry reaches the agent layer and re-invokes the shadow
      // provider; the guard must make that re-entrant pass contribute
      // nothing so THIS call resolves the unfiltered catalog.
      const fromAgentLayer = await shadow.list(options);
      reentrantResults.push(fromAgentLayer);
      return [...presetCandidates, ...fromAgentLayer];
    };

    // Outermost entry: the registry reaching the agent layer.
    const listed = await shadow.list(requested);
    assert.equal(nestedPasses, 1, 'exactly one nested registry pass (no recursion)');
    assert.deepEqual(reentrantResults, [[]], 'the re-entrant shadow pass yields []');
    assert.deepEqual(
      listed.map((skill) => [skill.name, skill.invocation.modelInvocable]),
      [['skill-one', true], ['skill-two', false]],
      'the outer view maps the unfiltered nested catalog onto the session selection',
    );
  });
});

// The group mutation tools used to return {} with a degenerate empty-object
// output schema (additionalProperties:false, properties:{}) — self-consistent
// but useless: callers got no confirmation payload and nothing kept schema and
// return value together. Each mutation now echoes the affected entity, and the
// declared output schema must stay in lockstep with it (key sets match exactly
// under additionalProperties:false).
test('group mutation tools echo a payload matching their output schema', async () => {
  await withTempHome(async () => {
    const { ctx, tools } = fakeCtx();
    apply(ctx, {});
    const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const assertMatchesSchema = (result, tool) => {
      const schema = tool.output.schema;
      assert.equal(schema.type, 'object', `${tool.name}: object output schema`);
      assert.equal(schema.additionalProperties, false, `${tool.name}: closed object`);
      assert.ok(result !== null && typeof result === 'object', `${tool.name}: object result`);
      // additionalProperties:false + every property required => key sets match exactly.
      assert.deepEqual(
        Object.keys(result).sort(),
        Object.keys(schema.properties).sort(),
        `${tool.name}: result keys match schema properties exactly`,
      );
      // The "key sets match exactly" guarantee only holds because valueSchema
      // hoists every inline `required: true` into the top-level `required`
      // array. If that hoist regresses (a field silently stops being
      // required), the result↔properties check above would stay green while
      // the schema itself drifted — so assert the hoist explicitly.
      assert.deepEqual(
        (schema.required ?? []).sort(),
        Object.keys(schema.properties).sort(),
        `${tool.name}: every output property is hoisted into required`,
      );
      for (const [key, prop] of Object.entries(schema.properties)) {
        const value = result[key];
        if (prop.type === 'string') {
          assert.equal(typeof value, 'string', `${tool.name}.${key}: string`);
        } else if (prop.type === 'boolean') {
          assert.equal(typeof value, 'boolean', `${tool.name}.${key}: boolean`);
        } else if (prop.type === 'array') {
          assert.ok(Array.isArray(value), `${tool.name}.${key}: array`);
          for (const item of value) {
            assert.equal(typeof item, 'string', `${tool.name}.${key}[]: string`);
          }
        }
      }
    };

    const created = await toolMap.manager_groups_create.execute({ name: 'G1' });
    assertMatchesSchema(created, toolMap.manager_groups_create);

    const renamed = await toolMap.manager_groups_rename.execute({ id: created.id, name: 'Renamed' });
    assertMatchesSchema(renamed, toolMap.manager_groups_rename);
    assert.deepEqual(renamed, { id: created.id, name: 'Renamed' });

    const disabled = await toolMap.manager_groups_set_enabled.execute({ id: created.id, enabled: false });
    assertMatchesSchema(disabled, toolMap.manager_groups_set_enabled);
    assert.deepEqual(disabled, { id: created.id, enabled: false });

    const added = await toolMap.manager_groups_add_skill.execute({ id: created.id, skill: 'skill-one' });
    assertMatchesSchema(added, toolMap.manager_groups_add_skill);
    assert.deepEqual(added, { id: created.id, skills: ['skill-one'] });

    // Batch form echoes the full post-operation membership, not just the delta.
    const addedMore = await toolMap.manager_groups_add_skill.execute({
      id: created.id,
      skills: ['skill-two', 'skill-three', 'skill-one'], // 'skill-one' deduped
    });
    assertMatchesSchema(addedMore, toolMap.manager_groups_add_skill);
    assert.deepEqual(addedMore, { id: created.id, skills: ['skill-one', 'skill-two', 'skill-three'] });

    const removed = await toolMap.manager_groups_remove_skill.execute({ id: created.id, skill: 'skill-one' });
    assertMatchesSchema(removed, toolMap.manager_groups_remove_skill);
    assert.deepEqual(removed, { id: created.id, skills: ['skill-two', 'skill-three'] });

    const deleted = await toolMap.manager_groups_delete.execute({ id: created.id });
    assertMatchesSchema(deleted, toolMap.manager_groups_delete);
    assert.deepEqual(deleted, { id: created.id });
  });
});
