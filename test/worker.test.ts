import { equal, ok } from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { type Processor, type Torrents, Worker } from '../src/worker.ts';
import { Crawler } from '../src/crawler.ts';
import { Runtime } from '../src/runtime.ts';
import type { Telegram } from '../src/telegram.ts';
import { UncertainSendError } from '../src/telegram.ts';
import { type Torrent, VideoRejectedError } from '../src/types.ts';
import { article, config } from './helpers.ts';

const torrent: Torrent = {
  hash: 'abc',
  name: 'test',
  content_path: '/test',
  progress: 1,
  state: 'uploading',
  downloaded: 1,
  total_size: 1,
  dlspeed: 0,
  eta: 0,
  num_seeds: 1,
};
function setup(options: { group?: boolean; fail?: Error; stall?: boolean } = {}) {
  const store = new Store(':memory:'), runtime = new Runtime(2), supp = store.enqueue(article, ['abc']);
  store.saveChannel(supp.id, config.channelId, 10);
  if (options.group !== false) store.saveForward(config.channelId, 10, config.groupId, 20);
  let published = 0, processed = 0, pending = 0;
  const telegram: Telegram = {
    pendingMagnets: () => {
      pending++;
      return Promise.resolve();
    },
    publish: () => {
      published++;
      return Promise.resolve();
    },
    document: () => Promise.resolve(),
    screenshot: () => Promise.resolve(),
    video: () => Promise.resolve(),
  };
  const qbit: Torrents = {
    add: () => Promise.resolve(),
    torrents: () => Promise.resolve([{ ...torrent, progress: options.stall ? 0 : 1 }]),
  };
  const media: Processor = {
    process: () => {
      processed++;
      return options.fail ? Promise.reject(options.fail) : Promise.resolve();
    },
  };
  const worker = new Worker(config, store, new Crawler(), qbit, telegram, media, runtime);
  return {
    store,
    runtime,
    supp,
    worker,
    published: () => published,
    pending: () => pending,
    processed: () => processed,
  };
}
Deno.test('worker resumes existing channel post and completes torrent without republishing', async () => {
  const t = setup();
  try {
    await t.worker.execute(t.store.claim()!, new AbortController().signal);
    equal(t.store.supp(t.supp.id).status, 'done');
    equal(t.published(), 0);
    equal(t.pending(), 1);
    equal(t.processed(), 1);
    equal(t.store.torrents(t.supp.id)[0]!.status, 'done');
    equal(t.runtime.snapshot().running.length, 0);
  } finally {
    t.store.close();
  }
});
Deno.test('missing linked group times out and requeues without reposting', async () => {
  const t = setup({ group: false });
  try {
    await t.worker.execute(t.store.claim()!, new AbortController().signal);
    equal(t.store.supp(t.supp.id).status, 'pending');
    equal(t.published(), 0);
    equal(t.processed(), 0);
    const job = t.store.one<{ error: string; state: string }>('SELECT * FROM suppbot_jobs')!;
    equal(job.state, 'queued');
    ok(job.error.includes('linked group'));
  } finally {
    t.store.close();
  }
});
Deno.test('processing exception records error rather than done and schedules retry', async () => {
  const t = setup({ fail: new Error('transcode failed') });
  try {
    await t.worker.execute(t.store.claim()!, new AbortController().signal);
    equal(t.store.torrents(t.supp.id)[0]!.status, 'error');
    equal(t.store.supp(t.supp.id).status, 'pending');
  } finally {
    t.store.close();
  }
});
Deno.test('uncertain sends stop automatic retries until reconciliation', async () => {
  const t = setup({ fail: new UncertainSendError('unknown send outcome') });
  try {
    await t.worker.execute(t.store.claim()!, new AbortController().signal);
    equal(t.store.supp(t.supp.id).status, 'error');
    equal(t.store.claim(Date.now() + 10_000_000), undefined);
  } finally {
    t.store.close();
  }
});
Deno.test('shutdown cancels polling and preserves interrupted work without spending a retry', async () => {
  const t = setup({ stall: true }), shutdown = new AbortController();
  const timer = setTimeout(() => shutdown.abort(new Error('shutdown')), 10);
  try {
    await t.worker.execute(t.store.claim()!, shutdown.signal);
    equal(t.store.supp(t.supp.id).status, 'pending');
    equal(t.store.one<{ attempts: number }>('SELECT attempts FROM suppbot_jobs')!.attempts, 0);
  } finally {
    clearTimeout(timer);
    t.store.close();
  }
});

Deno.test('scheduler bounds concurrent work and keeps all interrupted jobs queued', async () => {
  const store = new Store(':memory:'), runtime = new Runtime(2), shutdown = new AbortController();
  for (let index = 0; index < 5; index++) {
    const supp = store.enqueue({ ...article, url: `https://example.test/wp/${index}.html` }, ['abc']);
    store.saveChannel(supp.id, config.channelId, index + 1);
    store.saveForward(config.channelId, index + 1, config.groupId, index + 10);
  }
  let active = 0, maximum = 0, started!: () => void;
  const ready = new Promise<void>((resolve) => started = resolve);
  const media: Processor = {
    process: (_torrent, _supp, _record, signal) =>
      new Promise((_resolve, reject) => {
        active++;
        maximum = Math.max(maximum, active);
        if (active === 2) started();
        signal.addEventListener('abort', () => {
          active--;
          reject(signal.reason);
        }, { once: true });
      }),
  };
  const telegram: Telegram = {
    publish: () => Promise.resolve(),
    document: () => Promise.resolve(),
    screenshot: () => Promise.resolve(),
    video: () => Promise.resolve(),
  };
  const qbit: Torrents = { add: () => Promise.resolve(), torrents: () => Promise.resolve([torrent]) };
  const worker = new Worker(config, store, new Crawler(), qbit, telegram, media, runtime);
  const deadline = setTimeout(() => shutdown.abort(new Error('Test deadline')), 3000);
  try {
    const running = worker.run(shutdown.signal);
    await ready;
    equal(maximum, 2);
    equal(store.all("SELECT * FROM suppbot_jobs WHERE state='queued'").length, 3);
    shutdown.abort(new Error('Test shutdown'));
    await running;
    equal(active, 0);
    equal(runtime.snapshot().running.length, 0);
    equal(store.all("SELECT * FROM suppbot_jobs WHERE state='queued' AND attempts=0").length, 5);
  } finally {
    clearTimeout(deadline);
    shutdown.abort();
    store.close();
  }
});

Deno.test('a video below the fitting minimum bitrate fails immediately without automatic retries', async () => {
  const t = setup({ fail: new VideoRejectedError('视频无法在 1.90 GB 内保持至少 400 kbps') });
  try {
    await t.worker.execute(t.store.claim()!, new AbortController().signal);
    equal(t.store.supp(t.supp.id).status, 'error');
    equal(t.store.torrents(t.supp.id)[0]!.status, 'error');
    equal(t.store.claim(Date.now() + 10_000_000), undefined);
    ok(t.store.torrents(t.supp.id)[0]!.error.includes('400 kbps'));
  } finally {
    t.store.close();
  }
});
