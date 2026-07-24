// fuaran-mcp — the stdio executable an MCP host launches.
//
// stdout belongs to the protocol; anything human-facing goes to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createFuaranMcpServer } from './server.js';

const server = createFuaranMcpServer();
await server.connect(new StdioServerTransport());
console.error('fuaran mcp server running on stdio');
