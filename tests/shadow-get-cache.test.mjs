/**
 * Regression tests for the shadow skill provider's get() delegation.
 *
 * Bug (real deployment): the `skill` tool failed with
 * `skill "<name>" is unknown or no longer available` for EVERY enabled skill
 * while the group-manager shadow provider was registered — even though
 * catalog injection (list/snapshot) worked fine.
 *
 * Root cause: dsh-skill's collect cache is keyed by
 * `{cwd, scopeChain, revision}` ONLY (see dsh-skill/lib/index.js
 * `collectCacheKey`) — it knows nothing about the plugin's catalogReentry
 * guard. The shadow get() delegated via `ctx.skills.get()` with the SAME
 * view, the nested collect() HIT the cache populated by the outer collect
 * (which still holds the shadow layer's winning candidates), the nested get()
 * re-dispatched to the shadow provider, and the re-entry guard returned
 * `undefined` — which dsh-tool-skill surfaces as "unknown or no longer
 * available" (lib/index.js of dsh-tool-skill, get() → !skill branch).
 *
 * Fix: invalidate the registry cache before delegating (so the nested collect
 * re-runs collectFresh with the guard active and the real filesystem provider
 * wins) and again after (so the nested UNFILTERED result cannot poison later
 * reads — it would otherwise resurrect disabled skills into the catalog).
 *
 * The MiniRegistry below reproduces the dsh-skill semantics that matter:
 * layered providers, nearest-layer-wins merge, a collect cache keyed by
 * view+revision, and provider dispatch in get(). The plugin's own
 * catalogReentry AsyncLocalStorage provides the re-entry guard, exactly as in
 * production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const SHADOW = 'skill-manager-filter';

/** A real catalog skill as a filesystem provider would discover it. */
function fsCandidate(name) {
  return {
    name,
    description: `Description of ${name}.`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user',
    provider: 'filesystem',
    rank: 0,
    locator: join('skills', name, 'SKILL.md'),
  };
}

const BODIES = {
  'skill-a': '# Skill A body\n',
  'skill-b': '# Skill B body\n',
};

/** The real provider that owns skill bodies on disk. */
const filesystemProvider = {
  name: 'filesystem',
  async list() {
    return ['skill-a', 'skill-b'].map(fsCandidate);
  },
  async get(candidate) {
    const content = BODIES[candidate.name];
    if (content === undefined) return undefined;
    return { ...candidate, content };
  },
};

/**
 * Faithful subset of the dsh-skill registry: two layers (global, agent),
 * nearest-layer-wins merge, a collect cache keyed by view+revision, and
 * get() dispatching through the WINNING entry's provider.
 */
class MiniRegistry {
  constructor() {
    this.layers = [{ providers: [filesystemProvider] }, { providers: [] }];
    this.cache = new Map();
    this.revision = 0;
    this.invalidateCount = 0;
  }

  registerProvider(factory, layerIndex) {
    const control = {
      invalidate: () => {
        this.invalidateCount += 1;
        this.revision += 1;
        this.cache.clear();
      },
    };
    const provider = factory(control);
    this.layers[layerIndex].providers.push(provider);
    return () => {};
  }

  async collect(options) {
    // dsh-skill: key = cwd + scopeChain + revision. The plugin's re-entry
    // state is deliberately NOT part of the key — that is the trap.
    const key = JSON.stringify([options.cwd ?? null, options.scope?.id ?? null, this.revision]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return { entries: cached };
    const merged = new Map();
    for (const layer of this.layers) {
      for (const provider of layer.providers) {
        const candidates = (await provider.list(options)) ?? [];
        for (const candidate of candidates) {
          merged.set(candidate.name, { candidate, provider });
        }
      }
    }
    this.cache.set(key, merged);
    return { entries: merged };
  }

  async list(options) {
    const collected = await this.collect(options);
    return [...collected.entries.values()].map((entry) => entry.candidate);
  }

  async get(name, options) {
    const collected = await this.collect(options);
    const match = collected.entries.get(name);
    if (match === undefined) return undefined;
    return (await match.provider.get(match.candidate, options)) ?? undefined;
  }
}

/** Run fn with DSH_HOME at a temp dir pre-seeded with the given group state. */
async function withState(fn) {
  const home = await mkdtemp(join(tmpdir(), 'msm-shadow-get-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    // Group "All" is enabled and contains ONLY skill-a → skill-b must stay
    // filtered out of the model catalog (double-false invocation).
    const dir = join(home, 'mcp-skill-manager');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      groups: [{ id: 'g-all', name: 'All', enabled: true, skills: ['skill-a'] }],
      sessions: {},
    }));
    await fn(home);
  } finally {
    process.env.DSH_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
}

