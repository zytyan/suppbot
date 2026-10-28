import { equal, ok } from 'node:assert/strict';
import { estimatedSize, needArchive, probe, screenshots, transcode, walkFiles } from '../src/media.ts';

Deno.test('video size estimate retains original upload thresholds', () => {
  equal(estimatedSize(1000, 192000), 1_054_720_000);
  ok(estimatedSize(1800, 192000) < 2_000_000_000);
  ok(estimatedSize(1900, 192000) > 2_000_000_000);
});
Deno.test('real FFmpeg conversion and nine-frame contact sheet work on archived video fixture', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'suppbot-media-test-' }),
    signal = new AbortController().signal;
  try {
    const input = new URL('./fixtures/sample.mp4', import.meta.url).pathname, output = `${dir}/converted.mp4`;
    await transcode(input, output, true, false, signal, () => {});
    const info = await probe(output, signal);
    equal(info.streams.find((stream) => stream.codec_type === 'video')!.codec_name, 'h264');
    const shots = await screenshots(output, Number(info.format.duration), dir, signal);
    ok((await Deno.stat(shots.image)).size > 0);
    ok((await Deno.stat(shots.thumbnail)).size < 200_000);
    const thumb = await probe(shots.thumbnail, signal);
    ok(thumb.streams[0]!.width! <= 320);
    ok(thumb.streams[0]!.height! <= 320);
    equal(await needArchive(output), false);
    equal((await walkFiles(output)).length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('original files preserve record keys and successful files are skipped on retry', async () => {
  const { Store } = await import('../src/store.ts');
  const { MediaProcessor } = await import('../src/media.ts');
  const { Runtime } = await import('../src/runtime.ts');
  const { article } = await import('./helpers.ts');
  const dir = await Deno.makeTempDir({ prefix: 'suppbot-files-test-' }), store = new Store(':memory:');
  let sent = 0;
  try {
    await Deno.writeTextFile(`${dir}/a.zip`, 'test');
    await Deno.writeTextFile(`${dir}/b.rar`, 'test');
    const supp = store.enqueue(article, ['abc']), record = store.torrents(supp.id)[0]!;
    const telegram: import('../src/telegram.ts').Telegram = {
      publish: () => Promise.resolve(),
      screenshot: () => Promise.resolve(),
      video: () => Promise.resolve(),
      document: (_supp, send) => {
        sent++;
        store.updateSend(send.id, { status: 'success', group_message_id: sent });
        return Promise.resolve();
      },
    };
    const media = new MediaProcessor(store, telegram, new Runtime(2));
    const torrent = {
      hash: 'abc',
      name: 'test',
      content_path: dir,
      progress: 1,
      state: 'uploading',
      downloaded: 1,
      total_size: 1,
      dlspeed: 0,
      eta: 0,
      num_seeds: 1,
    };
    await media.process(torrent, supp, record, new AbortController().signal);
    await media.process(torrent, supp, record, new AbortController().signal);
    equal(sent, 2);
    equal(store.all('SELECT * FROM send_records').length, 2);
  } finally {
    store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
Deno.test('RAR packaging uses an isolated directory and uploads archive records', async () => {
  const { Store } = await import('../src/store.ts'),
    { MediaProcessor } = await import('../src/media.ts'),
    { Runtime } = await import('../src/runtime.ts'),
    { article } = await import('./helpers.ts');
  const dir = await Deno.makeTempDir({ prefix: 'suppbot-archive-test-' }), store = new Store(':memory:');
  try {
    await Deno.writeTextFile(`${dir}/readme.txt`, 'example');
    const supp = store.enqueue(article, ['abc']), record = store.torrents(supp.id)[0]!;
    let uploads = 0;
    const telegram: import('../src/telegram.ts').Telegram = {
      publish: () => Promise.resolve(),
      screenshot: () => Promise.resolve(),
      video: () => Promise.resolve(),
      document: async (_supp, send, path, caption) => {
        uploads++;
        equal(send.send_type, 'archive');
        ok(send.source_path.startsWith('archive:'));
        ok((await Deno.stat(path)).size > 0);
        ok(caption.includes('没有密码'));
        store.updateSend(send.id, { status: 'success' });
      },
    };
    await new MediaProcessor(store, telegram, new Runtime(2)).process(
      {
        hash: 'abc',
        name: 'test',
        content_path: dir,
        progress: 1,
        state: 'uploading',
        downloaded: 1,
        total_size: 1,
        dlspeed: 0,
        eta: 0,
        num_seeds: 1,
      },
      supp,
      record,
      new AbortController().signal,
    );
    equal(uploads, 1);
  } finally {
    store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
