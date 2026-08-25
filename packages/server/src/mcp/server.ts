import type { IndexDatabase } from '@backstory/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  memoryContext,
  memoryGet,
  memoryRecent,
  memoryRejected,
  memorySearch,
  type ToolContext,
} from './tools.js';

export const MCP_TOOL_NAMES = [
  'memory_search',
  'memory_get',
  'memory_context',
  'memory_rejected',
  'memory_recent',
] as const;

/**
 * Read-only retrieval for a consuming agent.
 *
 * There is no tool that writes. Records are created by distillation and nothing
 * else, so there is exactly one write path with one set of reliability
 * characteristics. A second path where an agent decides what to record would
 * have different failure modes, different attribution, and no way to tell the
 * two apart afterwards.
 */
export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'backstory', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

  server.tool(
    'memory_search',
    'Search prior decisions, discoveries, questions, actions and outcomes recorded for this repository.',
    { query: z.string().describe('what to look for'), limit: z.number().int().min(1).max(100).optional() },
    async ({ query, limit }) => text(memorySearch(context, query, limit)),
  );

  server.tool(
    'memory_get',
    'Fetch one record by its id.',
    { id: z.string().describe('record id, for example dec-20260825-a3f21b04') },
    async ({ id }) => text(memoryGet(context, id)),
  );

  server.tool(
    'memory_context',
    'What was previously decided about a topic, file path, or feature, including options that were ruled out. Consult this before proposing an approach.',
    { topic: z.string().describe('a topic, feature name, or file path'), limit: z.number().int().min(1).max(50).optional() },
    async ({ topic, limit }) => text(memoryContext(context, topic, limit)),
  );

  server.tool(
    'memory_rejected',
    'Options that were considered and not taken, with the reason each was dropped.',
    { topic: z.string().describe('a topic or approach'), limit: z.number().int().min(1).max(50).optional() },
    async ({ topic, limit }) => text(memoryRejected(context, topic, limit)),
  );

  server.tool(
    'memory_recent',
    'The most recently recorded memory for this repository.',
    { limit: z.number().int().min(1).max(50).optional() },
    async ({ limit }) => text(memoryRecent(context, limit)),
  );

  return server;
}

export async function serveMcpOverStdio(db: IndexDatabase): Promise<void> {
  const server = createMcpServer({ db });
  await server.connect(new StdioServerTransport());
}
