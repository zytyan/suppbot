import { equal, ok, rejects, throws } from 'node:assert/strict';
import {
  bitrateForSize,
  encodeVideoWithinLimit,
  estimatedSize,
  MIN_VIDEO_BITRATE,
  needArchive,
  planVideo,
  type Probe,
  probe,
  screenshots,
  transcode,
  VIDEO_BITRATE,
  VIDEO_SIZE_BUDGET,
  walkFiles,
} from '../src/media.ts';
import { VideoRejectedError } from '../src/types.ts';

const videoInfo = (duration: number, bitrate = 4_500_001, audio = true): Probe => ({
  streams: [
    { codec_type: 'video', codec_name: 'h264', bit_rate: String(bitrate) },
    ...(audio ? [{ codec_type: 'audio', codec_name: 'aac', bit_rate: '192000' }] : []),
  ],
  format: { duration: String(duration) },
});

Deno.test('video compression threshold is strictly above 4.5 Mbps and target is 4 Mbps', () => {
  equal(planVideo(videoInfo(1200, 4_500_000), 1_000_000).full, false);
  const plan = planVideo(videoInfo(1200), 1_000_000);
  equal(plan.full, true);
  equal(plan.videoBitrate, 4_000_000);
  equal(plan.twoPass, false);
  equal(estimatedSize(1000, 192000), 539_720_000);
  equal(planVideo(videoInfo(1200, 1_000_000), 2_000_000_001).full, true);
});
Deno.test('only estimates above 2 GB switch to the 1.90 GB budget', () => {
  const duration = 2_000_000_000 * 8 / (4_192_000 * 1.03);
  equal(planVideo(videoInfo(duration), 1_000_000).twoPass, false);
  const plan = planVideo(videoInfo(duration + 1), 1_000_000);
  equal(plan.twoPass, true);
  equal(plan.maxOutputSize, 1_900_000_000);
  ok(estimatedSize(plan.duration, plan.audioBitrate, plan.videoBitrate) <= VIDEO_SIZE_BUDGET);
});
Deno.test('long video bitrate budgets include copied or converted audio and container overhead', () => {
  const info = videoInfo(7200), plan = planVideo(info, 4_000_000_000);
  ok(plan.videoBitrate < VIDEO_BITRATE);
  ok(plan.videoBitrate >= MIN_VIDEO_BITRATE);
  equal(plan.copyAAC, true);
  equal(plan.maxOutputSize, VIDEO_SIZE_BUDGET);
  equal(plan.twoPass, true);
  ok(estimatedSize(plan.duration, 192000, plan.videoBitrate) <= VIDEO_SIZE_BUDGET);
  const silent = planVideo(videoInfo(7200, 8_000_000, false), 4_000_000_000);
  equal(silent.audioBitrate, 0);
  ok(silent.videoBitrate > plan.videoBitrate);
  info.streams[1]!.codec_name = 'flac';
  info.streams[1]!.bit_rate = '1000000';
  const converted = planVideo(info, 4_000_000_000);
  equal(converted.audioBitrate, 192000);
  equal(converted.copyAAC, false);
});
Deno.test('400 kbps is accepted but a lower fitting bitrate is a terminal error', () => {
  const duration = VIDEO_SIZE_BUDGET * 8 / (1.03 * (192000 + 400000));
  equal(bitrateForSize(duration, 192000), 400000);
  throws(() => bitrateForSize(duration + 1, 192000), VideoRejectedError);
  throws(() => planVideo(videoInfo(28800), 10_000_000_000), VideoRejectedError);
});
Deno.test('missing stream bitrate falls back to file size and duration rather than bypassing compression', () => {
  const info = videoInfo(1200);
  delete info.streams[0]!.bit_rate;
  equal(planVideo(info, 800_000_000).full, true);
  equal(planVideo(info, 300_000_000).full, false);
  info.format.duration = 'NaN';
  throws(() => planVideo(info, 800_000_000), VideoRejectedError);
});
Deno.test('actual oversized output is re-encoded below budget and repeated oversize is rejected', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'suppbot-size-test-' }),
    output = dir + '/test.mp4',
    signal = new AbortController().signal;
  const plan = planVideo(videoInfo(1200), 800_000_000);
  const bitrates: number[] = [], passes: boolean[] = [];
  try {
    const encode: typeof transcode = async (
      _input,
      dest,
      _full,
      _aac,
      _signal,
      _progress,
      bitrate,
      twoPass,
    ) => {
      bitrates.push(bitrate!);
      passes.push(twoPass!);
      const file = await Deno.open(dest, { write: true, create: true });
      try {
        await file.truncate(bitrates.length === 1 ? 2_100_000_000 : VIDEO_SIZE_BUDGET);
      } finally {
        file.close();
      }
    };
    await encodeVideoWithinLimit('/unused', output, plan, signal, () => {}, encode);
    equal(bitrates.length, 2);
    ok(bitrates[1]! < bitrates[0]!);
    equal(passes[1], true);
    // Sparse files exercise real byte limits without allocating gigabytes of disk space.
    const tiny = { ...plan, maxOutputSize: 1 };
    const reject: typeof transcode = async (_input, dest) => {
      const file = await Deno.open(dest, { write: true, create: true });
      try {
        await file.truncate(2_000_000_001);
      } finally {
        file.close();
      }
    };
    await rejects(
      () => encodeVideoWithinLimit('/unused', output, tiny, signal, () => {}, reject),
      VideoRejectedError,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
Deno.test('real FFmpeg two-pass encoding accepts a dynamic bitrate and reports both passes', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'suppbot-two-pass-test-' }),
    signal = new AbortController().signal;
  try {
    const output = dir + '/output.mp4', passes = new Set<number>();
    await transcode(
      new URL('./fixtures/sample.mp4', import.meta.url).pathname,
      output,
      true,
      false,
      signal,
      (_seconds, pass) => passes.add(pass),
      400_000,
      true,
    );
    equal(passes.size, 2);
    const info = await probe(output, signal);
    equal(info.streams.find((stream) => stream.codec_type === 'video')!.codec_name, 'h264');
    ok((await Deno.stat(output)).size > 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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

Deno.test('changed output filenames preserve successful and uncertain video records across policy updates', async () => {
  const { Store } = await import('../src/store.ts'),
    { MediaProcessor } = await import('../src/media.ts'),
    { Runtime } = await import('../src/runtime.ts'),
    { article } = await import('./helpers.ts');
  const { UncertainSendError } = await import('../src/telegram.ts');
  const dir = await Deno.makeTempDir({ prefix: 'suppbot-video-record-test-' }), store = new Store(':memory:');
  try {
    const file = dir + '/video.mkv';
    await Deno.writeTextFile(file, 'Already handled; must not be probed or uploaded');
    const supp = store.enqueue(article, ['abc']), record = store.torrents(supp.id)[0]!;
    const previous = store.prepareSend(record.id, 'video.mkv', 'video', 'old-output.mp4');
    store.updateSend(previous.id, { status: 'success' });
    const unexpected = () => Promise.reject(new Error('Unexpected Telegram send'));
    const media = new MediaProcessor(store, {
      publish: unexpected,
      document: unexpected,
      screenshot: unexpected,
      video: unexpected,
    }, new Runtime(2));
    const torrent = {
      hash: 'abc',
      name: 'test',
      content_path: file,
      progress: 1,
      state: 'uploading',
      downloaded: 1,
      total_size: 1,
      dlspeed: 0,
      eta: 0,
      num_seeds: 1,
    };
    await media.process(torrent, supp, record, new AbortController().signal);
    equal(store.all('SELECT * FROM send_records').length, 1);
    store.updateSend(previous.id, { status: 'uncertain' });
    await rejects(
      () => media.process(torrent, supp, record, new AbortController().signal),
      UncertainSendError,
    );
    equal(store.all('SELECT * FROM send_records').length, 1);
  } finally {
    store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