/** Wire apply() against a fake ctx whose agent scope carries the registry. */
function setup(registry) {
  const agent = {
    id: 'agent-1',
    session: { header: { cwd: '/work' } },
    ctx: {
      get(key) {
        if (key === 'skills') {
          return {
            registerProvider: (factory) => registry.registerProvider(factory, 1),
          };
        }
        return undefined;
      },
    },
  };
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    tools: {
      register() { return () => {}; },
      schemas() { return []; },
      restrict() { return () => {}; },
    },
    skills: {
      // The OUR-ctx service (used by the shadow provider's nested delegation
      // and by the RPC list). In production both resolve to the same registry.
      registerProvider: (factory) => registry.registerProvider(factory, 0),
      list: (options) => registry.list(options ?? {}),
      get: (name, options) => registry.get(name, options ?? {}),
    },
    agents: { list: () => [agent] },
    loader: { entries: () => [] },
    on() { return () => {}; },
    effect(callback) { callback(); return () => {}; },
    get(key) {
      if (key === 'webServer' || key === 'httpServer') {
        return { register() { return () => {}; } };
      }
      return undefined;
    },
  };
  apply(ctx, {});
  return { agent, registry };
}

test('shadow get() must load the real body through the cached view (skill tool regression)', async () => {
  await withState(async () => {
    const registry = new MiniRegistry();
    const { agent } = setup(registry);
    const lookup = { cwd: agent.session.header.cwd, scope: agent };

    // Step 1 — the catalog view (what the prompt injection and the skill
    // tool's summary lookup do). This populates the collect cache whose
    // winning entries ALL point at the shadow provider.
    const summaries = await registry.list(lookup);
    const a = summaries.find((skill) => skill.name === 'skill-a');
    assert.ok(a, 'enabled skill visible in the catalog');
    assert.equal(a.provider, SHADOW, 'shadow layer wins the view');
    assert.deepEqual(a.invocation, { modelInvocable: true, userInvocable: true });

    // Step 2 — the body load (what the `skill` tool does after the summary
    // check). Before the fix this returned undefined: the nested
    // ctx.skills.get() hit the cache, re-dispatched to the shadow provider,
    // and its re-entry guard returned undefined.
    const definition = await registry.get('skill-a', lookup);
    assert.ok(definition, 'shadow get() must resolve the real body, not undefined');
    assert.equal(definition.name, 'skill-a');
    assert.equal(definition.content, BODIES['skill-a']);
    // The fix delegates through a fresh collect: both invalidations (before +
    // after) must have fired.
    assert.ok(registry.invalidateCount >= 2, `expected ≥2 invalidations, got ${registry.invalidateCount}`);
  });
});

test('shadow get() works even when the collect cache is cold', async () => {
  await withState(async () => {
    const registry = new MiniRegistry();
    const { agent } = setup(registry);
    const lookup = { cwd: agent.session.header.cwd, scope: agent };
    const definition = await registry.get('skill-a', lookup);
    assert.ok(definition, 'cold-cache get() must also resolve the real body');
    assert.equal(definition.content, BODIES['skill-a']);
  });
});

test('nested unfiltered collect result must not leak disabled skills back into the catalog', async () => {
  await withState(async () => {
    const registry = new MiniRegistry();
    const { agent } = setup(registry);
    const lookup = { cwd: agent.session.header.cwd, scope: agent };

    await registry.list(lookup); // warm the filtered view
    await registry.get('skill-a', lookup); // delegate through the shadow layer

    // After the body load the cache must NOT hold the nested (unfiltered)
    // result — otherwise skill-b (not in any enabled group) would reappear
    // as model-invocable on the next snapshot.
    const after = await registry.list(lookup);
    const b = after.find((skill) => skill.name === 'skill-b');
    assert.ok(b, 'disabled skill still listed (as non-invocable)');
    assert.deepEqual(b.invocation, { modelInvocable: false, userInvocable: false },
      'disabled skill must not be resurrected as invocable after a get()');
    const a = after.find((skill) => skill.name === 'skill-a');
    assert.deepEqual(a.invocation, { modelInvocable: true, userInvocable: true });
  });
});
