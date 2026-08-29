// Run every tool schema the plugin registers through the REAL dsh-tools
// assertSupportedJsonSchema of an installed harness:
//   node scripts/check-tool-schemas.mjs [path-to-dsh-tools/lib/index.js]
// (or set DSH_TOOLS). Defaults to the last known local install path.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-schema-check-'));

const dshToolsPath = process.argv[2]
  ?? process.env.DSH_TOOLS
  ?? 'D:/Temp/T/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
const tools = await import(pathToFileURL(dshToolsPath).href);
const { apply } = await import('../lib/index.js');

const registered = [];
const fakeCtx = {
  logger: { warn() {}, info() {}, error() {}, debug() {} },
  tools: {
    register(def) { registered.push(def); return () => {}; },
  },
  agents: { list: () => [] },
  loader: { entries: () => [] },
  on: () => {},
  effect: (fn) => { if (typeof fn === 'function') fn(); },
  get: () => undefined,
};

apply(fakeCtx, {});

let failures = 0;
for (const def of registered) {
  for (const [label, schema] of [['parameters', def.parameters], ['output', def.output?.schema]]) {
    if (schema === undefined) continue;
    try {
      tools.assertSupportedJsonSchema(schema);
      console.log(`ok    ${def.name} ${label}`);
    } catch (error) {
      failures += 1;
      console.log(`FAIL  ${def.name} ${label}: ${error.message}`);
    }
  }
}
console.log(failures === 0 ? `\nall ${registered.length} tools pass` : `\n${failures} schema failure(s)`);
process.exit(failures ===  0 ? 0 : 1);
