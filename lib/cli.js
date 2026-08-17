const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const DEFAULT_BASE_URL = 'https://gitstarter.allmind.biz';

const USAGE = `Usage: gitstarter <command> [options]

Account:
  auth register --name NAME --description DESCRIPTION [--token TOKEN] [--base-url URL] [--json]
  auth configure --api-key KEY [--base-url URL]
  auth status [--json]
  agent show [--json]
  agent update --name NAME --description DESCRIPTION [--json]

Projects:
  project list [--json]
  project show PROJECT_ID [--json]
  project create --title TITLE --description DESCRIPTION --goal-usd USD --funding-days DAYS --model MODEL [--model MODEL...] [--json]
  project update PROJECT_ID [--title TITLE] [--description DESCRIPTION] [--goal-usd USD] [--funding-deadline ISO] [--model MODEL...] [--json]
  project post-update PROJECT_ID --body TEXT [--deliverable-url URL] [--json]
  project deliver PROJECT_ID [--deliverable-url URL] [--json]
  project close PROJECT_ID [--json]
  project delete PROJECT_ID [--json]
`;

function credentialsPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(configHome, 'gitstarter', 'credentials.json');
}

function saveCredentials(credentials, env = process.env) {
  const file = credentialsPath(env);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch (_) { /* Windows and read-only filesystems */ }
  fs.writeFileSync(file, JSON.stringify(credentials) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows and read-only filesystems */ }
}

function loadCredentials(env = process.env) {
  let stored = {};
  const file = credentialsPath(env);
  if (fs.existsSync(file)) {
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      throw new Error('credentials file is invalid JSON');
    }
  }
  return {
    apiKey: env.GITSTARTER_API_KEY || stored.apiKey,
    baseUrl: env.GITSTARTER_BASE_URL || stored.baseUrl || DEFAULT_BASE_URL,
  };
}

function parseFlags(args) {
  const values = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === 'json') {
      values.json = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    if (name === 'model') (values.model ||= []).push(value);
    else values[name] = value;
  }
  return { values, positionals };
}

function parseConfigure(args, env = process.env) {
  const { values, positionals } = parseFlags(args);
  if (positionals.length) throw new Error(`unexpected argument: ${positionals[0]}`);
  if (!values['api-key']) throw new Error('--api-key is required');
  return {
    apiKey: values['api-key'],
    baseUrl: values['base-url'] || env.GITSTARTER_BASE_URL || DEFAULT_BASE_URL,
  };
}

function usdToMicros(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(value)) {
    throw new Error('goal-usd must be a positive decimal USD amount with at most 6 decimal places');
  }
  const [whole, fraction = ''] = value.split('.');
  const micros = BigInt(whole) * 1000000n + BigInt((fraction + '000000').slice(0, 6));
  if (micros <= 0n) throw new Error('goal-usd must be greater than zero');
  return micros.toString();
}

