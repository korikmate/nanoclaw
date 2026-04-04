/**
 * OpenRouter Agent Runner
 * Uses OpenAI-compatible API to run non-Claude models via OpenRouter.
 * Implements the same input/output protocol as the Claude agent runner.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import OpenAI from 'openai';

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

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const MAX_TOOL_CALLS = 30;
const BASH_TIMEOUT_MS = 30_000;

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

// ─── Tools ───────────────────────────────────────────────────────────────────

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a bash command in the container sandbox. Use for file operations, running scripts, checking system state, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run' },
        },
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
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
        },
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
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
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
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description:
        "Send a message to the user immediately while still working. Use for progress updates before the final answer.",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message to send' },
        },
        required: ['text'],
      },
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────────

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
    const out = e.stdout || '';
    const errOut = e.stderr || e.message || String(err);
    return out + (errOut ? `\nSTDERR: ${errOut}` : '');
  }
}

function readFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function writeFile(filePath: string, content: string): string {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return `Written ${content.length} bytes to ${filePath}`;
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function editFile(filePath: string, oldStr: string, newStr: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(oldStr)) {
      return `Error: old_string not found in ${filePath}`;
    }
    fs.writeFileSync(filePath, content.replace(oldStr, newStr), 'utf-8');
    return `File updated successfully`;
  } catch (err) {
    return `Error editing file: ${err instanceof Error ? err.message : String(err)}`;
  }
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
    for (const topic of (data.RelatedTopics || []).slice(0, 5)) {
      if (topic.Text) results.push(`- ${topic.Text} (${topic.FirstURL || ''})`);
    }
    return results.join('\n') || 'No results found.';
  } catch (err) {
    return `Search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function webFetch(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw/1.0)' },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    // Strip HTML tags, collapse whitespace
    const cleaned = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.slice(0, 8000);
  } catch (err) {
    return `Fetch error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function sendIpcMessage(text: string, chatJid: string, groupFolder: string): string {
  try {
    fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const tempPath = path.join(IPC_MESSAGES_DIR, filename + '.tmp');
    const finalPath = path.join(IPC_MESSAGES_DIR, filename);
    fs.writeFileSync(
      tempPath,
      JSON.stringify({
        type: 'message',
        chatJid,
        text,
        groupFolder,
        timestamp: new Date().toISOString(),
      }),
    );
    fs.renameSync(tempPath, finalPath);
    return 'Message sent.';
  } catch (err) {
    return `Failed to send message: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeTool(
  name: string,
  args: Record<string, string>,
  chatJid: string,
  groupFolder: string,
): Promise<string> {
  switch (name) {
    case 'bash':
      return executeBash(args.command);
    case 'read_file':
      return readFile(args.path);
    case 'write_file':
      return writeFile(args.path, args.content);
    case 'edit_file':
      return editFile(args.path, args.old_string, args.new_string);
    case 'web_search':
      return webSearch(args.query);
    case 'web_fetch':
      return webFetch(args.url);
    case 'send_message':
      return sendIpcMessage(args.text, chatJid, groupFolder);
    default:
      return `Unknown tool: ${name}`;
  }
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
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
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

// ─── Main query loop ──────────────────────────────────────────────────────────

async function runQuery(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  chatJid: string,
  groupFolder: string,
): Promise<string> {
  let toolCallCount = 0;

  while (true) {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools: TOOLS,
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

    // Execute all tool calls
    for (const toolCall of assistantMsg.tool_calls) {
      toolCallCount++;
      const fn = (toolCall as { function: { name: string; arguments: string } }).function;
      const toolName = fn.name;
      let toolArgs: Record<string, string> = {};
      try {
        toolArgs = JSON.parse(fn.arguments);
      } catch { /* use empty args */ }

      log(`Tool call #${toolCallCount}: ${toolName}`);
      const result = await executeTool(toolName, toolArgs, chatJid, groupFolder);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result.slice(0, 16000),
      });
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runOpenRouterAgent(input: ContainerInput): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL!;

  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'OPENROUTER_API_KEY not set' });
    return;
  }

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/qwibitai/nanoclaw',
      'X-Title': 'NanoClaw',
    },
  });

  const assistantName = input.assistantName || 'Tars';

  // Load CLAUDE.md from group folder as system prompt
  let systemPrompt = `You are ${assistantName}, a personal assistant. You help with tasks, answer questions, and can use tools to get things done.\n\nYou are running in a Linux container. Your working directory is /workspace/group.`;
  const claudeMdPath = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(claudeMdPath)) {
    const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
    systemPrompt = claudeMd + '\n\nModel: ' + model;
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }

  // Drain any pending IPC messages into initial prompt
  const pending = drainIpcInput();
  if (pending.length > 0) prompt += '\n' + pending.join('\n');

  // Conversation messages (stateless — no session persistence for non-Claude models)
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'user', content: prompt },
  ];

  try {
    while (true) {
      log(`Running query with model: ${model}`);
      const result = await runQuery(
        client,
        model,
        systemPrompt,
        messages,
        input.chatJid,
        input.groupFolder,
      );

      writeOutput({ status: 'success', result });

      // Wait for next message
      log('Query done, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
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
  }
}
