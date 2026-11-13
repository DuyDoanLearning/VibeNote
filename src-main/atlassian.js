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

// Two connections: 'main' (pages, comments — the tools VibeNote was built on) and 'files' (Atlassian's newer server,
// used only to download page pictures: images and draw.io diagrams). Each has its own sign-in.
const SERVERS = { main: 'https://mcp.atlassian.com/v1/mcp', files: 'https://mcp.atlassian.com/v2/mcp' };
const keyOf = (server, k) => (server === 'main' ? k : `${server}.${k}`); // 'main' keeps the original key names
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
  constructor(server = 'main') {
    this.expectedState = null;
    this.server = server;
  }
  k(name) { return keyOf(this.server, name); }
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
  clientInformation() { return readKey(this.k('client')); }
  saveClientInformation(client) { return writeStore({ [this.k('client')]: client }); }
  tokens() { return readKey(this.k('tokens')); }
  saveTokens(tokens) { return writeStore({ [this.k('tokens')]: tokens }); }
  codeVerifier() { return readKey(this.k('verifier')); }
  saveCodeVerifier(verifier) { return writeStore({ [this.k('verifier')]: verifier }); }
  discoveryState() { return readKey(this.k('discovery')); }
  saveDiscoveryState(discovery) { return writeStore({ [this.k('discovery')]: discovery }); }
  invalidateCredentials(scope) {
    const keys = scope === 'all' ? ['client', 'tokens', 'verifier', 'discovery'] : [scope];
    return writeStore(Object.fromEntries(keys.map((k) => [this.k(k), undefined])));
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
const clients = {}; // server → connected MCP client

async function open(provider) {
  const c = new Client({ name: 'VibeNote', version: app.getVersion() });
  const transport = new StreamableHTTPClientTransport(new URL(SERVERS[provider.server]), { authProvider: provider });
  await c.connect(transport);
  return { c, transport };
}

/** Connect, signing in through the browser if needed (interactive) — resolves to the MCP client. */
const connecting = {};
let signingIn = Promise.resolve(); // one browser sign-in at a time (they share the callback port)
export function connect({ interactive = true, server = 'main' } = {}) {
  if (clients[server]) return Promise.resolve(clients[server]);
  return (connecting[server] ||= doConnect(interactive, server).finally(() => { connecting[server] = null; }));
}
async function doConnect(interactive, server) {
  const provider = new Provider(server);
  provider.interactive = interactive;
  if (interactive) await signingIn.catch(() => {});
  let release;
  if (interactive) signingIn = new Promise((r) => { release = r; });
  // Listen before anything can open the browser; stopped again if no sign-in turns out to be needed.
  const callback = interactive ? waitForCallback(provider) : null;
  try {
    clients[server] = (await open(provider)).c;
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !interactive) throw e;
    const code = await callback.promise;
    // finishAuth exchanges the code for tokens (saved via the provider), then reconnect with them.
    const transport = new StreamableHTTPClientTransport(new URL(SERVERS[server]), { authProvider: provider });
    await transport.finishAuth(code);
    clients[server] = (await open(provider)).c;
  } finally {
    callback?.cancel();
    release?.();
  }
  return clients[server];
}

export async function isSignedIn(server = 'main') {
  return !!(await readKey(keyOf(server, 'tokens')));
}

export async function signOut() {
  for (const s of Object.keys(clients)) {
    try { await clients[s]?.close(); } catch {}
    delete clients[s];
  }
  await writing.catch(() => {});
  try { fs.rmSync(storeFile()); } catch {}
}

export async function listTools(server = 'main') {
  const c = await connect({ server });
  return (await c.listTools()).tools;
}

/** Run a read-only operation on the newer server (it exposes most operations through executeRead). */
export async function read(name, cloudId, inputs, { interactive = false } = {}) {
  try { await connect({ server: 'files', interactive }); } catch (e) { throw friendly(e); }
  const r = await call('executeRead', { name, cloudId, inputs }, 'files');
  return r?.data ?? r;
}

// A company network that inspects HTTPS re-signs Atlassian's connection with its own certificate. If the Mac doesn't
// trust that certificate, Node can't verify Atlassian: say so plainly (never switch verification off).
const CERT_CODES = /SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|CERT_UNTRUSTED/;
function friendly(e) {
  const code = e?.cause?.code || e?.code || e?.cause?.cause?.code || '';
  if (CERT_CODES.test(code) || CERT_CODES.test(String(e?.message || ''))) {
    return new Error('Your network is inspecting secure connections (a company proxy), so VibeNote can’t verify it’s really talking to Atlassian. Use another network (home Wi-Fi, phone hotspot) or VPN — or ask IT to install the proxy’s certificate on this Mac.');
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET/.test(`${e?.message} ${code}`)) {
    return new Error(`Can’t reach Atlassian (${code || 'network error'}). Check your internet connection.`);
  }
  return e;
}

/** Call an Atlassian MCP tool; returns parsed JSON when the tool answers with JSON text. */
export async function call(name, args, server = 'main') {
  let c;
  try { c = await connect({ server }); } catch (e) { throw friendly(e); }
  // Big pages can take Atlassian over a minute (the SDK's default timeout).
  let res;
  try { res = await c.callTool({ name, arguments: args }, undefined, { timeout: 150_000 }); } catch (e) { throw friendly(e); }
  const text = (res.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  if (res.isError) throw new Error(text || `${name} failed`);
  try { return JSON.parse(text); } catch { return text; }
}
