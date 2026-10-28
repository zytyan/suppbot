import { basename, extname, join, relative, resolve } from 'node:path';
import { command, naturalSort } from './util.ts';
import type { SendRecord, Supp, Torrent, TorrentRecord } from './types.ts';
import { errorText } from './types.ts';
import { sendComplete, Store } from './store.ts';
import { type Telegram, UncertainSendError } from './telegram.ts';
import { Runtime } from './runtime.ts';

export const MAX_UPLOAD_SIZE = 2_000_000_000;
export const VIDEO_BITRATE = 8_000_000;
export const AUDIO_BITRATE = 192_000;
const videoExtensions = new Set(['.mp4', '.mkv', '.avi', '.mov']);
const isVideo = (path: string) => videoExtensions.has(extname(path).toLowerCase());
const stem = (path: string) => basename(path, extname(path));
export const estimatedSize = (duration: number, audioBitrate: number): number =>
  Math.floor((VIDEO_BITRATE + audioBitrate) * duration / 8 * 1.03);
const remove = (path: string) =>
  Deno.remove(path, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) console.error('Temporary file cleanup:', errorText(error));
  });

interface Stream {
  codec_type: string;
  codec_name: string;
  bit_rate?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}
export interface Probe {
  streams: Stream[];
  format: { duration?: string };
}
export async function probe(path: string, signal: AbortSignal): Promise<Probe> {
  return JSON.parse(
    await command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], signal),
  );
}

export async function transcode(
  input: string,
  output: string,
  full: boolean,
  copyAAC: boolean,
  signal: AbortSignal,
  progress: (seconds: number) => void,
): Promise<void> {
  const args = ['-y', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?'];
  args.push(
    ...(full
      ? [
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-b:v',
        '8000000',
        '-maxrate',
        '8000000',
        '-bufsize',
        '16000000',
        '-pix_fmt',
        'yuv420p',
      ]
      : ['-c:v', 'copy']),
  );
  args.push(...(copyAAC ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192000']));
  let pending = '';
  await command(
    'ffmpeg',
    [...args, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output],
    signal,
    (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('out_time_us=')) progress(Number(line.slice(12)) / 1e6);
    },
  );
}

export async function screenshots(
  video: string,
  duration: number,
  dir: string,
  signal: AbortSignal,
): Promise<{ image: string; thumbnail: string }> {
  if (!(duration > 0)) throw new Error('Cannot make screenshots without positive video duration');
  for (let index = 0; index < 9; index++) {
    const seconds = Math.max(0, duration * (0.02 + index * 0.96 / 9));
    const time = new Date(Math.floor(seconds) * 1000).toISOString().slice(11, 19).replaceAll(':', '\\:');
    await command('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-ss',
      String(seconds),
      '-i',
      video,
      '-vf',
      `scale=426:-2,drawtext=text='${time}':fontfile=static/NotoSans-Regular.ttf:fontcolor=white:fontsize=h/8:x=10:y=10:box=1:boxcolor=black@0.6:boxborderw=5`,
      '-frames:v',
      '1',
      join(dir, `shot-${index}.jpg`),
    ], signal);
  }
  const image = join(dir, 'screenshot.jpg'), thumbnail = join(dir, 'thumbnail.jpg');
  await command('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-framerate',
    '1',
    '-start_number',
    '0',
    '-i',
    join(dir, 'shot-%d.jpg'),
    '-vf',
    'tile=3x3,scale=1280:1280:force_original_aspect_ratio=decrease',
    '-frames:v',
    '1',
    image,
  ], signal);
  await command('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    image,
    '-vf',
    'scale=320:320:force_original_aspect_ratio=decrease',
    '-q:v',
    '5',
    '-frames:v',
    '1',
    thumbnail,
  ], signal);
  return { image, thumbnail };
}

export async function walkFiles(path: string): Promise<string[]> {
  const stat = await Deno.lstat(path);
  if (stat.isSymlink) throw new Error(`Refusing symbolic link in torrent content: ${path}`);
  if (stat.isFile) return [path];
  if (!stat.isDirectory) throw new Error(`Unsupported torrent content: ${path}`);
  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) files.push(...await walkFiles(join(path, entry.name)));
  return naturalSort(files);
}

