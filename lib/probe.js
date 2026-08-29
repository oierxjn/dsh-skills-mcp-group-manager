/**
 * Live MCP connectivity probe used by the "Test connection" action.
 *
 * A probe opens an independent MCP client connection (never touching the
 * running mcp-client instance for that server), performs `initialize` +
 * `tools/list` under a hard timeout, then closes the transport cleanly. For
 * stdio servers the child process is spawned and killed by the probe itself;
 * for streamable-http it is a short-lived HTTP session.
 *
 * The MCP SDK is imported lazily: a `link:` install has no node_modules next
 * to the plugin source, and a probe must report that as a normal failure
 * instead of killing the whole plugin at import time.
 *
 * @module dsh-skills-mcp-group-manager/probe
 */

/** Default probe budget in ms. */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * The child's environment for a stdio probe. The MCP SDK uses `env` as the
 * child's FULL environment (it only inherits the host environment when `env`
 * is undefined), and the panel defines `env` as "overrides" — so an empty or
 * missing override map must become `undefined` (inherit), never `{}` (which
 * would strip PATH and make npx-style commands unspawnable).
 * @param overrides - the config's env overrides (string-to-string map).
 * @returns undefined to inherit the host environment, or the merged map.
 */
export function stdioEnv(overrides) {
  if (overrides === undefined || Object.keys(overrides).length === 0) return undefined;
  return { ...process.env, ...overrides };
}

/**
 * Run a connectivity probe against the given server config.
 * @param config - resolved server config (transport/url/command/...).
 * @param timeoutMs - hard timeout for connect + list.
 * @returns the probe outcome; never throws.
 */
export async function probeServer(config, timeoutMs = PROBE_TIMEOUT_MS) {
  const started = Date.now();
  const finish = (result) => ({ ...result, latencyMs: Date.now() - started });
  const withTimeout = (promise) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`probe timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });

  let client;
  try {
    const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    client = new Client(
      { name: 'dsh-skills-mcp-group-manager-probe', version: '0.1.0' },
      { capabilities: {} },
    );
    let transport;
    if (config.transport === 'stdio') {
      transport = new StdioClientTransport({
        command: config.command ?? '',
        args: config.args,
        env: stdioEnv(config.env),
        cwd: config.cwd,
      });
    } else {
      transport = new StreamableHTTPClientTransport(
        new URL(config.url ?? ''),
        { requestInit: { headers: config.headers ?? {} } },
      );
    }
    await withTimeout(client.connect(transport));
    const tools = await withTimeout(client.listTools());
    const toolCount = Array.isArray(tools?.tools) ? tools.tools.length : 0;
    return finish({ ok: true, toolCount });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish({ ok: false, error: message });
  } finally {
    try {
      await client?.close();
    } catch {
      /* probe already reported; ignore close noise */
    }
  }
}
