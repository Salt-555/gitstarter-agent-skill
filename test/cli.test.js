const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const bin = path.join(root, 'bin', 'gitstarter.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function runAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

test('auth configure stores credentials with a private mode without leaking the key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitstarter-home-'));
  const key = 'gs_sk_test_secret_value';
  const result = run(['auth', 'configure', '--api-key', key, '--base-url', 'http://example.test'], {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configured/i);
  assert.doesNotMatch(result.stdout, new RegExp(key));
  assert.doesNotMatch(result.stderr, new RegExp(key));

  const credentialsPath = path.join(home, '.config', 'gitstarter', 'credentials.json');
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  assert.deepEqual(credentials, { baseUrl: 'http://example.test', apiKey: key });
  assert.equal(fs.statSync(credentialsPath).mode & 0o777, 0o600);
});

test('auth register posts the signup profile, stores the returned key, and only prints the profile', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitstarter-register-home-'));
  const key = 'gs_sk_register_secret';
  let request;
  const server = http.createServer((req, response) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      request = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(text) };
      jsonResponse(response, 201, {
        agent: { id: 'agent-1', name: 'Registered Agent' },
        apiKey: key,
        message: 'Store this key now',
      });
    });
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const result = await runAsync(['auth', 'register', '--token', 'signup-token', '--name', 'Registered Agent', '--description', 'A test profile', '--base-url', baseUrl, '--json'], {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
  });
  await close(server);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/agent/register');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.body, { token: 'signup-token', name: 'Registered Agent', description: 'A test profile' });
  assert.deepEqual(JSON.parse(result.stdout), { id: 'agent-1', name: 'Registered Agent' });
  assert.doesNotMatch(result.stdout, new RegExp(key));
  assert.doesNotMatch(result.stderr, new RegExp(key));

  const credentialsPath = path.join(home, '.config', 'gitstarter', 'credentials.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')), { apiKey: key, baseUrl });
  assert.equal(fs.statSync(credentialsPath).mode & 0o777, 0o600);
});

test('auth status reports the profile and never includes the API key', async () => {
  const key = 'gs_sk_status_secret';
  const server = http.createServer((req, response) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/marketplace/agent');
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    jsonResponse(response, 200, { id: 'agent-1', name: 'Test Agent', description: 'profile' });
  });
  const port = await listen(server);
  const result = await runAsync(['auth', 'status', '--json'], {
    GITSTARTER_API_KEY: key,
    GITSTARTER_BASE_URL: `http://127.0.0.1:${port}`,
  });
  await close(server);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, {
    authenticated: true,
    baseUrl: `http://127.0.0.1:${port}`,
    agent: { id: 'agent-1', name: 'Test Agent', description: 'profile' },
  });
  assert.doesNotMatch(result.stdout, new RegExp(key));
  assert.doesNotMatch(result.stderr, new RegExp(key));
});

test('project create converts USD to micros and sends a generated idempotency key', async () => {
  let request;
  const server = http.createServer((req, response) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      request = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) };
      jsonResponse(response, 201, { id: 'project-1', title: request.body.title });
    });
  });
  const port = await listen(server);
  const result = await runAsync(['project', 'create', '--title', 'CLI', '--description', 'Build it', '--goal-usd', '12.345678', '--funding-days', '7', '--model', 'openai/gpt-4o-mini'], {
    GITSTARTER_API_KEY: 'gs_sk_test',
    GITSTARTER_BASE_URL: `http://127.0.0.1:${port}`,
  });
  await close(server);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/marketplace/projects');
  assert.equal(request.headers.authorization, 'Bearer gs_sk_test');
  assert.equal(request.body.goalUsd, '12345678');
  assert.deepEqual(request.body.preferredModels, ['openai/gpt-4o-mini']);
  assert.match(request.body.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.match(result.stdout, /project-1/);
});

test('project create accepts repeated models and a caller idempotency key in JSON mode', async () => {
  let body;
  const server = http.createServer((req, response) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      body = JSON.parse(text);
      jsonResponse(response, 201, { id: 'project-2', ...body });
    });
  });
  const port = await listen(server);
  const result = await runAsync(['project', 'create', '--title', 'CLI', '--description', 'Build it', '--goal-usd', '1', '--funding-days', '2', '--model', 'model/a', '--model', 'model/b', '--idempotency-key', 'retry-key', '--json'], {
    GITSTARTER_API_KEY: 'gs_sk_test',
    GITSTARTER_BASE_URL: `http://127.0.0.1:${port}`,
  });
  await close(server);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(body.preferredModels, ['model/a', 'model/b']);
  assert.equal(body.idempotencyKey, 'retry-key');
  assert.equal(body.goalUsd, '1000000');
  assert.deepEqual(JSON.parse(result.stdout), { id: 'project-2', ...body });
});

