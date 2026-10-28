import { equal, ok, rejects } from 'node:assert/strict';
import { QbitClient } from '../src/qbit.ts';
import { config } from './helpers.ts';

Deno.test('qBittorrent reauthenticates once on 403 and replays the complete request', async () => {
  const originalFetch = globalThis.fetch;
  let logins = 0, additions = 0;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/login')) {
      logins++;
      return Promise.resolve(
        new Response('Ok.', { headers: { 'Set-Cookie': `SID=session${logins}; HttpOnly` } }),
      );
    }
    if (url.endsWith('/torrents/info')) return Promise.resolve(Response.json([]));
    ok(url.endsWith('/torrents/add'));
    additions++;
    equal(new URLSearchParams(String(init?.body)).get('urls'), 'magnet:?xt=urn:btih:abc');
    if (additions === 1) return Promise.resolve(new Response('Forbidden', { status: 403 }));
    equal(new Headers(init?.headers).get('Cookie'), 'SID=session2');
    return Promise.resolve(Response.json({ failure_count: 0, success_count: 1, pending_count: 0 }));
  };
  try {
    await new QbitClient(config.qbit).add(['abc'], new AbortController().signal);
    equal(logins, 2);
    equal(additions, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
Deno.test('qBittorrent matches infohash_v1 and caches concurrent reads', async () => {
  const originalFetch = globalThis.fetch;
  let reads = 0, adds = 0;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.endsWith('/auth/login')) {
      return Promise.resolve(new Response('Ok.', { headers: { 'Set-Cookie': 'SID=x' } }));
    }
    if (url.endsWith('/torrents/info')) {
      reads++;
      return Promise.resolve(Response.json([{ hash: 'other', infohash_v1: 'ABC' }]));
    }
    adds++;
    return Promise.resolve(new Response('Ok.'));
  };
  try {
    const qbit = new QbitClient(config.qbit), signal = new AbortController().signal;
    await qbit.add(['abc'], signal);
    equal(adds, 0);
    await Promise.all([qbit.torrents(signal), qbit.torrents(signal)]);
    equal(reads, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
Deno.test('qBittorrent rejects failed additions and bounds authentication retries', async () => {
  const originalFetch = globalThis.fetch;
  let logins = 0;
  globalThis.fetch = (input) => {
    if (String(input).endsWith('/auth/login')) {
      logins++;
      return Promise.resolve(new Response('Ok.', { headers: { 'Set-Cookie': 'SID=x' } }));
    }
    return Promise.resolve(new Response('Forbidden', { status: 403 }));
  };
  try {
    await rejects(() => new QbitClient(config.qbit).torrents(new AbortController().signal), /HTTP 403/);
    equal(logins, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
