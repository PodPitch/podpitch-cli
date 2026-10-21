import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';

import { DEFAULT_BASE_URL, normalizeBaseUrl, request, validateKey } from './client.js';

const HELP = `PodPitch CLI 1.0.0
Build PR reports and work with your PodPitch outreach data.
Website: https://www.podpitch.com

Usage:
  podpitch login                       Prompt for and verify your API key
  podpitch login --key-stdin            Read your key from standard input
  podpitch logout                      Remove your saved key from this computer
  podpitch auth status                 Show the API URL and credential source
  podpitch campaigns list              List campaigns and statistics
  podpitch campaigns get <id>          Get one campaign
  podpitch records list <campaign-id>  List outreach records in a campaign
  podpitch records get <campaign-id> <entity-id>
  podpitch pitches list                List sent pitch events
  podpitch replies list                List replies, with optional category filters
  podpitch replies get <message-id>    Get one reply

Filters:
  campaigns list: --status Active|Manual|Off|Archived --profile <name>
  records list:   --status not_sent|in_progress|replied|paused|skipped|finished|booked|appeared|opened
                 --type podcast|journalist|newsletter|person|guest
                 --limit 1..250 (default 50) --offset 0..
  pitches list:  --campaign-id <id> --limit 1..1000 (default 100) --offset 0..100000
                 --as-of <ISO timestamp>
  replies list:  Same as pitches, plus --event-type reply_received|positive_reply|negative_reply|meeting_requested|needs_info|out_of_office

Options:
  --base-url <origin>  API origin (default https://api.podpitch.com)
  --compact            Compact JSON output
  --help, -h           Show help
  --version, -v        Show version

Environment:
  PODPITCH_API_KEY      Use a key without saving it
  PODPITCH_API_URL      API origin for this environment
  PODPITCH_CONFIG_DIR   Override the local credential directory

Keys: https://app.podpitch.com/settings/api
Pitches, replies, and individual records require enabled integration access.
All data commands are read-only. JSON is written to stdout; errors go to stderr.
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  compact: { type: 'boolean' },
  'key-stdin': { type: 'boolean' },
  'base-url': { type: 'string' },
  status: { type: 'string' },
  profile: { type: 'string' },
  type: { type: 'string' },
  limit: { type: 'string' },
  offset: { type: 'string' },
  'campaign-id': { type: 'string' },
  'event-type': { type: 'string' },
  'as-of': { type: 'string' },
};

function integer(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function choice(value, name, choices) {
  if (value !== undefined && !choices.includes(value)) {
    throw new Error(`${name} must be one of: ${choices.join(', ')}.`);
  }
  return value;
}

function checkOptions(values, allowed) {
  for (const name of Object.keys(values)) {
    if (!['base-url', 'compact', ...allowed].includes(name)) throw new Error(`--${name} is not supported for this command.`);
  }
}

export function buildRequest(positionals, values) {
  const [group, action, id, entityId] = positionals;
  const signature = `${group} ${action}`;
  const expected = { 'campaigns list': 2, 'campaigns get': 3, 'records list': 3, 'records get': 4, 'pitches list': 2, 'replies list': 2, 'replies get': 3 };
  if (!(signature in expected) || positionals.length !== expected[signature]) throw new Error('Unknown or incomplete command. Run podpitch --help.');
  if (signature === 'campaigns list') {
    checkOptions(values, ['status', 'profile']);
    return { path: '/campaigns', query: { status: choice(values.status, 'status', ['Active', 'Manual', 'Off', 'Archived']), profile: values.profile } };
  }
  if (group === 'campaigns' || group === 'records') integer(id, 'campaign ID', 1);
  if (signature === 'campaigns get') {
    checkOptions(values, []);
    return { path: `/campaigns/${id}` };
  }
  if (signature === 'records get' || signature === 'replies get') {
    checkOptions(values, []);
    return { path: signature === 'records get' ? `/campaigns/${id}/records/${encodeURIComponent(entityId)}` : `/replies/${encodeURIComponent(id)}` };
  }
  if (signature === 'records list') {
    checkOptions(values, ['status', 'type', 'limit', 'offset']);
    return { path: `/campaigns/${id}/podcasts`, query: {
      status: choice(values.status, 'status', ['not_sent', 'in_progress', 'replied', 'paused', 'skipped', 'finished', 'booked', 'appeared', 'opened']),
      type: choice(values.type, 'type', ['podcast', 'journalist', 'newsletter', 'person', 'guest']),
      limit: integer(values.limit, 'limit', 1, 250), offset: integer(values.offset, 'offset', 0),
    } };
  }
  checkOptions(values, ['campaign-id', 'limit', 'offset', 'as-of', ...(group === 'replies' ? ['event-type'] : [])]);
  if (values['as-of'] !== undefined && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(values['as-of'])) {
    throw new Error('as-of must be an ISO timestamp with a timezone, such as 2026-10-21T00:00:00Z.');
  }
  if (values['as-of'] !== undefined && !Number.isFinite(Date.parse(values['as-of']))) throw new Error('as-of must be a valid timestamp.');
  return { path: `/${group}`, query: {
    campaign_id: integer(values['campaign-id'], 'campaign ID', 1),
    limit: integer(values.limit, 'limit', 1, 1000), offset: integer(values.offset, 'offset', 0, 100000),
    as_of: values['as-of'],
    ...(group === 'replies' ? { event_type: choice(values['event-type'], 'event-type', ['reply_received', 'positive_reply', 'negative_reply', 'meeting_requested', 'needs_info', 'out_of_office']) } : {}),
  } };
}

async function readConfig(file) {
  const content = await readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw new Error('Could not read your PodPitch credentials file. Check its permissions.');
  });
  if (content === null) return null;
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('Your PodPitch credentials file is invalid. Run podpitch logout and log in again.');
  }
}

async function promptKey() {
  if (!process.stdin.isTTY) throw new Error('Use podpitch login --key-stdin when reading a key from a pipe.');
  let muted = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stderr.write(chunk, encoding); callback(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  const answer = input.question('PodPitch API key (hidden): ');
  muted = true;
  try {
    return await answer;
  } finally {
    input.close();
    process.stderr.write('\n');
  }
}

export async function run(args = process.argv.slice(2), env = process.env) {
  const { positionals, values } = parseArgs({ args, options: OPTIONS, allowPositionals: true });
  if (values.version) return process.stdout.write('1.0.0\n');
  if (values.help || positionals.length === 0) return process.stdout.write(HELP);
  const configFile = join(env.PODPITCH_CONFIG_DIR || join(homedir(), '.config', 'podpitch'), 'credentials.json');
  const [command, action] = positionals;
  if (command === 'logout' && positionals.length === 1) {
    checkOptions(values, []);
    await rm(configFile, { force: true });
    return process.stderr.write('Removed the saved PodPitch key. PODPITCH_API_KEY, if set, still takes precedence.\n');
  }
  if (command === 'login' && positionals.length === 1) {
    checkOptions(values, ['key-stdin']);
    const baseUrl = normalizeBaseUrl(values['base-url'] || env.PODPITCH_API_URL || DEFAULT_BASE_URL);
    let suppliedKey;
    if (values['key-stdin']) {
      suppliedKey = '';
      for await (const chunk of process.stdin) suppliedKey += chunk;
    } else suppliedKey = await promptKey();
    const apiKey = validateKey(suppliedKey);
    await request(baseUrl, apiKey, '/campaigns');
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
    await chmod(dirname(configFile), 0o700);
    await writeFile(configFile, JSON.stringify({ baseUrl, apiKey }) + '\n', { mode: 0o600 });
    await chmod(configFile, 0o600);
    return process.stderr.write(`Signed in to ${baseUrl}. Saved your key in ${configFile} with owner-only permissions.\n`);
  }
  const isAuthStatus = command === 'auth' && action === 'status' && positionals.length === 2;
  const route = isAuthStatus ? null : buildRequest(positionals, values);
  if (isAuthStatus) checkOptions(values, []);
  const config = env.PODPITCH_API_KEY ? null : await readConfig(configFile);
  const baseUrl = normalizeBaseUrl(values['base-url'] || env.PODPITCH_API_URL || config?.baseUrl || DEFAULT_BASE_URL);
  const apiKey = env.PODPITCH_API_KEY || config?.apiKey;
  if (config?.apiKey && !env.PODPITCH_API_KEY && baseUrl !== config.baseUrl) {
    throw new Error('Your saved key belongs to a different API URL. Log in to the new URL or provide PODPITCH_API_KEY explicitly.');
  }
  if (!apiKey) throw new Error('Run podpitch login or set PODPITCH_API_KEY. Get your key at https://app.podpitch.com/settings/api.');
  if (isAuthStatus) return process.stdout.write(JSON.stringify({ base_url: baseUrl, credential_source: env.PODPITCH_API_KEY ? 'PODPITCH_API_KEY' : configFile }) + '\n');
  const data = await request(baseUrl, apiKey, route.path, route.query);
  process.stdout.write(JSON.stringify(data, null, values.compact ? 0 : 2) + '\n');
}