test('marketplace commands use the documented methods and paths', async () => {
  const requests = [];
  const server = http.createServer((req, response) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: text ? JSON.parse(text) : undefined });
      jsonResponse(response, 200, { id: 'p1', ok: true });
    });
  });
  const port = await listen(server);
  const env = { GITSTARTER_API_KEY: 'gs_sk_test', GITSTARTER_BASE_URL: `http://127.0.0.1:${port}` };
  const commands = [
    ['agent', 'show'],
    ['agent', 'update', '--name', 'Name', '--description', 'Description'],
    ['project', 'list'],
    ['project', 'show', 'p1'],
    ['project', 'update', 'p1', '--title', 'New', '--description', 'D', '--goal-usd', '2.50', '--funding-deadline', '2026-09-01T00:00:00.000Z', '--model', 'a', '--model', 'b'],
    ['project', 'post-update', 'p1', '--body', 'Progress', '--deliverable-url', 'https://example.test/deliverable'],
    ['project', 'deliver', 'p1', '--deliverable-url', 'https://example.test/deliverable'],
    ['project', 'close', 'p1'],
    ['project', 'delete', 'p1'],
  ];
  for (const command of commands) {
    const result = await runAsync(command, env);
    assert.equal(result.status, 0, `${command.join(' ')}: ${result.stderr}`);
  }
  await close(server);

  assert.deepEqual(requests, [
    { method: 'GET', url: '/api/marketplace/agent', body: undefined },
    { method: 'PUT', url: '/api/marketplace/agent', body: { name: 'Name', description: 'Description' } },
    { method: 'GET', url: '/api/marketplace/projects', body: undefined },
    { method: 'GET', url: '/api/marketplace/projects/p1', body: undefined },
    { method: 'PATCH', url: '/api/marketplace/projects/p1', body: { title: 'New', description: 'D', goalUsd: '2500000', fundingDeadline: '2026-09-01T00:00:00.000Z', preferredModels: ['a', 'b'] } },
    { method: 'POST', url: '/api/marketplace/projects/p1/updates', body: { body: 'Progress', deliverableUrl: 'https://example.test/deliverable' } },
    { method: 'POST', url: '/api/marketplace/projects/p1/deliver', body: { deliverableUrl: 'https://example.test/deliverable' } },
    { method: 'POST', url: '/api/marketplace/projects/p1/close', body: undefined },
    { method: 'DELETE', url: '/api/marketplace/projects/p1', body: undefined },
  ]);
});

test('project delete issues a DELETE with the stored key and parses {ok:true} in JSON mode', async () => {
  let request;
  const server = http.createServer((req, response) => {
    request = { method: req.method, url: req.url, headers: req.headers };
    jsonResponse(response, 200, { ok: true, deleted: true, id: 'p1' });
  });
  const port = await listen(server);
  const result = await runAsync(['project', 'delete', 'p1', '--json'], {
    GITSTARTER_API_KEY: 'gs_sk_test',
    GITSTARTER_BASE_URL: `http://127.0.0.1:${port}`,
  });
  await close(server);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(request.method, 'DELETE');
  assert.equal(request.url, '/api/marketplace/projects/p1');
  assert.equal(request.headers.authorization, 'Bearer gs_sk_test');
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, deleted: true, id: 'p1' });
});

test('--help and -h print usage including project delete and exit 0', () => {
  for (const args of [['--help'], ['-h'], []]) {
    const result = run(args);
    assert.equal(result.status, 0, `${args.join(' ') || '(no args)'}: ${result.stderr}`);
    assert.match(result.stdout, /Usage/i);
    assert.match(result.stdout, /project delete/);
    assert.match(result.stdout, /auth register/);
  }
});

test('API errors return a nonzero exit and redact the key', async () => {
  const key = 'gs_sk_error_secret';
  const server = http.createServer((req, response) => {
    jsonResponse(response, 401, { error: `invalid key ${key}` });
  });
  const port = await listen(server);
  const result = await runAsync(['project', 'list'], {
    GITSTARTER_API_KEY: key,
    GITSTARTER_BASE_URL: `http://127.0.0.1:${port}`,
  });
  await close(server);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid key \[REDACTED\]/);
  assert.doesNotMatch(result.stderr, new RegExp(key));
  assert.doesNotMatch(result.stdout, new RegExp(key));
});

test('project ledger/updates point at project show instead of pretending to be endpoints', async () => {
  const env = { GITSTARTER_API_KEY: 'gs_sk_test', GITSTARTER_BASE_URL: 'http://127.0.0.1:1' };
  for (const action of ['ledger', 'updates']) {
    const result = await runAsync(['project', action, 'p1'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`use project show`));
    assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
  }
});

test('project show passes through the detail payload including updates and ledger', async () => {
  const server = http.createServer((req, response) => {
    jsonResponse(response, 200, {
      id: 'p1',
      status: 'FUNDED',
      goalUsd: '5000000000',
      updates: [{ id: 'u1', body: 'progress' }],
      ledger: [{ id: 'l1', type: 'BURN', amount: '250000' }],
    });
  });
  const port = await listen(server);
  const result = await runAsync(['project', 'show', 'p1', '--json'], {
    GITSTARTER_API_KEY: 'gs_sk_test',
    GITSTARTER_BASE_URL: `http://127.0.0.1:${port}`,
  });
  await close(server);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.updates, [{ id: 'u1', body: 'progress' }]);
  assert.deepEqual(output.ledger, [{ id: 'l1', type: 'BURN', amount: '250000' }]);
});

test('invalid or zero USD amounts fail before making a request', async () => {
  let requests = 0;
  const server = http.createServer((req, response) => {
    requests += 1;
    jsonResponse(response, 500, { error: 'should not be reached' });
  });
  const port = await listen(server);
  const result = await runAsync(['project', 'create', '--title', 'CLI', '--description', 'Build it', '--goal-usd', '0.000000', '--funding-days', '2', '--model', 'model/a'], {
    GITSTARTER_API_KEY: 'gs_sk_test',
    GITSTARTER_BASE_URL: `http://127.0.0.1:${port}`,
  });
  await close(server);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /goal-usd must be greater than zero/);
  assert.equal(requests, 0);
});
