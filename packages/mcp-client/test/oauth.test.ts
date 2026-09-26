import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { McpOAuth } from '../src/oauth.js';
import { ServerSchema, resolveConfig } from '../src/config.js';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as any).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('OAuth discovery, loopback state, PKCE, private persistence, single-flight refresh and logout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-oauth-'));
  let base = '',
    challenge = '',
    grants = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/.well-known/oauth-protected-resource')) {
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
      return;
    }
    if (req.url?.startsWith('/.well-known/oauth-authorization-server')) {
      res.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      );
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/register') {
      res.end(JSON.stringify({ ...JSON.parse(body), client_id: 'test-client' }));
      return;
    }
    if (req.url === '/token') {
      const form = new URLSearchParams(body);
      grants++;
      assert.equal(form.get('resource'), `${base}/mcp`);
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('code'), 'approved-code');
        assert.equal(
          createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),
          challenge,
        );
      } else {
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('refresh_token'), 'refresh-secret');
      }
      res.end(
        JSON.stringify({
          access_token: `access-${grants}`,
          refresh_token: 'refresh-secret',
          token_type: 'Bearer',
          expires_in: grants === 1 ? 1 : 3600,
        }),
      );
      return;
    }
    res.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const config = { redirectPort: await freePort() };
    const provider = await new McpOAuth(`${base}/mcp`, config, directory).load();
    await provider.login(async (url) => {
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      challenge = url.searchParams.get('code_challenge')!;
      const callback = new URL(provider.redirectUrl);
      callback.searchParams.set('code', 'approved-code');
      callback.searchParams.set('state', 'wrong');
      const invalid = await fetch(callback);
      assert.equal(invalid.status, 400);
      await invalid.body?.cancel();
      callback.searchParams.set('state', url.searchParams.get('state')!);
      const valid = await fetch(callback);
      assert.equal(valid.status, 200);
      await valid.body?.cancel();
    }, 3000);
    assert.equal(provider.tokens()?.access_token, 'access-1');
    const identity = provider.identity;
    assert.notEqual(identity, 'unauthorized');
    await assert.rejects(provider.redirectToAuthorization(new URL('file:///etc/passwd')), /Unsafe/);
    const [file] = await readdir(directory);
    assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
    const restored = await new McpOAuth(`${base}/mcp`, config, directory).load();
    assert.equal(restored.tokens()?.refresh_token, 'refresh-secret');
    await Promise.all([restored.refresh(3000), restored.refresh(3000), restored.refresh(3000)]);
    assert.equal(grants, 2);
    assert.equal(restored.tokens()?.access_token, 'access-2');
    assert.equal(restored.identity, identity);
    await restored.logout();
    assert.equal(restored.identity, 'unauthorized');
    assert.equal((await readdir(directory)).length, 0);
    assert.equal(
      (await new McpOAuth(`${base}/other`, config, directory).load()).tokens(),
      undefined,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('OAuth config refuses insecure remote endpoints and ambiguous Authorization headers', () => {
  for (const url of ['http://example.com/mcp', 'https://example.com/mcp']) {
    const config = ServerSchema.parse({
      transport: 'http',
      url,
      oauth: {},
      ...(url.startsWith('https:') ? { headers: { Authorization: 'Bearer secret' } } : {}),
    });
    assert.throws(() => resolveConfig(config, '/tmp'));
  }
});
