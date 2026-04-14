/**
 * Memory MCP Server for NanoClaw
 *
 * Exposes explicit memory tools to the agent so it can manage its own
 * long-term memory instead of relying solely on auto-extraction:
 *
 *   memory_store   — save a durable fact or preference
 *   memory_list    — list all stored memories
 *   memory_search  — keyword search over stored memories
 *   memory_forget  — delete by ID or text match
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const MEMORIES_FILE = '/workspace/group/.mem0/memories.json';

interface MemoryEntry {
  id: string;
  text: string;
  createdAt: string;
  embedding?: number[];
}

function loadMemories(): MemoryEntry[] {
  try {
    if (!fs.existsSync(MEMORIES_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(MEMORIES_FILE, 'utf-8'));
    if (!Array.isArray(data)) return [];
    return data.map((e: Record<string, unknown>, i: number) => ({
      id:        (e.id as string)        || String(i),
      text:      (e.text as string)      || String(e),
      createdAt: (e.createdAt as string) || '',
      embedding: e.embedding as number[] | undefined,
    }));
  } catch {
    return [];
  }
}

function saveMemories(entries: MemoryEntry[]): void {
  fs.mkdirSync(path.dirname(MEMORIES_FILE), { recursive: true });
  const tmp = MEMORIES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, MEMORIES_FILE);
}

const server = new McpServer({ name: 'nanoclaw-memory', version: '1.0.0' });

// ─── memory_store ────────────────────────────────────────────────────────────

server.tool(
  'memory_store',
  [
    'Save an important fact or preference to long-term memory.',
    'Use this when you learn something durable about the user that is worth remembering',
    'across future sessions — preferences, named entity mappings, recurring patterns.',
    'Do NOT store transient states like device on/off or temporary situations.',
  ].join(' '),
  { text: z.string().describe('The fact or preference to remember') },
  async ({ text }) => {
    const memories = loadMemories();
    // Skip near-exact duplicates
    const dup = memories.find(
      (m) => m.text.toLowerCase().trim() === text.toLowerCase().trim(),
    );
    if (dup) {
      return { content: [{ type: 'text' as const, text: `Already stored: "${dup.text}"` }] };
    }
    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      text: text.trim(),
      createdAt: new Date().toISOString(),
    };
    memories.push(entry);
    saveMemories(memories);
    return { content: [{ type: 'text' as const, text: `Stored (id: ${entry.id}): "${entry.text}"` }] };
  },
);

// ─── memory_list ─────────────────────────────────────────────────────────────

server.tool(
  'memory_list',
  'List all stored long-term memories for this user.',
  {},
  async () => {
    const memories = loadMemories();
    if (memories.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No memories stored.' }] };
    }
    const lines = memories.map((m, i) => `${i + 1}. [${m.id}] ${m.text}`);
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ─── memory_search ───────────────────────────────────────────────────────────

server.tool(
  'memory_search',
  'Search stored memories by keyword. Returns memories whose text contains the query.',
  { query: z.string().describe('Search terms') },
  async ({ query }) => {
    const memories = loadMemories();
    const q = query.toLowerCase();
    const hits = memories.filter((m) => m.text.toLowerCase().includes(q));
    if (hits.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No matching memories.' }] };
    }
    const lines = hits.map((m) => `[${m.id}] ${m.text}`);
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ─── memory_forget ───────────────────────────────────────────────────────────

server.tool(
  'memory_forget',
  [
    'Delete a stored memory.',
    'Pass the memory ID (from memory_list) for an exact delete,',
    'or pass a text fragment to delete all memories whose text contains it.',
  ].join(' '),
  { id_or_text: z.string().describe('Memory ID or text fragment to match') },
  async ({ id_or_text }) => {
    const memories = loadMemories();
    const before = memories.length;
    const q = id_or_text.toLowerCase();
    const kept = memories.filter(
      (m) => m.id !== id_or_text && !m.text.toLowerCase().includes(q),
    );
    if (kept.length === before) {
      return { content: [{ type: 'text' as const, text: 'No matching memory found.' }] };
    }
    saveMemories(kept);
    return {
      content: [{
        type: 'text' as const,
        text: `Deleted ${before - kept.length} memory/memories.`,
      }],
    };
  },
);

// ─── Start server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
