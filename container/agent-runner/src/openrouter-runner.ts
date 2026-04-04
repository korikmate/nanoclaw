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
import { Memory } from 'mem0ai/oss';

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
const MAX_HISTORY_MESSAGES = 40;
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
    const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
    const tmp = SESSION_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ messages: trimmed, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, SESSION_FILE);
  } catch (err) {
    log(`Failed to save session history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Long-term memory (mem0ai/oss — local, no cloud) ─────────────────────────

/** Load persisted memory strings from JSON file */
function loadStoredMemories(): string[] {
  try {
    if (!fs.existsSync(MEMORIES_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(MEMORIES_FILE, 'utf-8'));
    const items: string[] = Array.isArray(data) ? data : [];
    log(`Loaded ${items.length} long-term memories from ${MEMORIES_FILE}`);
    return items;
  } catch (err) {
    log(`Failed to load memories: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Persist memory strings to JSON file */
function saveStoredMemories(memories: string[]): void {
  try {
    fs.mkdirSync(MEM0_DIR, { recursive: true });
    const tmp = MEMORIES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(memories, null, 2));
    fs.renameSync(tmp, MEMORIES_FILE);
    log(`Saved ${memories.length} memories to ${MEMORIES_FILE}`);
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

function buildMem0(openRouterApiKey: string, llmModel: string): Memory {
  const googleApiKey = process.env.GOOGLE_API_KEY;
  if (!googleApiKey) throw new Error('GOOGLE_API_KEY not set — required for mem0 embeddings');

  return new Memory({
    llm: {
      provider: 'openai',
      config: {
        apiKey: openRouterApiKey,
        baseURL: 'https://openrouter.ai/api/v1',
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
): Promise<string[]> {
  try {
    const mem = buildMem0(apiKey, llmModel);

    // Add existing memories first so mem0 can deduplicate properly
    if (existing.length > 0) {
      // Inject as pre-existing user context to guide deduplication
      await mem.add(
        existing.map((m) => ({ role: 'system' as const, content: `[known fact] ${m}` })),
        { userId },
      );
    }

    // Add the actual conversation — mem0 extracts and deduplicates
    const convMessages = messages.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
    );
    if (convMessages.length > 0) {
      await mem.add(convMessages as { role: 'user' | 'assistant'; content: string }[], { userId });
    }

    const all = await mem.getAll({ userId });
    const results = (all as { results?: { memory?: string }[] }).results ?? [];
    const extracted = results
      .map((r) => r.memory ?? '')
      .filter((m) => m.length > 0 && !m.startsWith('[known fact]'));

    log(`Extracted ${extracted.length} memories via mem0ai/oss`);
    return extracted;
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
): Promise<string> {
  const allTools = [...LOCAL_TOOLS, ...mcpTools];
  let toolCallCount = 0;

  while (true) {
    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools: allTools,
      tool_choice: 'auto',
    });

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

      if (toolName.startsWith('mcp__') && mcpClient) {
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
  const apiKey = process.env.OPENROUTER_API_KEY!;
  const model = process.env.OPENROUTER_MODEL!;
  const mem0LlmModel = process.env.MEM0_LLM_MODEL || model;
  const mem0Enabled = process.env.MEM0_ENABLED !== '0';

  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'OPENROUTER_API_KEY not set' });
    return;
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/qwibitai/nanoclaw',
      'X-Title': 'NanoClaw',
    },
  });

  // MCP server
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  let mcpClient: Client | null = null;
  let mcpTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
  try {
    mcpClient = await startMcpClient(mcpServerPath, input.chatJid, input.groupFolder, input.isMain);
    const { tools } = await mcpClient.listTools();
    mcpTools = mcpToolsToOpenAI(tools);
    log(`MCP connected: ${tools.map((t) => t.name).join(', ')}`);
  } catch (err) {
    log(`MCP unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Load long-term memories from disk
  const storedMemories = mem0Enabled ? loadStoredMemories() : [];

  // mem0 user id — scoped per group
  const mem0UserId = `${input.groupFolder}-${input.chatJid}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64);

  // Build system prompt
  let basePrompt = `You are ${input.assistantName || 'Tars'}, a personal assistant. You help with tasks, answer questions, and can use tools to get things done.\n\nYou are running in a Linux container. Your working directory is /workspace/group.`;
  const claudeMdPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(claudeMdPath)) {
    basePrompt = fs.readFileSync(claudeMdPath, 'utf-8') + `\n\nModel: ${model}`;
  }

  const systemPrompt = storedMemories.length > 0
    ? `${basePrompt}\n\n## Memories from previous conversations\n${storedMemories.map((m) => `- ${m}`).join('\n')}`
    : basePrompt;

  if (storedMemories.length > 0) {
    log(`Injected ${storedMemories.length} long-term memories into system prompt`);
  }

  // IPC setup
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = input.isScheduledTask ? `[SCHEDULED TASK]\n\n${input.prompt}` : input.prompt;
  const pending = drainIpcInput();
  if (pending.length > 0) prompt += '\n' + pending.join('\n');

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
      const result = await runQuery(openai, mcpClient, mcpTools, model, systemPrompt, messages);

      saveSessionHistory(messages);
      writeOutput({ status: 'success', result });

      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Session closed — extracting memories');
        if (mem0Enabled) {
          const updated = await extractMemories(messages, storedMemories, apiKey, mem0LlmModel, mem0UserId);
          saveStoredMemories(updated);
        }
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
  }
}
