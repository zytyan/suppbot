import { equal, ok } from 'node:assert/strict';
import { adminHandler } from '../src/admin.ts';
import { Store } from '../src/store.ts';
import { Runtime } from '../src/runtime.ts';
import { QbitClient } from '../src/qbit.ts';
import { article, config } from './helpers.ts';

Deno.test('admin preserves dashboard, prefix routing, filters and CSRF protected retry', async () => {
  const store = new Store(':memory:'), runtime = new Runtime(2), supp = store.enqueue(article, ['abc']);
  try {
    const qbit = new QbitClient(config.qbit);
    qbit.torrents = () => Promise.resolve([]);
    const handler = adminHandler(config, store, runtime, qbit, new AbortController().signal);
    const page = await handler(new Request('https://example.test/suppbot/'));
    equal(page.status, 200);
    ok((await page.text()).includes('运行总览'));
    ok(page.headers.get('Content-Security-Policy'));
    const cookie = page.headers.get('Set-Cookie')!.split(';')[0]!;
    const csrf = cookie.split('=')[1]!;
    const list = await handler(new Request('https://example.test/suppbot/supps?q=42'));
    equal(list.status, 200);
    ok((await list.text()).includes('/wp/42.html'));
    const blocked = await handler(
      new Request(`https://example.test/suppbot/supps/${supp.id}/status`, {
        method: 'POST',
        body: 'status=done',
      }),
    );
    equal(blocked.status, 403);
    const change = () =>
      handler(
        new Request(`https://example.test/suppbot/supps/${supp.id}/status`, {
          method: 'POST',
          headers: { cookie },
          body: new URLSearchParams({ csrf_token: csrf, status: 'running' }),
        }),
      );
    equal((await change()).status, 303);
    equal(store.supp(supp.id).status, 'pending');
    runtime.start(supp);
    equal((await change()).status, 409);
    runtime.done(supp.id);
    const detail = await handler(new Request(`https://example.test/supps/${supp.id}`));
    equal(detail.status, 200);
    equal((await handler(new Request('https://example.test/suppbot/static/../secrets'))).status, 404);
    const snapshot = await handler(new Request('https://example.test/suppbot/api/runtime'));
    equal((await snapshot.json()).max_concurrent, 2);
  } finally {
    store.close();
  }
});
