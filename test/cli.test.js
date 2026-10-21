import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildRequest } from '../src/cli.js';
import { normalizeBaseUrl } from '../src/client.js';

const BIN = fileURLToPath(new URL('../bin/podpitch.js', import.meta.url));
const KEY = 'pp_test_only_not_a_real_key';

function cli(args, env = {}, stdin = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, PODPITCH_API_KEY: '', PODPITCH_API_URL: '', ...env }, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function server(t, handler) {
  const service = createServer(handler);
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => service.close(resolve)));
  return `http://127.0.0.1:${service.address().port}`;
}

test('version, help, and invalid commands work without credentials', async () => {
  assert.equal((await cli(['--version'])).stdout, '1.0.0\n');
  assert.match((await cli(['--help'])).stdout, /records list/);
  assert.match((await cli(['campaigns', 'delete'])).stderr, /Unknown or incomplete/);
  assert.throws(() => buildRequest(['campaigns', 'list'], { limit: '10' }), /not supported/);
});

test('campaign IDs, pagination, filters, and timestamp are checked before making requests', () => {
  assert.throws(() => buildRequest(['records', 'list', '../secrets'], {}), /campaign ID/);
  assert.throws(() => buildRequest(['records', 'list', '12'], { limit: '251' }), /limit/);
  assert.throws(() => buildRequest(['pitches', 'list'], { offset: '100001' }), /offset/);
  assert.throws(() => buildRequest(['replies', 'list'], { 'event-type': 'booking_detected' }), /event-type/);
  assert.throws(() => buildRequest(['pitches', 'list'], { 'as-of': 'yesterday' }), /ISO timestamp/);
  assert.deepEqual(buildRequest(['records', 'get', '12', 'some/id?x=y'], {}), { path: '/campaigns/12/records/some%2Fid%3Fx%3Dy' });
  assert.equal(buildRequest(['replies', 'list'], { 'event-type': 'positive_reply' }).query.event_type, 'positive_reply');
});

test('rejects insecure remote origins and URL credentials', () => {
  for (const value of ['http://example.com', 'https://user:key@example.com', 'https://example.com/api', 'https://example.com?key=x']) {
    assert.throws(() => normalizeBaseUrl(value));
  }
  assert.equal(normalizeBaseUrl('https://api.podpitch.com/'), 'https://api.podpitch.com');
});

test('real CLI sends bearer auth and encoded filters, and emits only JSON on stdout', async (t) => {
  const baseUrl = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.url, '/api/v1/campaigns?status=Active&profile=Jane+Doe');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, campaigns: [{ id: 12 }] }));
  });
  const result = await cli(['campaigns', 'list', '--status', 'Active', '--profile', 'Jane Doe', '--compact'], { PODPITCH_API_KEY: KEY, PODPITCH_API_URL: baseUrl });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).campaigns, [{ id: 12 }]);
});

test('records, pitch events, and replies use the correct live API paths', async (t) => {
  const seen = [];
  const baseUrl = await server(t, (req, res) => { seen.push(req.url); res.end('[]'); });
  const env = { PODPITCH_API_KEY: KEY, PODPITCH_API_URL: baseUrl };
  const commands = [
    ['records', 'list', '12', '--type', 'journalist', '--limit', '5', '--offset', '2'],
    ['pitches', 'list', '--campaign-id', '12'],
    ['replies', 'list', '--event-type', 'positive_reply'],
    ['replies', 'get', 'message/id'],
  ];
  for (const args of commands) assert.equal((await cli(args, env)).code, 0);
  assert.deepEqual(seen, ['/api/v1/campaigns/12/podcasts?type=journalist&limit=5&offset=2', '/api/v1/pitches?campaign_id=12', '/api/v1/replies?event_type=positive_reply', '/api/v1/replies/message%2Fid']);
});

test('login verifies before saving, restricts permissions, binds the key to its origin, and logout removes it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'podpitch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseUrl = await server(t, (req, res) => { res.end('{"success":true,"campaigns":[]}'); });
  const env = { PODPITCH_CONFIG_DIR: directory, PODPITCH_API_URL: baseUrl };
  const login = await cli(['login', '--key-stdin'], env, KEY + '\n');
  assert.equal(login.code, 0);
  assert.equal(login.stdout, '');
  assert.ok(!login.stderr.includes(KEY));
  const file = join(directory, 'credentials.json');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).apiKey, KEY);
  assert.equal((await cli(['campaigns', 'list'], env)).code, 0);
  const status = await cli(['auth', 'status'], env);
  assert.equal(status.code, 0);
  assert.ok(!status.stdout.includes(KEY));
  assert.match((await cli(['campaigns', 'list', '--base-url', 'https://example.com'], env)).stderr, /different API URL/);
  assert.equal((await cli(['logout'], env)).code, 0);
  assert.match((await cli(['auth', 'status'], env)).stderr, /Run podpitch login/);
});

test('a failed login leaves existing credentials intact and never echoes the key', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'podpitch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'credentials.json');
  await writeFile(file, 'existing credentials');
  const baseUrl = await server(t, (req, res) => { res.writeHead(401); res.end(KEY); });
  const result = await cli(['login', '--key-stdin', '--base-url', baseUrl], { PODPITCH_CONFIG_DIR: directory }, KEY);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 401/);
  assert.ok(!result.stderr.includes(KEY));
  assert.equal(await readFile(file, 'utf8'), 'existing credentials');
});

test('redirects are rejected before credentials can be forwarded', async (t) => {
  let targetHit = false;
  const target = await server(t, (req, res) => { targetHit = true; res.end('{}'); });
  const baseUrl = await server(t, (req, res) => { res.writeHead(302, { Location: target }); res.end(); });
  const result = await cli(['campaigns', 'list'], { PODPITCH_API_KEY: KEY, PODPITCH_API_URL: baseUrl });
  assert.equal(result.code, 1);
  assert.equal(targetHit, false);
  assert.ok(!result.stderr.includes(KEY));
});

test('non-JSON responses fail cleanly', async (t) => {
  const baseUrl = await server(t, (req, res) => { res.end('<html>proxy error</html>'); });
  const result = await cli(['campaigns', 'list'], { PODPITCH_API_KEY: KEY, PODPITCH_API_URL: baseUrl });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid JSON/);
  assert.equal(result.stdout, '');
});
