/**
 * OpenRouter Agent Runner
 * Uses OpenAI-compatible API to run non-Claude models via OpenRouter.
 * Implements the same input/output protocol as the Claude agent runner.
 *
 * Memory layers:
 *   1. Short-term  — last N messages persisted to /workspace/group/.openrouter-session.json
 *                    Survives container restarts within the same session window.
 *   2. Long-term   — mem0ai/oss extracts semantic memories (facts, preferences, context)
 *                    from each completed session using a configurable LLM (OpenRouter).
 *                    Memories are stored locally in /workspace/group/.mem0/memories.json.
 *                    No external services, no API keys beyond OpenRouter.
 *
 * MCP integration:
 *   Starts the nanoclaw IPC MCP server as a subprocess and exposes all its tools
 *   (send_message, schedule_task, list_tasks, …) via OpenAI function calling.
 *   New MCP tools are discovered automatically via client.listTools() — no hardcoding.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Memory } from 'mem0ai/oss';
import { GoogleGenAI } from '@google/genai';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionHistory {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  updatedAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const MAX_TOOL_CALLS = 50;
const BASH_TIMEOUT_MS = 30_000;
const MAX_HISTORY_MESSAGES = 8;
// Session older than this is discarded — forces a fresh context after long inactivity.
// Matches the container IDLE_TIMEOUT default (30min) with a multiplier so the session
// survives a brief idle but not an overnight gap.
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const SESSION_FILE = '/workspace/group/.openrouter-session.json';
const MEM0_DIR = '/workspace/group/.mem0';
const MEMORIES_FILE = path.join(MEM0_DIR, 'memories.json');

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(msg: string): void {
  console.error(`[openrouter-runner] ${msg}`);
}

// ─── Short-term session persistence ──────────────────────────────────────────

function loadSessionHistory(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  try {
    if (!fs.existsSync(SESSION_FILE)) return [];
    const data: SessionHistory = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    const ageMs = Date.now() - new Date(data.updatedAt).getTime();
    if (ageMs > SESSION_MAX_AGE_MS) {
      log(`Session expired (age: ${Math.round(ageMs / 60000)}min > ${SESSION_MAX_AGE_MS / 60000}min limit) — starting fresh`);
      fs.unlinkSync(SESSION_FILE);
      return [];
    }
    log(`Loaded ${data.messages.length} messages from session history (${data.updatedAt})`);
    return data.messages;
  } catch (err) {
    log(`Failed to load session history: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function saveSessionHistory(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): void {
  try {
    // Filter out assistant messages with null/empty content and no tool_calls — these
    // are corrupted entries (e.g. thinking-only model responses) that confuse subsequent runs.
    const clean = messages.filter((m) => {
      if (m.role !== 'assistant') return true;
      const hasContent = m.content !== null && m.content !== undefined && m.content !== '';
      const hasCalls = Array.isArray((m as { tool_calls?: unknown[] }).tool_calls) && (m as { tool_calls?: unknown[] }).tool_calls!.length > 0;
      return hasContent || hasCalls;
    });
    // Slice to the last N messages, then strip any leading tool/orphaned messages so
    // the history always starts with a 'user' message. Without this, when a long
    // conversation is trimmed from the front, orphaned 'tool' messages (whose parent
    // assistant tool_call was cut off) cause a 400 from the provider.
    let trimmed = clean.slice(-MAX_HISTORY_MESSAGES);
    const firstUserIdx = trimmed.findIndex((m) => m.role === 'user');
    // If there's no user message at all (e.g. history is only tool/assistant fragments
    // from a crashed mid-tool-call run), discard the whole history — it's unsalvageable.
    if (firstUserIdx === -1) { trimmed = []; }
    else if (firstUserIdx > 0) trimmed = trimmed.slice(firstUserIdx);
    const tmp = SESSION_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ messages: trimmed, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, SESSION_FILE);
  } catch (err) {
    log(`Failed to save session history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Long-term memory (mem0ai/oss — local, no cloud) ─────────────────────────

interface StoredMemoryEntry {
  id?: string;
  text: string;
  createdAt?: string;
  embedding?: number[];
}

/** Load raw memory entries (text + optional embedding) from JSON file */
function loadMemoryEntries(): StoredMemoryEntry[] {
  try {
    if (!fs.existsSync(MEMORIES_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(MEMORIES_FILE, 'utf-8'));
    // Support both legacy string[] and new {text, embedding}[] format
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
      return (data as string[]).map((text) => ({ text }));
    }
    return Array.isArray(data) ? (data as StoredMemoryEntry[]) : [];
  } catch (err) {
    log(`Failed to load memories: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Compute Gemini embedding for a text string */
async function computeEmbedding(text: string, googleApiKey: string, model: string): Promise<number[] | null> {
  try {
    const genai = new GoogleGenAI({ apiKey: googleApiKey });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (genai.models.embedContent as (opts: any) => Promise<any>)({
      model,
      contents: text,
      config: { outputDimensionality: GEMINI_EMBEDDING_DIMS },
    });
    return result.embeddings?.[0]?.values ?? null;
  } catch (err) {
    log(`Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Cosine similarity between two vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

/**
 * Load the most relevant memories for a given query using semantic search.
 * Returns an empty list if embeddings are unavailable rather than falling back
 * to unfiltered results, which would inject irrelevant context.
 */
async function loadRelevantMemories(
  query: string,
  googleApiKey: string | undefined,
  embedderModel: string,
  topK = 4,
): Promise<string[]> {
  const entries = loadMemoryEntries();
  if (entries.length === 0) return [];
  log(`Loaded ${entries.length} long-term memories from ${MEMORIES_FILE}`);

  // Without a Google API key we can't do semantic search — return nothing rather
  // than dumping all memories and injecting irrelevant context.
  if (!googleApiKey) {
    log('No Google API key — skipping memory retrieval to avoid irrelevant context');
    return [];
  }

  // Compute query embedding
  const queryEmbedding = await computeEmbedding(query, googleApiKey, embedderModel);
  if (!queryEmbedding) {
    log('Query embedding failed — skipping memory retrieval to avoid irrelevant context');
    return [];
  }

  // Score each memory by similarity
  const scored = entries.map((entry) => ({
    text: entry.text,
    score: entry.embedding ? cosineSimilarity(queryEmbedding, entry.embedding) : -1,
  }));

  // Sort descending by score, take top 4
  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.slice(0, topK).filter((m) => m.score > 0);
  log(`Semantic search: top ${relevant.length}/${entries.length} memories selected`);
  return relevant.map((m) => m.text);
}

/** Format memory strings as an XML context block for JIT injection */
function formatMemoryContext(memories: string[]): string {
  const items = memories.map((m) => `    - ${m}`).join('\n');
  return `<context>\n  <relevant_memories>\n${items}\n  </relevant_memories>\n</context>\n\n`;
}

/** Strip all injected <context>…</context> blocks from a single content string */
function stripMemoryContext(content: string): string {
  return content.replace(/<context>[\s\S]*?<\/context>\n\n/g, '').replace(/<context>[\s\S]*?<\/context>/g, '').trimStart();
}

/**
 * JIT injection: find the last user message, query mem0 for relevant memories
 * using that message as the semantic query, and prepend the XML context block.
 * Mutates the messages array in-place.
 */
async function injectJitMemoryContext(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  googleApiKey: string | undefined,
  embedderModel: string,
): Promise<void> {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return;

  const lastUserMsg = messages[lastUserIdx];
  if (typeof lastUserMsg.content !== 'string') return;

  const memories = await loadRelevantMemories(lastUserMsg.content, googleApiKey, embedderModel);
  if (memories.length === 0) return;

  messages[lastUserIdx] = { ...lastUserMsg, content: formatMemoryContext(memories) + lastUserMsg.content };
  log(`JIT: prepended ${memories.length} relevant memories to user message`);
}

/**
 * Strip all <context> blocks from every user message before persisting to
 * session history — prevents exponential token bloat across turns.
 */
function stripAllMemoryContexts(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('<context>')) {
      messages[i] = { ...m, content: stripMemoryContext(m.content) };
    }
  }
}

/** Persist memory entries with embeddings to JSON file.
 *
 * Merges auto-extracted texts with any entries the agent explicitly saved
 * via memory_store during the session. Agent-stored entries (which have an id)
 * take precedence and are never overwritten by auto-extraction.
 */
async function saveStoredMemories(
  memories: string[],
  googleApiKey: string | undefined,
  embedderModel: string,
): Promise<void> {
  try {
    fs.mkdirSync(MEM0_DIR, { recursive: true });

    // Load CURRENT file — includes any memory_store calls made during the session
    const current = loadMemoryEntries();

    // Build a lookup by text for reusing cached embeddings and preserving IDs
    const byText = new Map(current.map((e) => [e.text.toLowerCase().trim(), e]));

    // Union: keep all current entries + add auto-extracted texts not already present
    const merged = new Map(current.map((e) => [e.text.toLowerCase().trim(), e]));
    for (const text of memories) {
      const key = text.toLowerCase().trim();
      if (!merged.has(key)) {
        merged.set(key, { text });
      }
    }

    // Compute embeddings for entries that are missing them
    const entries: StoredMemoryEntry[] = await Promise.all(
      Array.from(merged.values()).map(async (entry) => {
        if (entry.embedding) return entry; // already have embedding
        if (!googleApiKey) return entry;
        const embedding = await computeEmbedding(entry.text, googleApiKey, embedderModel) ?? undefined;
        return { ...entry, embedding };
      }),
    );

    // Suppress unused variable warning
    void byText;

    const tmp = MEMORIES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
    fs.renameSync(tmp, MEMORIES_FILE);
    log(`Saved ${entries.length} memories (${memories.length} auto-extracted, ${current.length} prior) to ${MEMORIES_FILE}`);
  } catch (err) {
    log(`Failed to save memories: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Build a mem0ai/oss Memory instance backed by an in-memory vector store.
 * We use mem0 solely for its LLM-powered extraction + deduplication logic.
 * Persistence is handled separately via saveStoredMemories().
 */
const GEMINI_EMBEDDING_DIMS = 768;

function buildMem0(openRouterApiKey: string, llmModel: string, baseURL?: string): Memory {
  const googleApiKey = process.env.GOOGLE_API_KEY;
  if (!googleApiKey) throw new Error('GOOGLE_API_KEY not set — required for mem0 embeddings');

  return new Memory({
    llm: {
      provider: 'openai',
      config: {
        apiKey: openRouterApiKey,
        baseURL: baseURL || 'https://openrouter.ai/api/v1',
        model: llmModel,
      },
    },
    embedder: {
      provider: 'gemini',
      config: {
        apiKey: googleApiKey,
        model: process.env.MEM0_EMBEDDER_MODEL || 'gemini-embedding-2-preview',
        embeddingDims: GEMINI_EMBEDDING_DIMS,
      },
    },
    vectorStore: {
      provider: 'memory',
      config: { collectionName: 'nanoclaw', dimension: GEMINI_EMBEDDING_DIMS },
    },
    disableHistory: true,
    customPrompt: `You extract durable, reusable facts about the user from conversations.

EXTRACT only things that are useful to know across future sessions:
- User preferences and habits (e.g. "prefers the lights dimmed in the evening")
- Named entity mappings (e.g. "kv gep Socket = coffee machine smart plug in Home Assistant")
- Recurring routines or behavioural patterns across multiple sessions
- Important personal context (people, places, projects the user cares about)

DO NOT EXTRACT:
- Current device states (on/off, temperature readings, sensor values) — these are transient and change constantly
- Anything described as temporary or one-off ("ideiglenesen", "most", "egy rövid időre")
- Trivial observations about what just happened in this conversation (the agent already has the full history)
- Generic patterns like "user asks to turn things on/off" — this adds no useful context

Return valid JSON with a 'facts' key containing an array of concise strings.`,
  });
}

/**
 * Extract new memories from the conversation using mem0ai/oss.
 * Returns deduplicated list of memory strings.
 *
 * We initialize a fresh in-memory instance per session — we only need mem0
 * for extraction quality, not for cross-session search. The returned texts
 * are then merged with existing memories and saved to disk.
 */
async function extractMemories(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  existing: string[],
  apiKey: string,
  llmModel: string,
  userId: string,
  baseURL?: string,
): Promise<string[]> {
  try {
    // Extract new facts from THIS session only — never feed existing memories into mem0,
    // as its deduplication LLM merges/deletes them unpredictably causing net memory loss.
    const convMessages = messages.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0,
    );
    if (convMessages.length === 0) {
      log('No conversation messages to extract memories from');
      return existing;
    }

    const mem = buildMem0(apiKey, llmModel, baseURL);
    await mem.add(convMessages as { role: 'user' | 'assistant'; content: string }[], { userId });

    const all = await mem.getAll({ userId });
    const results = (all as { results?: { memory?: string }[] }).results ?? [];
    const newlyExtracted = results
      .map((r) => r.memory ?? '')
      .filter((m) => m.length > 0);

    log(`Extracted ${newlyExtracted.length} new memories from session`);

    // Merge: keep all existing, append new ones that aren't near-duplicates
    const merged = [...existing];
    for (const candidate of newlyExtracted) {
      const isDuplicate = existing.some(
        (e) => e.toLowerCase().includes(candidate.toLowerCase().slice(0, 20)) ||
               candidate.toLowerCase().includes(e.toLowerCase().slice(0, 20)),
      );
      if (!isDuplicate) {
        merged.push(candidate);
        log(`New memory added: ${candidate.slice(0, 80)}`);
      }
    }

    log(`Memory store: ${existing.length} existing + ${merged.length - existing.length} new = ${merged.length} total`);
    return merged;
  } catch (err) {
    log(`Memory extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return existing; // Keep existing on failure
  }
}

// ─── Local tools ──────────────────────────────────────────────────────────────

const LOCAL_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a bash command in the container sandbox. Working directory: /workspace/group.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The bash command to run' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating it if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace a string in a file (first occurrence).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old_string: { type: 'string', description: 'Exact string to find' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the content of a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL to fetch' } },
        required: ['url'],
      },
    },
  },
];