export async function needArchive(path: string): Promise<boolean> {
  const stat = await Deno.stat(path);
  if (!stat.isDirectory) return stat.size > MAX_UPLOAD_SIZE;
  const entries = [];
  for await (const entry of Deno.readDir(path)) entries.push(entry);
  if (entries.length > 5) return true;
  for (const entry of entries) {
    if (
      entry.isDirectory || entry.isSymlink || !/\.(zip|rar|7z|zip\.\d{3}|7z\.\d{3})$/.test(entry.name) ||
      (await Deno.stat(join(path, entry.name))).size > MAX_UPLOAD_SIZE
    ) return true;
  }
  return false;
}
export function archiveCaption(index: number, total: number): string {
  return total === 1
    ? '这是一个由补档bot创建的压缩包，它并没有密码或分卷，下载后应该可以直接解压。\n如果解压后仍有压缩文件+密码，请检查原始帖文中是否有对应的密码。'
    : `这是一个分卷压缩包文件，共${total}个分卷，本条为第${index}个。\n请下载全部分卷并放在同一目录后使用 WinRAR 解压。\n由本程序创建的压缩文件没有密码，内部文件密码请查看原始帖文。`;
}

export class MediaProcessor {
  constructor(private store: Store, private telegram: Telegram, private runtime: Runtime) {}
  async process(torrent: Torrent, supp: Supp, record: TorrentRecord, signal: AbortSignal): Promise<void> {
    const root = resolve(torrent.content_path);
    const files = await walkFiles(root);
    const errors: unknown[] = [];
    for (const [index, video] of files.filter(isVideo).entries()) {
      signal.throwIfAborted();
      this.runtime.torrent(supp.id, record.hash, '处理视频', {
        current: basename(video),
        completed: index,
        total: files.filter(isVideo).length,
      });
      try {
        await this.video(
          video,
          (relative(root, video) || basename(video)).replaceAll('\\', '/'),
          supp,
          record,
          signal,
        );
      } catch (error) {
        if (error instanceof UncertainSendError || signal.aborted) throw error;
        errors.push(error);
      }
    }
    signal.throwIfAborted();
    try {
      await this.raw(root, files, supp, record, signal);
    } catch (error) {
      if (error instanceof UncertainSendError || signal.aborted) throw error;
      errors.push(error);
    }
    if (errors.length) throw new Error(errors.map(errorText).join('\n'));
  }
  private async video(
    path: string,
    sourcePath: string,
    supp: Supp,
    torrent: TorrentRecord,
    signal: AbortSignal,
  ): Promise<void> {
    let info = await probe(path, signal);
    let video = info.streams.find((s) => s.codec_type === 'video');
    if (!video) throw new Error(`No video stream: ${path}`);
    const audio = info.streams.find((s) => s.codec_type === 'audio');
    const copyAAC = audio?.codec_name === 'aac' && Number(audio.bit_rate) > 0;
    const audioRate = audio ? copyAAC ? Number(audio.bit_rate) : AUDIO_BITRATE : 0;
    const size = (await Deno.stat(path)).size;
    const full = size > MAX_UPLOAD_SIZE || Number(video.bit_rate) > 12_000_000;
    const convert = full || (!!audio && !copyAAC);
    const name = convert ? `${stem(path)}.mp4` : basename(path);
    const record = this.store.prepareSend(torrent.id, sourcePath, 'video', name);
    if (sendComplete(record)) return;
    if (['sending', 'uncertain'].includes(record.status)) {
      throw new UncertainSendError(`Send record #${record.id} requires reconciliation`);
    }
    const dir = await Deno.makeTempDir({ prefix: 'suppbot-video-' });
    try {
      let duration = Number(info.format.duration);
      if (!(duration > 0)) throw new Error('Missing video duration');
      if (full && estimatedSize(duration, audioRate) > MAX_UPLOAD_SIZE) {
        return this.skip(record, 'Estimated transcoded size exceeds limit');
      }
      let output = path;
      if (convert) {
        output = join(dir, name);
        this.runtime.torrent(supp.id, torrent.hash, full ? '视频转码' : '音频转换', { progress: 0 });
        await transcode(
          path,
          output,
          full,
          copyAAC,
          signal,
          (seconds) =>
            this.runtime.torrent(supp.id, torrent.hash, full ? '视频转码' : '音频转换', {
              progress: Math.min(1, seconds / duration),
            }),
        );
        if ((await Deno.stat(output)).size > MAX_UPLOAD_SIZE) {
          return this.skip(record, 'Actual transcoded size exceeds limit');
        }
        info = await probe(output, signal);
        video = info.streams.find((s) => s.codec_type === 'video');
        duration = Number(info.format.duration);
        if (!video || !(duration > 0)) throw new Error('Invalid processed video');
      }
      this.runtime.torrent(supp.id, torrent.hash, '生成视频截图');
      const shots = await screenshots(output, duration, dir, signal);
      await this.telegram.screenshot(supp, record, shots.image, name, signal);
      this.runtime.torrent(supp.id, torrent.hash, '上传视频', { progress: 1 });
      const outputAudio = info.streams.find((s) => s.codec_type === 'audio');
      const caption =
        `${name}\n视频编码: ${video.codec_name}\n分辨率: ${video.width}x${video.height}\n帧率: ${video.avg_frame_rate}\n${
          outputAudio ? `音频编码: ${outputAudio.codec_name}` : '无音频'
        }`;
      await this.telegram.video(
        record,
        output,
        shots.thumbnail,
        caption,
        video.width ?? 0,
        video.height ?? 0,
        duration,
        signal,
      );
    } catch (error) {
      this.failRecord(record, error);
      throw error;
    } finally {
      await remove(dir);
    }
  }
  private skip(record: SendRecord, reason: string): void {
    this.store.updateSend(record.id, { status: 'skipped_too_large', error: reason });
  }
  private failRecord(record: SendRecord, error: unknown): void {
    const current = this.store.one<SendRecord>('SELECT * FROM send_records WHERE id=?', record.id);
    if (current && !sendComplete(current) && !['sending', 'uncertain'].includes(current.status)) {
      this.store.updateSend(record.id, { status: 'failed', error: errorText(error) });
    }
  }
  private async raw(
    root: string,
    allFiles: string[],
    supp: Supp,
    torrent: TorrentRecord,
    signal: AbortSignal,
  ): Promise<void> {
    let dir: string | undefined;
    try {
      const pack = await needArchive(root);
      let files = allFiles.filter((path) => !isVideo(path));
      if (pack) {
        dir = await Deno.makeTempDir({ prefix: 'suppbot-archive-' });
        // Match the legacy UTF-8 byte limit so existing archive record keys remain valid.
        let name = '';
        for (const char of stem(root)) {
          if (new TextEncoder().encode(name + char).length > 55) break;
          name += char;
        }
        const archive = join(dir, `${name || 'archive'}.rar`);
        this.runtime.torrent(supp.id, torrent.hash, '准备文件或打包');
        await command('rar', ['a', '-v2000000000b', '-ep1', '-m0', '-r', '-y', archive, root], signal);
        files = [];
        for await (const entry of Deno.readDir(dir)) if (entry.isFile) files.push(join(dir, entry.name));
        naturalSort(files);
      }
      const errors: unknown[] = [];
      for (const [index, path] of files.entries()) {
        signal.throwIfAborted();
        const type = pack ? files.length > 1 ? 'split_archive' : 'archive' : 'original';
        const sourcePath = pack
          ? `archive:${basename(path)}`
          : (relative(root, path) || basename(path)).replaceAll('\\', '/');
        const record = this.store.prepareSend(torrent.id, sourcePath, type, basename(path));
        if (sendComplete(record)) continue;
        this.runtime.torrent(supp.id, torrent.hash, '上传文件', {
          current: basename(path),
          completed: index,
          total: files.length,
          progress: 1,
        });
        try {
          await this.telegram.document(
            supp,
            record,
            path,
            pack ? archiveCaption(index + 1, files.length) : '',
            signal,
          );
        } catch (error) {
          this.failRecord(record, error);
          if (error instanceof UncertainSendError || signal.aborted) throw error;
          errors.push(error);
        }
      }
      if (errors.length) throw new Error(errors.map(errorText).join('\n'));
    } finally {
      if (dir) await remove(dir);
    }
  }
}
