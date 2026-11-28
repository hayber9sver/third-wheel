/**
 * Entry point: `node packages/mcp-server/build/third-wheel-mcp.js` (built by `pnpm build:mcp`).
 * Speaks MCP over stdio; each tool call talks to the running app over the bridge.
 * Never write to stdout here — it carries the MCP messages.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connectBridge } from './bridge-client.js';
import { createToolServer } from './tools.js';

const server = createToolServer({ connect: () => connectBridge(), hello: true });
await server.connect(new StdioServerTransport());
console.error('Third Wheel MCP server ready (stdio)');