function executeBash(command: string): string {
  try {
    return execSync(command, {
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
      encoding: 'utf8',
      cwd: '/workspace/group',
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return (e.stdout || '') + (e.stderr ? `\nSTDERR: ${e.stderr}` : e.message ? `\nError: ${e.message}` : '');
  }
}

function readFile(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); }
  catch (err) { return `Error: ${err instanceof Error ? err.message : String(err)}`; }
}

function writeFile(p: string, content: string): string {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
    return `Written ${content.length} bytes to ${p}`;
  } catch (err) { return `Error: ${err instanceof Error ? err.message : String(err)}`; }
}

function editFile(p: string, oldStr: string, newStr: string): string {
  try {
    const content = fs.readFileSync(p, 'utf-8');
    if (!content.includes(oldStr)) return `Error: string not found in ${p}`;
    fs.writeFileSync(p, content.replace(oldStr, newStr), 'utf-8');
    return 'File updated.';
  } catch (err) { return `Error: ${err instanceof Error ? err.message : String(err)}`; }
}

async function webSearch(query: string): Promise<string> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      AbstractText?: string;
      RelatedTopics?: { Text?: string; FirstURL?: string }[];
    };
    const results: string[] = [];
    if (data.AbstractText) results.push(data.AbstractText);
    for (const t of (data.RelatedTopics || []).slice(0, 5)) {
      if (t.Text) results.push(`- ${t.Text} (${t.FirstURL || ''})`);
    }
    return results.join('\n') || 'No results found.';
  } catch (err) { return `Search error: ${err instanceof Error ? err.message : String(err)}`; }
}

