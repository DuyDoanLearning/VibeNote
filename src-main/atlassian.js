// Atlassian connection: VibeNote is its own MCP client for Atlassian's remote MCP server.
// Sign-in is OAuth in the user's browser (once); client registration + tokens are encrypted with
// Electron safeStorage (macOS Keychain) and stored in userData — never in the repo or the notes folder.
// Bundled by build.mjs into dist/atlassian.mjs and imported lazily by main.js.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { app, safeStorage, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const SERVER_URL = 'https://mcp.atlassian.com/v1/mcp';
// Fixed loopback port: the redirect URL is registered with Atlassian once, so it must not change between runs.
const PORT = 47323;
const REDIRECT_URL = `http://localhost:${PORT}/callback`;
const SIGN_IN_TIMEOUT = 5 * 60 * 1000;

// ---------- encrypted local store ----------
const storeFile = () => path.join(app.getPath('userData'), 'atlassian-auth.bin');
async function readStore() {
  let buf;
  try { buf = fs.readFileSync(storeFile()); } catch { return {}; }
  try { return JSON.parse((await safeStorage.decryptStringAsync(buf)).result); } catch { return {}; }
}
// Writes are queued so two quick saves (e.g. verifier + tokens) can't overwrite each other.
let writing = Promise.resolve();
function writeStore(patch) {
  writing = writing.then(async () => {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('macOS Keychain encryption is not available; not saving the Atlassian sign-in.');
    const data = { ...(await readStore()), ...patch }; // undefined values are dropped by JSON = removed
    fs.writeFileSync(storeFile(), await safeStorage.encryptStringAsync(JSON.stringify(data)), { mode: 0o600 });
  });
  return writing;
}
const readKey = async (k) => { await writing.catch(() => {}); return (await readStore())[k]; };

// ---------- OAuth provider (the SDK drives discovery, registration, PKCE and refresh) ----------
class Provider {
  constructor() {
    this.expectedState = null;
  }
  get redirectUrl() { return REDIRECT_URL; }
  get clientMetadata() {
    return {
      client_name: 'VibeNote',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() { return (this.expectedState = crypto.randomBytes(16).toString('hex')); }
  clientInformation() { return readKey('client'); }
  saveClientInformation(client) { return writeStore({ client }); }
  tokens() { return readKey('tokens'); }
  saveTokens(tokens) { return writeStore({ tokens }); }
  codeVerifier() { return readKey('verifier'); }
  saveCodeVerifier(verifier) { return writeStore({ verifier }); }
  discoveryState() { return readKey('discovery'); }
  saveDiscoveryState(discovery) { return writeStore({ discovery }); }
  invalidateCredentials(scope) {
    const keys = scope === 'all' ? ['client', 'tokens', 'verifier', 'discovery'] : [scope];
    return writeStore(Object.fromEntries(keys.map((k) => [k, undefined])));
  }
  redirectToAuthorization(url) {
    this.authUrl = url;
    if (this.interactive) shell.openExternal(url.toString());
  }
}

// Waits for the browser to come back to http://localhost:PORT/callback with ?code=…
// Listens on both loopback addresses (browsers may resolve "localhost" to either) and only for the sign-in.
function waitForCallback(provider) {
  const servers = [];
  let timer;
  const stop = () => { clearTimeout(timer); servers.forEach((s) => s.close()); };
  const promise = new Promise((resolve, reject) => {
    const done = (err, code) => {
      stop();
      err ? reject(err) : resolve(code);
    };
    const handler = (req, res) => {
      const u = new URL(req.url, REDIRECT_URL);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error_description') || u.searchParams.get('error');
      const okState = !provider.expectedState || u.searchParams.get('state') === provider.expectedState;
      const good = code && okState && !err;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>VibeNote</title><body style="font:15px -apple-system;padding:40px">
        ${good ? '✅ Signed in to Atlassian. You can close this tab and go back to VibeNote.' : '❌ Sign-in failed. You can close this tab and try again in VibeNote.'}`);
      if (good) done(null, code);
      else done(new Error(err || (okState ? 'No authorization code returned' : 'Sign-in state mismatch')));
    };
    timer = setTimeout(() => done(new Error('Sign-in timed out')), SIGN_IN_TIMEOUT);
    let failed = 0;
    for (const host of ['127.0.0.1', '::1']) {
      const s = http.createServer(handler);
      s.on('error', (e) => { if (++failed === 2) done(new Error(`Can't listen on port ${PORT}: ${e.message}`)); });
      s.listen(PORT, host);
      servers.push(s);
    }
  });
  promise.catch(() => {});
  return { promise, cancel: stop };
}

// ---------- connection ----------
let client = null;

async function open(provider) {
  const c = new Client({ name: 'VibeNote', version: app.getVersion() });
  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider });
  await c.connect(transport);
  return { c, transport };
}

/** Connect, signing in through the browser if needed (interactive) — resolves to the MCP client. */
let connecting = null;
export function connect({ interactive = true } = {}) {
  if (client) return Promise.resolve(client);
  return (connecting ||= doConnect(interactive).finally(() => { connecting = null; }));
}
async function doConnect(interactive) {
  const provider = new Provider();
  provider.interactive = interactive;
  // Listen before anything can open the browser; stopped again if no sign-in turns out to be needed.
  const callback = interactive ? waitForCallback(provider) : null;
  try {
    client = (await open(provider)).c;
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !interactive) throw e;
    const code = await callback.promise;
    // finishAuth exchanges the code for tokens (saved via the provider), then reconnect with them.
    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider });
    await transport.finishAuth(code);
    client = (await open(provider)).c;
  } finally {
    callback?.cancel();
  }
  return client;
}

export async function isSignedIn() {
  return !!(await readKey('tokens'));
}

export async function signOut() {
  try { await client?.close(); } catch {}
  client = null;
  await writing.catch(() => {});
  try { fs.rmSync(storeFile()); } catch {}
}

export async function listTools() {
  const c = await connect();
  return (await c.listTools()).tools;
}

/** Call an Atlassian MCP tool; returns parsed JSON when the tool answers with JSON text. */
export async function call(name, args) {
  const c = await connect();
  const res = await c.callTool({ name, arguments: args });
  const text = (res.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  if (res.isError) throw new Error(text || `${name} failed`);
  try { return JSON.parse(text); } catch { return text; }
}
