import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthTokens,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { boundedFetch, deadline } from './limits.js';

export interface OAuthConfig {
  clientId?: string;
  redirectPort: number;
  scope?: string;
}
interface Saved {
  identity?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
}

/** MCP credentials are separate from Pi model-provider auth and never enter session entries. */
export class McpOAuth implements OAuthClientProvider {
  private saved: Saved = {};
  private verifier?: string;
  private nonce = randomBytes(32).toString('hex');
  private redirect?: (url: URL) => Promise<void>;
  private file: string;
  private refreshing?: Promise<void>;
  private authorizationIdentity?: string;
  get identity() {
    return this.saved.identity ?? 'unauthorized';
  }
  constructor(
    private serverUrl: string,
    private config: OAuthConfig,
    private directory: string,
  ) {
    this.file = join(
      directory,
      createHash('sha256')
        .update(JSON.stringify([serverUrl, config]))
        .digest('hex') + '.json',
    );
  }
  async load() {
    try {
      this.saved = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this;
  }
  get redirectUrl() {
    return `http://127.0.0.1:${this.config.redirectPort}/mcp/oauth/callback`;
  }
  get clientMetadata() {
    return {
      client_name: 'Pi MCP Client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }
  state() {
    return this.nonce;
  }
  clientInformation() {
    return this.config.clientId ? { client_id: this.config.clientId } : this.saved.client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed) {
    this.saved.client = client;
    await this.save();
  }
  tokens() {
    return this.saved.tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    this.saved.identity =
      this.authorizationIdentity ?? this.saved.identity ?? randomBytes(16).toString('hex');
    this.saved.tokens = {
      ...tokens,
      refresh_token: tokens.refresh_token ?? this.saved.tokens?.refresh_token,
    };
    this.saved.expiresAt =
      tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000;
    await this.save();
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error('No pending OAuth login');
    return this.verifier;
  }
  async redirectToAuthorization(url: URL) {
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    )
      throw new Error('Unsafe OAuth authorization URL');
    if (!this.redirect) throw new Error('MCP authorization required; use /mcp login SERVER');
    // A fresh browser authorization may select a different principal. Refreshes retain identity.
    this.authorizationIdentity = randomBytes(16).toString('hex');
    await this.redirect(url);
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all') this.saved = {};
    if (scope === 'client') delete this.saved.client;
    if (scope === 'tokens') {
      delete this.saved.tokens;
      delete this.saved.expiresAt;
    }
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    await this.save();
  }
  private async save() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(temporary, JSON.stringify(this.saved), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async logout() {
    this.saved = {};
    this.verifier = undefined;
    await rm(this.file, { force: true });
  }

  private fetchFor(signal: AbortSignal): typeof boundedFetch {
    return (url, init) => {
      const target = new URL(String(url));
      if (
        target.protocol !== 'https:' &&
        !(
          target.protocol === 'http:' &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)
        )
      )
        throw new Error('OAuth requires HTTPS (except loopback)');
      return boundedFetch(url, {
        ...init,
        signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
      });
    };
  }
  async refresh(timeout: number, signal?: AbortSignal | null) {
    if (
      !this.saved.tokens ||
      this.saved.expiresAt === undefined ||
      this.saved.expiresAt > Date.now() + 30000
    )
      return;
    this.refreshing ??= (async () => {
      const deadlineSignal = AbortSignal.any([
        AbortSignal.timeout(timeout),
        ...(signal ? [signal] : []),
      ]);
      await auth(this, { serverUrl: this.serverUrl, fetchFn: this.fetchFor(deadlineSignal) });
    })().finally(() => {
      this.refreshing = undefined;
    });
    await this.refreshing;
  }
  async login(open: (url: URL) => Promise<void>, timeout: number) {
    this.nonce = randomBytes(32).toString('hex');
    const controller = new AbortController();
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    void code.catch(() => {});
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.redirectUrl);
      if (
        req.method !== 'GET' ||
        url.pathname !== '/mcp/oauth/callback' ||
        url.searchParams.get('state') !== this.nonce ||
        (!url.searchParams.get('code') && !url.searchParams.get('error'))
      ) {
        res.writeHead(400).end('Invalid OAuth callback');
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
        .end('Authorization received. Return to Pi.');
      if (url.searchParams.has('error')) rejectCode(new Error('OAuth authorization declined'));
      else resolveCode(url.searchParams.get('code')!);
    });
    this.redirect = open;
    try {
      await deadline(
        (async () => {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.config.redirectPort, '127.0.0.1', resolve);
          });
          const options = { serverUrl: this.serverUrl, fetchFn: this.fetchFor(controller.signal) };
          if ((await auth(this, options)) === 'REDIRECT')
            await auth(this, { ...options, authorizationCode: await code });
        })(),
        timeout,
      );
    } finally {
      controller.abort();
      this.redirect = undefined;
      this.verifier = undefined;
      this.authorizationIdentity = undefined;
      server.closeAllConnections();
      server.close();
    }
  }
}
