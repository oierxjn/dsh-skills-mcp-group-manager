/**
 * Unit tests for the pure state logic of the dsh-mcp-skill-manager host half.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTRY_ID_PATTERN,
  SERVER_NAME_PATTERN,
  addSkillsToGroup,
  enabledSkillNames,
  enabledSkillNamesFor,
  groupById,
  isValidServerName,
  pickServerConfig,
  removeSkillsFromGroup,
  snapshotState,
  validateMcpConfig,
} from '../lib/state.js';

const emptyState = () => ({ groups: [] });

test('enabledSkillNames: union across enabled groups, deduped', () => {
  const state = {
    groups: [
      { id: 'a', name: 'A', enabled: true, skills: ['skill-one', 'skill-two'] },
      { id: 'b', name: 'B', enabled: true, skills: ['skill-two', 'skill-three'] },
    ],
  };
  const set = enabledSkillNames(state);
  assert.deepEqual([...set].sort(), ['skill-one', 'skill-three', 'skill-two']);
});

test('enabledSkillNames: disabled groups contribute nothing', () => {
  const state = {
    groups: [
      { id: 'a', name: 'A', enabled: false, skills: ['skill-one'] },
      { id: 'b', name: 'B', enabled: true, skills: ['skill-two'] },
    ],
  };
  assert.deepEqual([...enabledSkillNames(state)], ['skill-two']);
});

test('enabledSkillNames: empty state yields empty set', () => {
  assert.equal(enabledSkillNames(emptyState()).size, 0);
});

const sessionState = () => ({
  groups: [
    { id: 'a', name: 'A', enabled: true, skills: ['skill-one'] },
    { id: 'b', name: 'B', enabled: false, skills: ['skill-two'] },
  ],
  sessions: {},
});

test('enabledSkillNamesFor: no override follows the global union', () => {
  const state = sessionState();
  assert.deepEqual([...enabledSkillNamesFor(state, 's1')], ['skill-one']);
  // a state without the sessions key at all (legacy shape) also follows
  assert.deepEqual([...enabledSkillNamesFor({ groups: state.groups }, 's1')], ['skill-one']);
});

test('enabledSkillNamesFor: an override replaces the global selection', () => {
  const state = sessionState();
  state.sessions.s1 = { enabledGroupIds: ['a'] };
  assert.deepEqual([...enabledSkillNamesFor(state, 's1')], ['skill-one']);
  // other sessions still follow the global union
  assert.deepEqual([...enabledSkillNamesFor(state, 's2')], ['skill-one']);
  // the override detaches from global toggles: a globally disabled group
  // listed in the override still contributes its skills
  state.sessions.s3 = { enabledGroupIds: ['b'] };
  assert.deepEqual([...enabledSkillNamesFor(state, 's3')], ['skill-two']);
});

test('enabledSkillNamesFor: an empty override injects nothing', () => {
  const state = sessionState();
  state.sessions.s1 = { enabledGroupIds: [] };
  assert.equal(enabledSkillNamesFor(state, 's1').size, 0);
});

test('enabledSkillNamesFor: deleted group ids are dropped on read', () => {
  const state = sessionState();
  state.sessions.s1 = { enabledGroupIds: ['a', 'ghost'] };
  assert.deepEqual([...enabledSkillNamesFor(state, 's1')], ['skill-one']);
});

test('groupById finds entries and misses cleanly', () => {
  const state = {
    groups: [{ id: 'g1', name: 'G1', enabled: true, skills: [] }],
  };
  assert.equal(groupById(state, 'g1').name, 'G1');
  assert.equal(groupById(state, 'nope'), undefined);
});

test('isValidServerName: domain matches dsh-mcp-client', () => {
  assert.equal(SERVER_NAME_PATTERN.source, '^[A-Za-z0-9_-]{1,32}$');
  assert.ok(isValidServerName('github'));
  assert.ok(isValidServerName('my_server-2'));
  assert.ok(!isValidServerName('has space'));
  assert.ok(!isValidServerName(''));
  assert.ok(!isValidServerName('x'.repeat(33)));
  assert.ok(!isValidServerName(42));
});

test('validateMcpConfig: valid stdio and streamable-http configs pass', () => {
  assert.deepEqual(validateMcpConfig('mcp-github', {
    serverName: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { KEY: 'value' },
    cwd: '/tmp',
  }), {});
  assert.deepEqual(validateMcpConfig('mcp-x', {
    serverName: 'srv',
    transport: 'streamable-http',
    url: 'https://x/mcp',
    headers: { Authorization: 'Bearer t' },
    toolCallTimeoutMs: 5000,
  }), {});
});

test('validateMcpConfig: field-level errors keyed by field', () => {
  const errors = validateMcpConfig('bad id!', {
    serverName: 'has space',
    transport: 'stdio',
    args: [1],
    cwd: 42,
    env: { K: 1 },
    headers: 'nope',
    toolCallTimeoutMs: 0,
  });
  assert.match(errors.id, /Entry id/);
  assert.match(errors.serverName, /serverName/);
  assert.match(errors.command, /command/);
  assert.match(errors.args, /args/);
  assert.match(errors.cwd, /cwd/);
  assert.match(errors.env, /env/);
  assert.match(errors.headers, /headers/);
  assert.match(errors.toolCallTimeoutMs, /toolCallTimeoutMs/);
  assert.equal(errors.url, undefined, 'stdio does not require url');
});

test('validateMcpConfig: streamable-http requires an http(s) URL', () => {
  assert.match(validateMcpConfig('mcp-x', { serverName: 'srv', transport: 'streamable-http' }).url, /URL/);
  assert.match(validateMcpConfig('mcp-x', { serverName: 'srv', transport: 'streamable-http', url: 'ftp://x' }).url, /URL/);
  assert.equal(ENTRY_ID_PATTERN.source, '^[A-Za-z0-9_-]{1,64}$');
});

test('pickServerConfig: picks known fields verbatim, defaults transport', () => {
  const config = pickServerConfig({
    id: 'ignored',
    serverName: 'srv',
    transport: 'stdio',
    command: 'npx',
    args: ['a'],
    env: { K: 'v' },
    url: 'https://kept-verbatim',
    unknownField: 'dropped',
  });
  assert.deepEqual(config, {
    serverName: 'srv',
    transport: 'stdio',
    command: 'npx',
    args: ['a'],
    env: { K: 'v' },
    url: 'https://kept-verbatim',
  });
  // Unknown transport coerces to streamable-http (validateMcpConfig then
  // requires the url, same as the dsh-mcp-client schema default).
  assert.equal(pickServerConfig({ serverName: 'srv', transport: 'bogus' }).transport, 'streamable-http');
});

test('snapshotState: fresh JSON copies, no shared references', () => {
  const state = {
    groups: [{ id: 'g1', name: 'G1', enabled: true, skills: ['s1'] }],
    sessions: { sess1: { enabledGroupIds: ['g1'] } },
  };
  const snap = snapshotState(state);
  assert.deepEqual(snap, state);
  assert.notEqual(snap.groups, state.groups);
  assert.notEqual(snap.groups[0].skills, state.groups[0].skills);
  assert.notEqual(snap.sessions, state.sessions);
  assert.notEqual(snap.sessions.sess1.enabledGroupIds, state.sessions.sess1.enabledGroupIds);
  // mutating the snapshot must not touch the source
  snap.groups[0].skills.push('s2');
  snap.sessions.sess1.enabledGroupIds.push('ghost');
  assert.deepEqual(state.groups[0].skills, ['s1']);
  assert.deepEqual(state.sessions.sess1.enabledGroupIds, ['g1']);
});

test('snapshotState: a state without the sessions key projects an empty map', () => {
  const snap = snapshotState({ groups: [] });
  assert.deepEqual(snap, { groups: [], sessions: {} });
});

test('addSkillsToGroup: appends multiple names in one immutable update, deduped', () => {
  const state = { groups: [{ id: 'g1', name: 'G1', enabled: true, skills: ['a'] }] };
  const next = addSkillsToGroup(state, 'g1', ['b', 'c', 'a']);
  assert.deepEqual(next.groups[0].skills, ['a', 'b', 'c']);
  // duplicates WITHIN the input array are also dropped
  const next2 = addSkillsToGroup(state, 'g1', ['b', 'b', 'c', 'b']);
  assert.deepEqual(next2.groups[0].skills, ['a', 'b', 'c']);
  // immutability: the source state is untouched
  assert.deepEqual(state.groups[0].skills, ['a']);
  assert.notEqual(next.groups, state.groups);
  // unknown group: throws
  assert.throws(() => addSkillsToGroup(state, 'nope', ['x']), (error) => error.code === 'not-found' && /does not exist/.test(error.message));
});

test('removeSkillsFromGroup: removes multiple names in one immutable update', () => {
  const state = { groups: [{ id: 'g1', name: 'G1', enabled: true, skills: ['a', 'b', 'c'] }] };
  const next = removeSkillsFromGroup(state, 'g1', ['a', 'c']);
  assert.deepEqual(next.groups[0].skills, ['b']);
  assert.deepEqual(state.groups[0].skills, ['a', 'b', 'c']);
  assert.throws(() => removeSkillsFromGroup(state, 'nope', ['x']), (error) => error.code === 'not-found' && /does not exist/.test(error.message));
});
