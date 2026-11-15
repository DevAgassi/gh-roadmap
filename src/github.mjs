/**
 * Thin wrapper around the `gh` CLI. Authentication, hosts and tokens are
 * handled by `gh`, so this tool never touches credentials itself.
 */
import { execFileSync } from 'node:child_process';

/** Delay after each write request, to stay under GitHub secondary rate limits. */
const WRITE_DELAY_MS = Number(process.env.GH_ROADMAP_WRITE_DELAY_MS ?? 1000);

const sleep = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function gh(args, input) {
  return execFileSync('gh', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Calls the REST API. `body` is sent as JSON on stdin.
 * With `paginate`, all pages are fetched and returned as an array of pages.
 */
export function api(method, endpoint, body, { paginate = false } = {}) {
  const args = ['api', endpoint, '--method', method];
  if (paginate) args.push('--paginate', '--slurp');
  if (body !== undefined) args.push('--input', '-');
  const out = gh(args, body !== undefined ? JSON.stringify(body) : undefined);
  if (method !== 'GET') sleep(WRITE_DELAY_MS);
  return out.trim() ? JSON.parse(out) : null;
}

/** Calls the GraphQL API. Mutations are throttled like REST writes. */
export function graphql(query, variables = {}) {
  const out = gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }));
  if (/^\s*mutation\b/.test(query)) sleep(WRITE_DELAY_MS);
  const res = JSON.parse(out);
  if (res.errors?.length) throw new Error(JSON.stringify(res.errors));
  return res.data;
}

export function errorText(err) {
  return String(err?.stderr || err?.message || err);
}

/** Returns "owner/name" of the repository in the current directory, or null. */
export function currentRepo() {
  try {
    return gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim() || null;
  } catch {
    return null;
  }
}

/** Verifies that `gh` is installed and authenticated; throws a readable error otherwise. */
export function assertGhReady() {
  try {
    gh(['auth', 'status']);
  } catch (err) {
    throw new Error(`gh CLI is not installed or not authenticated.\n${errorText(err).trim()}`);
  }
}