async function webFetch(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw/1.0)' },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const cleaned = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.slice(0, 8000);
  } catch (err) { return `Fetch error: ${err instanceof Error ? err.message : String(err)}`; }
}

async function executeLocalTool(name: string, args: Record<string, string>): Promise<string> {
  switch (name) {
    case 'bash':       return executeBash(args.command);
    case 'read_file':  return readFile(args.path);
    case 'write_file': return writeFile(args.path, args.content);
    case 'edit_file':  return editFile(args.path, args.old_string, args.new_string);
    case 'web_search': return webSearch(args.query);
    case 'web_fetch':  return webFetch(args.url);
    default:           return `Unknown local tool: ${name}`;
  }
}

// ─── MCP client ───────────────────────────────────────────────────────────────

function mcpToolsToOpenAI(
  mcpTools: { name: string; description?: string; inputSchema: unknown }[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return mcpTools.map((t) => ({
    type: 'function' as const,
    function: {
      name: `mcp__${t.name}`,
      description: t.description,
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    },
  }));
}

async function startMcpClient(
  mcpServerPath: string,
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [mcpServerPath],
    env: {
      ...process.env,
      NANOCLAW_CHAT_JID: chatJid,
      NANOCLAW_GROUP_FOLDER: groupFolder,
      NANOCLAW_IS_MAIN: isMain ? '1' : '0',
    },
  });
  const client = new Client({ name: 'openrouter-runner', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function startHaMcpClient(url: string, token: string): Promise<Client> {
  const transport = new SSEClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'ha-mcp-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

// ─── IPC helpers ─────────────────────────────────────────────────────────────

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR).filter((f) => f.endsWith('.json')).sort();
    const messages: string[] = [];
    for (const file of files) {
      const fp = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        fs.unlinkSync(fp);
        if (data.type === 'message' && data.text) messages.push(data.text);
      } catch { /* ignore */ }
    }
    return messages;
  } catch { return []; }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const messages = drainIpcInput();
      if (messages.length > 0) { resolve(messages.join('\n')); return; }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ─── Query loop ───────────────────────────────────────────────────────────────

