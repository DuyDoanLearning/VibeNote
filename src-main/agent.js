// VibeNote agent host — runs Claude (via the Claude Agent SDK) using the user's installed Claude Code
// and its existing login. Bundled by build.mjs into dist/agent.mjs and loaded by main.js.
//
// One AgentChat = one long-lived Claude Code session fed by a queue of user messages ("streaming input mode").
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// ---------- environment ----------
// Apps launched from Finder/Dock don't inherit the shell PATH, so Claude's Bash tool couldn't find git, npm, etc.
// Read the login shell's environment once (same trick editors like VS Code use).
let shellEnv = null;
export async function loginShellEnv() {
  if (shellEnv) return shellEnv;
  const shell = process.env.SHELL || '/bin/zsh';
  shellEnv = await new Promise((resolve) => {
    execFile(shell, ['-ilc', 'printf "__VIBENOTE_ENV__"; env -0'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const out = String(stdout || '');
      const at = out.indexOf('__VIBENOTE_ENV__');
      if (err && at < 0) return resolve({ ...process.env });
      const env = {};
      for (const kv of out.slice(at + '__VIBENOTE_ENV__'.length).split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      resolve({ ...process.env, ...env });
    });
  });
  return shellEnv;
}

export function findClaude(env, override) {
  const home = os.homedir();
  const candidates = [
    override,
    path.join(home, '.local/bin/claude'),
    path.join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    ...String(env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, 'claude')),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return null;
}

// ---------- async queue used as the SDK's prompt stream ----------
function createQueue() {
  const items = [];
  let wake = null;
  let done = false;
  return {
    push(x) { items.push(x); if (wake) { wake(); wake = null; } },
    end() { done = true; if (wake) { wake(); wake = null; } },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (done) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
}

// ---------- chat ----------
export class AgentChat {
  /**
   * opts: { cwd, additionalDirectories, appendSystemPrompt, model, permissionMode, resume, claudePath, env,
   *         onFileEdit(phase: 'before'|'after', filePath), noteHistory({ note, version, compare_to }) -> text,
   *         onEvent(evt), askPermission({ tool, input, title, reason, suggestions, signal }) -> PermissionResult }
   */
  constructor(opts) {
    this.opts = opts;
    this.queue = createQueue();
    this.sessionId = opts.resume || null;
    this.busy = false;
    this.closed = false;
    this.controller = new AbortController();
    this.run();
  }

  async run() {
    const o = this.opts;
    const env = { ...o.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'vibenote/0.2' };
    // Use the user's Claude login, not whatever API key happens to be in the shell environment.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDECODE;
    try {
      this.q = query({
        prompt: this.queue,
        options: {
          cwd: o.cwd,
          additionalDirectories: o.additionalDirectories,
          pathToClaudeCodeExecutable: o.claudePath,
          env,
          model: o.model || undefined,
          permissionMode: o.permissionMode || 'default',
          resume: o.resume || undefined,
          includePartialMessages: true,
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: o.appendSystemPrompt },
          // VibeNote's own tools for Claude: read a note's version history (read-only, no permission prompt).
          ...(o.noteHistory && {
            mcpServers: {
              vibenote: createSdkMcpServer({
                name: 'vibenote',
                version: '1.0.0',
                tools: [tool(
                  'note_history',
                  'Version history of a note in the VibeNote notes folder: who changed it (You / Claude / Confluence) and when, and what changed. Without "version": lists versions (newest first) with change sizes. With "version" (an id from the list): the diff of that version against the one before it, or against the current text with compare_to="current".',
                  {
                    note: z.string().describe('Path of the note (absolute, or relative to the notes folder), or its title'),
                    version: z.string().optional().describe('Version id from the list (a timestamp)'),
                    compare_to: z.enum(['previous', 'current']).optional().describe('Compare the version with the one before it (default) or with the current text'),
                  },
                  async (args) => ({ content: [{ type: 'text', text: await o.noteHistory(args) }] }),
                )],
              }),
            },
            allowedTools: ['mcp__vibenote__note_history'],
          }),
          // Snapshot notes before/after Claude edits them (works in every permission mode).
          ...(o.onFileEdit && {
            hooks: {
              PreToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [async (input) => { await o.onFileEdit('before', input.tool_input?.file_path); return { continue: true }; }] }],
              PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [async (input) => { await o.onFileEdit('after', input.tool_input?.file_path); return { continue: true }; }] }],
            },
          }),
          abortController: this.controller,
          canUseTool: (tool, input, extra) => o.askPermission({
            tool, input, title: extra.title, reason: extra.decisionReason, suggestions: extra.suggestions, signal: extra.signal,
          }),
        },
      });
      for await (const m of this.q) this.handle(m);
    } catch (e) {
      if (!this.closed) o.onEvent({ kind: 'error', message: e?.message || String(e) });
    } finally {
      this.closed = true;
      this.busy = false;
      o.onEvent({ kind: 'closed' });
    }
  }

  // Translate SDK messages into small UI events.
  handle(m) {
    const emit = this.opts.onEvent;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.sessionId = m.session_id;
          emit({ kind: 'init', sessionId: m.session_id, model: m.model, mode: m.permissionMode, cwd: m.cwd });
        } else if (m.subtype === 'api_retry' || m.subtype === 'status') {
          if (m.status || m.message) emit({ kind: 'status', text: String(m.status || m.message) });
        }
        break;
      case 'stream_event': {
        if (m.parent_tool_use_id) break; // ignore sub-agent chatter
        const ev = m.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit({ kind: 'delta', text: ev.delta.text });
        break;
      }
      case 'assistant': {
        if (m.parent_tool_use_id) break;
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text.trim()) emit({ kind: 'text', text: b.text });
          if (b.type === 'tool_use') emit({ kind: 'tool', id: b.id, name: b.name, input: b.input });
        }
        break;
      }
      case 'user': {
        const content = m.message?.content;
        if (!Array.isArray(content)) break;
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          const text = Array.isArray(b.content)
            ? b.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
            : String(b.content ?? '');
          emit({ kind: 'tool_result', id: b.tool_use_id, isError: !!b.is_error, text: text.slice(0, 4000) });
        }
        break;
      }
      case 'result':
        this.busy = false;
        this.sessionId = m.session_id || this.sessionId;
        emit({
          kind: 'result',
          isError: m.is_error,
          subtype: m.subtype,
          durationMs: m.duration_ms,
          turns: m.num_turns,
          errors: m.errors,
        });
        break;
      default:
        break;
    }
  }

  send(text) {
    if (this.closed) throw new Error('This chat has ended — start a new one');
    this.busy = true;
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    });
  }

  async interrupt() {
    try { await this.q?.interrupt(); } catch {}
  }

  async setMode(mode) {
    try { await this.q?.setPermissionMode(mode); } catch {}
  }

  close() {
    this.closed = true;
    this.queue.end();
    try { this.controller.abort(); } catch {}
  }
}

// ---------- one-shot answer (comments) ----------
// A single reply with no tools and no saved session: Claude only sees what we send. Used by @Claude in comments.
export async function askOnce({ prompt, system, claudePath, env: baseEnv, model, cwd, signal, onDelta }) {
  const env = { ...baseEnv, CLAUDE_AGENT_SDK_CLIENT_APP: 'vibenote/0.2' };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDECODE;
  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort());
  let text = '';
  const q = query({
    prompt,
    options: {
      cwd: cwd || os.tmpdir(),
      pathToClaudeCodeExecutable: claudePath,
      env,
      model: model || undefined,
      tools: [],
      maxTurns: 1,
      includePartialMessages: !!onDelta,
      persistSession: false,
      settingSources: [],
      systemPrompt: system,
      abortController: controller,
      canUseTool: async () => ({ behavior: 'deny', message: 'Comments have no tools.' }),
    },
  });
  for await (const m of q) {
    if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') onDelta?.(m.event.delta.text);
    if (m.type === 'assistant') for (const b of m.message?.content || []) if (b.type === 'text') text += b.text;
    if (m.type === 'result' && m.is_error) throw new Error(m.result || m.subtype || 'Claude could not answer');
  }
  return text.trim();
}
