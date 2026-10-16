import { createInterface } from 'node:readline';
import { TOOLS, callTool, closeDashboards } from './tools.mjs';
import { listSessions, getSession } from './session.mjs';
import { VERSION } from './version.mjs';

const PROTOCOL = '2025-06-18';

export function startMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input, crlfDelay: Infinity });

  const handle = async (msg) => {
    const { id, method, params } = msg;
    const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: params?.protocolVersion ?? PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'sherlock', version: VERSION },
            instructions:
              'Sherlock profiles apps: startup time, CPU, memory, memory bandwidth, GPU and network, live. Start with sherlock_detect, then launch/attach/web/ios/android, open sherlock_dashboard, mark interactions, and write your diagnosis with sherlock_note.',
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return;
        case 'ping':
          return reply({});
        case 'tools/list':
          return reply({
            tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
          });
        case 'tools/call': {
          try {
            const result = await callTool(params.name, params.arguments ?? {});
            return reply({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] });
          } catch (err) {
            return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
          }
        }
        default:
          if (id !== undefined) fail(-32601, `Method not found: ${method}`);
      }
    } catch (err) {
      fail(-32603, err.message);
    }
  };

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(msg)) msg.forEach(handle);
    else handle(msg);
  });

  const shutdown = async () => {
    for (const s of listSessions()) getSession(s.id)?.stop();
    await closeDashboards();
    process.exit(0);
  };
  rl.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
