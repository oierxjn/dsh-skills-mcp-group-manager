/**
 * Smoke tests for the dsh-mcp-skill-manager client half bundle.
 *
 * The client half is a classic script in the client-modules format
 * (`window.__ModuleLoader__.load({ id, factory })`). These tests evaluate it
 * with stubbed browser globals and a stubbed `react` seed word, then verify:
 *  1. the registration id and the factory's plugin face ({ apply, inject });
 *  2. apply() wires locale dictionaries, the stylesheet, and the three slot
 *     registrations (two settings sections + the session header button) with
 *     the planned ids/orders;
 *  3. the stylesheet effect is fiber-scoped (disposer removes the tag).
 *
 * Run: node --test (auto-discovers tests/*.test.mjs)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** Minimal react seed word: components are only defined, never rendered here. */
const reactStub = {
  createElement: () => ({}),
  Fragment: Symbol('Fragment'),
  useState: () => [],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
};

function evaluateBundle() {
  const registrations = [];
  const styleTags = [];
  const head = {
    appendChild: (tag) => { styleTags.push(tag); },
  };
  const documentStub = {
    head,
    documentElement: { lang: 'en' },
    createElement: (name) => {
      if (name !== 'style') throw new Error(`unexpected createElement(${name})`);
      const tag = { dataset: {}, textContent: '', remove() { const at = styleTags.indexOf(tag); if (at >= 0) styleTags.splice(at, 1); } };
      return tag;
    },
    querySelector: () => null,
  };
  globalThis.window = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    innerWidth: 1440,
    innerHeight: 900,
  };
  globalThis.document = documentStub;
  vm.runInThisContext(code, { filename: 'lib/client.js' });
  assert.equal(registrations.length, 1, 'exactly one __ModuleLoader__.load registration');
  const registration = registrations[0];
  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return reactStub;
    throw new Error(`unexpected require("${specifier}") — the bundle must only use seed words`);
  });
  return { registration, plugin, styleTags };
}

test('bundle registers under the package id and exports a plugin face', () => {
  const { registration, plugin } = evaluateBundle();
  assert.equal(registration.id, 'dsh-skills-mcp-group-manager');
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
});

test('apply() wires locale, stylesheet, and the slot registrations', () => {
  const { plugin, styleTags } = evaluateBundle();
  const localeRegs = [];
  const slotInjects = [];
  const slotRegs = [];
  const effects = [];
  const ctx = {
    effect: (callback, label) => {
      const disposer = callback();
      effects.push({ label, disposer });
      return disposer;
    },
    locale: {
      register: (ns, dicts) => {
        localeRegs.push({ ns, dicts });
        return () => {};
      },
      bind: (ns) => (key) => localeRegs[0]?.dicts.en[key] ?? key,
    },
    slots: {
      inject: (key, callback) => { slotInjects.push({ key, callback }); },
      register: (options, component) => { slotRegs.push({ options, component }); return () => {}; },
    },
  };
  plugin.apply(ctx);

  // locale dictionaries
  assert.equal(localeRegs.length, 1);
  assert.equal(localeRegs[0].ns, 'mcp-skill-manager');
  assert.equal(typeof localeRegs[0].dicts.zh, 'object');
  assert.equal(typeof localeRegs[0].dicts.en, 'object');
  assert.equal(localeRegs[0].dicts.zh['navGroups'], '技能分组');
  assert.equal(localeRegs[0].dicts.en['navGroups'], 'Skill groups');

  // stylesheet: one style tag, fiber-scoped disposer removes it
  assert.equal(styleTags.length, 1);
  assert.equal(styleTags[0].dataset.plugin, 'dsh-skills-mcp-group-manager');
  assert.equal(styleTags[0].dataset.pluginCss, 'dsh-skills-mcp-group-manager/panel.css');
  assert.ok(styleTags[0].textContent.includes('.msm-settings'));
  assert.ok(!styleTags[0].textContent.includes('.msm-panel'), 'panel chrome styles are gone');
  assert.ok(styleTags[0].textContent.includes('var(--dsw-alias-'));
  // regression guard: the client must never mutate product layout via
  // `data-phase` selectors or root CSS variables (caused app-wide flicker
  // and broke session transitions in the real GUI)
  assert.ok(!styleTags[0].textContent.includes('data-phase'), 'no data-phase product-layout interference');
  assert.ok(!styleTags[0].textContent.includes('--mcp-skill-manager-panel-shift'), 'no root shift variable');
  const styleEffect = effects.find((effect) => effect.label === 'mcp-skill-manager: styles');
  assert.ok(styleEffect, 'stylesheet effect registered');
  styleEffect.disposer();
  assert.equal(styleTags.length, 0, 'stylesheet disposer removes the tag');

  // slot declarations: two settings sections + the session header button
  assert.deepEqual(slotInjects.map((entry) => entry.key), [
    'settings.section',
    'settings.section',
    'conversation.session.header.actions',
  ]);
  for (const { callback } of slotInjects) callback();
  assert.equal(slotRegs.length, 3);

  const groups = slotRegs.find((entry) => entry.options.id === 'skill-groups');
  assert.ok(groups, 'skill-groups settings section present');
  assert.equal(groups.options.name, 'settings.section');
  assert.equal(groups.options.order, 17);
  assert.equal(groups.options.locale, 'mcp-skill-manager');
  assert.equal(groups.options.label(), 'Skill groups');
  assert.equal(typeof groups.component, 'function');

  const mcp = slotRegs.find((entry) => entry.options.id === 'mcp');
  assert.ok(mcp, 'mcp settings section present');
  assert.equal(mcp.options.name, 'settings.section');
  assert.equal(mcp.options.order, 18);
  assert.equal(mcp.options.locale, 'mcp-skill-manager');
  assert.equal(mcp.options.label(), 'MCP');
  assert.equal(typeof mcp.component, 'function');

  const toggle = slotRegs.find((entry) => entry.options.id === 'mcp-skill-manager-toggle');
  assert.ok(toggle, 'header toggle registration present');
  assert.equal(toggle.options.name, 'conversation.session.header.actions');
  assert.equal(toggle.options.order, 10);
  assert.equal(typeof toggle.component, 'function');
});