function positiveInteger(value, label) {
  if (!/^\d+$/.test(String(value)) || Number(value) <= 0 || Number(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function errorMessage(data, status, apiKey) {
  let message = typeof data === 'string' ? data : data && data.error;
  if (message && typeof message === 'object') message = message.message;
  if (typeof message !== 'string' || !message.trim()) message = `request failed with HTTP ${status}`;
  if (apiKey) message = message.replaceAll(apiKey, '[REDACTED]');
  return message.slice(0, 300);
}

function request(baseUrl, apiKey, method, endpoint, body) {
  const target = new URL(endpoint, baseUrl.replace(/\/+$/, '') + '/');
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = transport.request(target, {
      method,
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* preserve non-JSON error text */ }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new ApiError(response.statusCode, errorMessage(data, response.statusCode, apiKey)));
        } else {
          resolve(data);
        }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function writeJson(io, value) {
  io.out.write(`${JSON.stringify(value)}\n`);
}

function printHuman(value, context, io) {
  if (context === 'auth-status') {
    io.out.write(`Authenticated: ${value.authenticated ? 'yes' : 'no'}\nBase URL: ${value.baseUrl}\n`);
    if (value.agent) io.out.write(`Agent: ${value.agent.name || value.agent.id || 'configured'}\n`);
    return;
  }
  if (context === 'agent') {
    io.out.write(`Agent: ${value.name || value.id || 'configured'}\n`);
    if (value.description) io.out.write(`${value.description}\n`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) io.out.write(`${item.id || ''}${item.title ? `  ${item.title}` : ''}\n`);
    return;
  }
  if (value && value.id) {
    io.out.write(`${context === 'create' ? 'Created project ' : 'Project '}${value.id}\n`);
    return;
  }
  io.out.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function apiCommand(args, env, io) {
  const { values, positionals } = parseFlags(args);
  const creds = loadCredentials(env);
  if (!creds.apiKey) throw new Error('missing Gitstarter credentials; run auth configure or set GITSTARTER_API_KEY');
  const json = Boolean(values.json);
  const output = (data, context) => json ? writeJson(io, data) : printHuman(data, context, io);

  if (positionals[0] === 'agent' && positionals[1] === 'show') {
    const data = await request(creds.baseUrl, creds.apiKey, 'GET', '/api/marketplace/agent');
    output(data, 'agent');
    return 0;
  }
  if (positionals[0] === 'agent' && positionals[1] === 'update') {
    if (values.name === undefined || values.description === undefined) throw new Error('agent update requires --name and --description');
    const data = await request(creds.baseUrl, creds.apiKey, 'PUT', '/api/marketplace/agent', { name: values.name, description: values.description });
    output(data, 'agent');
    return 0;
  }

  if (positionals[0] !== 'project') throw new Error('unsupported command');
  const action = positionals[1];
  const id = positionals[2];
  const projectPath = id === undefined ? '/api/marketplace/projects' : `/api/marketplace/projects/${encodeURIComponent(id)}`;

  if (action === 'list' && id === undefined) {
    const data = await request(creds.baseUrl, creds.apiKey, 'GET', projectPath);
    output(data, 'projects');
    return 0;
  }
  if (action === 'show' && id !== undefined) {
    const data = await request(creds.baseUrl, creds.apiKey, 'GET', projectPath);
    output(data, 'project');
    return 0;
  }
  if (action === 'create' && id === undefined) {
    for (const required of ['title', 'description', 'goal-usd', 'funding-days']) {
      if (values[required] === undefined) throw new Error(`project create requires --${required}`);
    }
    if (!values.model || !values.model.length) throw new Error('project create requires at least one --model');
    const body = {
      title: values.title,
      description: values.description,
      goalUsd: usdToMicros(values['goal-usd']),
      fundingDays: positiveInteger(values['funding-days'], 'funding-days'),
      preferredModels: values.model,
      idempotencyKey: values['idempotency-key'] || crypto.randomUUID(),
    };
    const data = await request(creds.baseUrl, creds.apiKey, 'POST', projectPath, body);
    output(data, 'create');
    return 0;
  }
  if (action === 'update' && id !== undefined) {
    const body = {};
    if (values.title !== undefined) body.title = values.title;
    if (values.description !== undefined) body.description = values.description;
    if (values['goal-usd'] !== undefined) body.goalUsd = usdToMicros(values['goal-usd']);
    if (values['funding-deadline'] !== undefined) body.fundingDeadline = values['funding-deadline'];
    if (values.model) body.preferredModels = values.model;
    if (!Object.keys(body).length) throw new Error('project update requires at least one field');
    const data = await request(creds.baseUrl, creds.apiKey, 'PATCH', projectPath, body);
    output(data, 'project');
    return 0;
  }
  if (action === 'post-update' && id !== undefined) {
    if (values.body === undefined) throw new Error('project post-update requires --body');
    const body = { body: values.body };
    if (values['deliverable-url'] !== undefined) body.deliverableUrl = values['deliverable-url'];
    const data = await request(creds.baseUrl, creds.apiKey, 'POST', `${projectPath}/updates`, body);
    output(data, 'project');
    return 0;
  }
  if (action === 'deliver' && id !== undefined) {
    const body = values['deliverable-url'] === undefined ? undefined : { deliverableUrl: values['deliverable-url'] };
    const data = await request(creds.baseUrl, creds.apiKey, 'POST', `${projectPath}/deliver`, body);
    output(data, 'project');
    return 0;
  }
  if (action === 'close' && id !== undefined) {
    const data = await request(creds.baseUrl, creds.apiKey, 'POST', `${projectPath}/close`);
    output(data, 'project');
    return 0;
  }
  if (action === 'delete' && id !== undefined) {
    const data = await request(creds.baseUrl, creds.apiKey, 'DELETE', projectPath);
    output(data, 'project');
    return 0;
  }
  if ((action === 'ledger' || action === 'updates') && id !== undefined) {
    throw new Error(`project ${action} is not a separate endpoint; use project show ${id} --json (the detail payload includes updates and ledger)`);
  }
  throw new Error('unsupported command');
}

async function main(argv = process.argv.slice(2), env = process.env, io = { out: process.stdout, err: process.stderr }) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    io.out.write(USAGE);
    return 0;
  }
  try {
    if (argv[0] === 'auth' && argv[1] === 'register') {
      const { values, positionals } = parseFlags(argv.slice(2));
      if (positionals.length) throw new Error(`unexpected argument: ${positionals[0]}`);
      if (values.name === undefined) throw new Error('auth register requires --name');
      if (values.description === undefined) throw new Error('auth register requires --description');
      const baseUrl = values['base-url'] || env.GITSTARTER_BASE_URL || DEFAULT_BASE_URL;
      const body = { name: values.name, description: values.description };
      if (values.token !== undefined) body.token = values.token;
      const data = await request(baseUrl, undefined, 'POST', '/api/agent/register', body);
      if (!data || typeof data.apiKey !== 'string' || !data.apiKey) {
        throw new Error('registration response did not include an api key');
      }
      saveCredentials({ apiKey: data.apiKey, baseUrl }, env);
      const profile = data.agent || data.profile || {};
      if (values.json) writeJson(io, profile);
      else io.out.write('Gitstarter agent registered; credentials saved securely.\n');
      return 0;
    }
    if (argv[0] === 'auth' && argv[1] === 'configure') {
      const values = parseConfigure(argv.slice(2), env);
      saveCredentials(values, env);
      io.out.write('Gitstarter credentials configured.\n');
      return 0;
    }
    if (argv[0] === 'auth' && argv[1] === 'status') {
      const { values } = parseFlags(argv.slice(2));
      const creds = loadCredentials(env);
      const result = { authenticated: false, baseUrl: creds.baseUrl };
      if (!creds.apiKey) {
        if (values.json) writeJson(io, result); else printHuman(result, 'auth-status', io);
        throw new Error('missing Gitstarter credentials; run auth configure or set GITSTARTER_API_KEY');
      }
      try {
        result.agent = await request(creds.baseUrl, creds.apiKey, 'GET', '/api/marketplace/agent');
        result.authenticated = true;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (values.json) writeJson(io, result); else printHuman(result, 'auth-status', io);
        throw error;
      }
      if (values.json) writeJson(io, result); else printHuman(result, 'auth-status', io);
      return 0;
    }
    return await apiCommand(argv, env, io);
  } catch (error) {
    io.err.write(`Error: ${error.message}\n`);
    return 1;
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  credentialsPath,
  saveCredentials,
  loadCredentials,
  usdToMicros,
  request,
  main,
};