async function runQuery(
  openai: OpenAI,
  mcpClient: Client | null,
  mcpTools: OpenAI.Chat.Completions.ChatCompletionTool[],
  model: string,
  systemPrompt: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  haClient?: Client | null,
  isLocal?: boolean,
): Promise<string> {
  const allTools = [...LOCAL_TOOLS, ...mcpTools];
  let toolCallCount = 0;

  while (true) {
    const provider = isLocal ? undefined : process.env.OPENROUTER_PROVIDER;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await openai.chat.completions.create({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools: allTools,
      tool_choice: 'auto',
      ...(provider ? { provider: { order: [provider], allow_fallbacks: false } } : {}),
    } as any)) as any;

    const choice = response.choices[0];
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (choice.finish_reason === 'stop' || !assistantMsg.tool_calls?.length) {
      return assistantMsg.content || '';
    }

    if (toolCallCount >= MAX_TOOL_CALLS) {
      log(`Max tool calls (${MAX_TOOL_CALLS}) reached`);
      return assistantMsg.content || '[Max tool calls reached]';
    }

    for (const toolCall of assistantMsg.tool_calls) {
      toolCallCount++;
      const fn = (toolCall as { function: { name: string; arguments: string } }).function;
      const toolName = fn.name;
      let toolArgs: Record<string, string> = {};
      try { toolArgs = JSON.parse(fn.arguments); } catch { /* use empty */ }

      log(`Tool #${toolCallCount}: ${toolName}`);
      let result: string;

      if (toolName.startsWith('mcp__home_assistant__') && haClient) {
        try {
          const mcpResult = await haClient.callTool({ name: toolName.slice('mcp__home_assistant__'.length), arguments: toolArgs });
          const content = mcpResult.content as { type: string; text?: string }[];
          result = content.filter((c) => c.type === 'text').map((c) => c.text || '').join('\n');
        } catch (err) {
          result = `HA MCP error: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else if (toolName.startsWith('mcp__') && mcpClient) {
        try {
          const mcpResult = await mcpClient.callTool({ name: toolName.slice(5), arguments: toolArgs });
          const content = mcpResult.content as { type: string; text?: string }[];
          result = content.filter((c) => c.type === 'text').map((c) => c.text || '').join('\n');
        } catch (err) {
          result = `MCP error: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        result = await executeLocalTool(toolName, toolArgs);
      }

      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result.slice(0, 16000) });
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runOpenRouterAgent(input: ContainerInput): Promise<void> {
  // Local model (LM Studio / Ollama / any OpenAI-compatible server) takes priority.
  // Set LOCAL_MODEL_URL and LOCAL_MODEL in .env to activate; comment out to fall back to OpenRouter.
  const localModelUrl = process.env.LOCAL_MODEL_URL;
  const localModel = process.env.LOCAL_MODEL;
  const isLocal = !!(localModelUrl && localModel);

  const apiKey = isLocal ? (process.env.LOCAL_MODEL_API_KEY || 'lm-studio') : process.env.OPENROUTER_API_KEY!;
  const model = isLocal ? localModel! : process.env.OPENROUTER_MODEL!;
  // mem0 extraction always needs an OpenRouter-compatible key + endpoint.
  // When using a local model, prefer a separate OPENROUTER_API_KEY if available.
  // If not, fall back to the local endpoint so extraction still runs (with LOCAL_MODEL).
  const mem0ApiKey = process.env.OPENROUTER_API_KEY || apiKey;
  const mem0BaseURL = process.env.OPENROUTER_API_KEY
    ? 'https://openrouter.ai/api/v1'
    : localModelUrl!;
  const mem0LlmModel = process.env.MEM0_LLM_MODEL || (process.env.OPENROUTER_API_KEY ? model : localModel!) || model;
  const mem0Enabled = process.env.MEM0_ENABLED !== '0';

  if (!isLocal && !apiKey) {
    writeOutput({ status: 'error', result: null, error: 'OPENROUTER_API_KEY not set' });
    return;
  }

  const openai = isLocal
    ? new OpenAI({
        apiKey,
        baseURL: localModelUrl!,
      })
    : new OpenAI({
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/qwibitai/nanoclaw',
          'X-Title': 'NanoClaw',
        },
      });

  if (isLocal) {
    log(`Using local model: ${model} at ${localModelUrl}`);
  }

  // MCP servers (IPC + Memory)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  let mcpClient: Client | null = null;
  let memoryMcpClient: Client | null = null;
  let mcpTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
  try {
    const ipcServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
    mcpClient = await startMcpClient(ipcServerPath, input.chatJid, input.groupFolder, input.isMain);
    const { tools } = await mcpClient.listTools();
    mcpTools = mcpToolsToOpenAI(tools);
    log(`MCP connected: ${tools.map((t: { name: string }) => t.name).join(', ')}`);
  } catch (err) {
    log(`MCP unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const memServerPath = path.join(__dirname, 'memory-mcp-stdio.js');
    memoryMcpClient = await startMcpClient(memServerPath, input.chatJid, input.groupFolder, input.isMain);
    const { tools: memTools } = await memoryMcpClient.listTools();
    mcpTools = [...mcpTools, ...mcpToolsToOpenAI(memTools)];
    log(`Memory MCP connected: ${memTools.map((t: { name: string }) => t.name).join(', ')}`);
  } catch (err) {
    log(`Memory MCP unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Home Assistant MCP server (SSE)
  let haClient: Client | null = null;
  const haMcpUrl = process.env.HA_MCP_URL;
  const haMcpToken = process.env.HA_MCP_TOKEN;
  if (haMcpUrl && haMcpToken) {
    try {
      haClient = await startHaMcpClient(haMcpUrl, haMcpToken);
      const { tools: haTools } = await haClient.listTools();
      const haOpenAITools = haTools.map((t) => ({
        type: 'function' as const,
        function: {
          name: `mcp__home_assistant__${t.name}`,
          description: t.description,
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        },
      }));
      mcpTools = [...mcpTools, ...haOpenAITools];
      log(`HA MCP connected: ${haTools.map((t) => t.name).join(', ')}`);
    } catch (err) {
      log(`HA MCP unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const googleApiKey = process.env.GOOGLE_API_KEY;
  const embedderModel = process.env.MEM0_EMBEDDER_MODEL || 'gemini-embedding-2-preview';

  // mem0 user id — scoped per group
  const mem0UserId = `${input.groupFolder}-${input.chatJid}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64);

  // IPC setup (done early so prompt drain works below)
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = input.isScheduledTask ? `[SCHEDULED TASK]\n\n${input.prompt}` : input.prompt;
  const pending = drainIpcInput();
  if (pending.length > 0) prompt += '\n' + pending.join('\n');

  // Load existing raw entries — needed only for mem0 extraction at session close.
  // Per-turn memory retrieval is done JIT inside the query loop below.
  const allStoredMemoryTexts = mem0Enabled ? loadMemoryEntries().map((e) => e.text) : [];

  // Build system prompt (memories are NOT injected here; they are injected JIT per-turn)
  let systemPrompt = `You are ${input.assistantName || 'Tars'}, a personal assistant. You help with tasks, answer questions, and can use tools to get things done.\n\nYou are running in a Linux container. Your working directory is /workspace/group.`;
  const claudeMdPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(claudeMdPath)) {
    systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8') + `\n\nModel: ${model}`;
  }

  // Load short-term session history
  const history = loadSessionHistory();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    ...history,
    { role: 'user', content: prompt },
  ];
  if (history.length > 0) log(`Resuming from ${history.length} persisted messages`);

  try {
    while (true) {
      log(`Running query with model: ${model}`);

      // JIT memory injection: query mem0 with the latest user message and prepend
      // relevant memories as a <context> block directly on that message's content.
      if (mem0Enabled) {
        await injectJitMemoryContext(messages, googleApiKey, embedderModel);
      }

      const result = await runQuery(openai, mcpClient, mcpTools, model, systemPrompt, messages, haClient, isLocal);

      // Strip injected <context> blocks BEFORE saving to session history.
      // This is critical — leaving them in would re-inject stale context on every
      // subsequent turn and cause exponential token bloat.
      if (mem0Enabled) {
        stripAllMemoryContexts(messages);
      }

      saveSessionHistory(messages);

      // Extract and persist memories after every turn — not just at session close.
      // This ensures nothing is lost if the container crashes or is killed mid-session.
      if (mem0Enabled) {
        const updated = await extractMemories(messages, allStoredMemoryTexts, mem0ApiKey, mem0LlmModel, mem0UserId, mem0BaseURL);
        await saveStoredMemories(updated, googleApiKey, embedderModel);
        // Keep allStoredMemoryTexts in sync so the next turn's JIT injection is fresh
        allStoredMemoryTexts.length = 0;
        allStoredMemoryTexts.push(...updated.map((e) => (typeof e === 'string' ? e : (e as { text: string }).text)));
      }

      writeOutput({ status: 'success', result });

      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Session closed');
        break;
      }

      log(`Got new message (${nextMessage.length} chars)`);
      messages.push({ role: 'assistant', content: result });
      messages.push({ role: 'user', content: nextMessage });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, error: errorMessage });
  } finally {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
    if (memoryMcpClient) { try { await memoryMcpClient.close(); } catch { /* ignore */ } }
    if (haClient) { try { await haClient.close(); } catch { /* ignore */ } }
  }
}
