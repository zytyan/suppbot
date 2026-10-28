import type { Config } from './config.ts';
import type { Crawler } from './crawler.ts';
import type { Job, Supp, Torrent, TorrentRecord } from './types.ts';
import { errorText, hashes, VideoRejectedError } from './types.ts';
import { Store } from './store.ts';
import { Runtime } from './runtime.ts';
import { type Telegram, UncertainSendError } from './telegram.ts';
import { sleep } from './util.ts';

export interface Torrents {
  add(hashes: string[], signal: AbortSignal): Promise<void>;
  torrents(signal: AbortSignal): Promise<Torrent[]>;
}
export interface Processor {
  process(torrent: Torrent, supp: Supp, record: TorrentRecord, signal: AbortSignal): Promise<void>;
}

export class Worker {
  private active = new Map<number, Promise<void>>();
  private fatal: unknown;
  constructor(
    private config: Config,
    private store: Store,
    private crawler: Crawler,
    private qbit: Torrents,
    private telegram: Telegram,
    private media: Processor,
    private runtime: Runtime,
  ) {}
  async run(shutdown: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([shutdown, controller.signal]);
    this.store.recover();
    try {
      while (!signal.aborted) {
        if (this.fatal) throw this.fatal;
        while (!signal.aborted && this.active.size < this.config.concurrency) {
          const job = this.store.claim();
          if (!job) break;
          const promise = this.execute(job, signal).catch((error) => {
            this.fatal = error;
            controller.abort(error);
          }).finally(() => this.active.delete(job.supp_id));
          this.active.set(job.supp_id, promise);
        }
        await sleep(1000, signal);
      }
    } catch (error) {
      controller.abort(error);
      if (this.fatal) throw this.fatal;
      if (!shutdown.aborted) throw error;
    } finally {
      await Promise.allSettled(this.active.values());
    }
  }
  async execute(job: Job, shutdown: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Task deadline exceeded')),
      this.config.taskTimeoutMs,
    );
    const signal = AbortSignal.any([shutdown, controller.signal]);
    try {
      let supp = this.store.supp(job.supp_id);
      this.runtime.start(supp);
      if (!hashes(supp.magnets ?? '').length) throw new Error('Supp has no magnet hashes');
      if (!supp.channel_id) {
        this.runtime.phase(supp.id, '发送频道消息');
        const article = job.article_json
          ? JSON.parse(job.article_json)
          : await this.crawler.article(supp.article_url_path, signal);
        await this.telegram.publish(supp, article, signal);
      }
      await this.telegram.pendingMagnets?.(this.store.supp(supp.id), signal);
      this.runtime.phase(supp.id, '添加 torrent');
      await this.qbit.add(hashes(supp.magnets), signal);
      this.runtime.phase(supp.id, '等待关联群消息');
      supp = await this.waitForGroup(supp.id, signal);
      this.runtime.phase(supp.id, '处理 torrent');
      const records = this.store.torrents(supp.id);
      if (!records.length) throw new Error('Supp has no torrent records');
      // Bound heavy processing: one torrent at a time in each task worker.
      const errors: unknown[] = [];
      for (const record of records) {
        signal.throwIfAborted();
        if (record.status === 'done') continue;
        try {
          await this.processTorrent(supp, record, signal);
        } catch (error) {
          if (error instanceof UncertainSendError || error instanceof VideoRejectedError || signal.aborted) {
            throw error;
          }
          errors.push(error);
        }
      }
      if (errors.length) throw new Error(errors.map(errorText).join('\n'));
      this.store.finish(supp.id);
    } catch (error) {
      this.store.fail(
        job,
        errorText(error),
        error instanceof UncertainSendError || error instanceof VideoRejectedError
          ? job.attempts
          : this.config.maxAttempts,
        shutdown.aborted,
      );
      console.error(`Supp #${job.supp_id}:`, errorText(error));
    } finally {
      clearTimeout(timer);
      this.runtime.done(job.supp_id);
    }
  }
  private async waitForGroup(id: number, signal: AbortSignal): Promise<Supp> {
    const deadline = Date.now() + this.config.linkedMessageTimeoutMs;
    while (true) {
      signal.throwIfAborted();
      const supp = this.store.supp(id);
      if (supp.linked_group_id && supp.linked_group_chat_id) return supp;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for linked group message');
      await sleep(Math.min(1000, Math.max(1, deadline - Date.now())), signal);
    }
  }
  private async processTorrent(supp: Supp, record: TorrentRecord, signal: AbortSignal): Promise<void> {
    this.store.torrentStatus(record.id, 'processing');
    let misses = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const torrents = await this.qbit.torrents(signal);
        this.runtime.torrentCacheAt = new Date().toISOString();
        this.runtime.torrentCacheError = '';
        const torrent = torrents.find((t) =>
          [t.hash?.toLowerCase(), t.infohash_v1?.toLowerCase()].includes(record.hash.toLowerCase())
        );
        if (!torrent) {
          misses++;
          if (misses >= 20) throw new Error(`Torrent ${record.hash} missing after ${misses} checks`);
          this.runtime.torrent(supp.id, record.hash, '等待 qBittorrent', { completed: misses, total: 20 });
        } else {
          misses = 0;
          this.runtime.torrent(supp.id, record.hash, '下载', {}, torrent);
          if (torrent.progress >= 1) {
            await this.media.process(torrent, supp, record, signal);
            this.store.torrentStatus(record.id, 'done');
            this.runtime.torrent(supp.id, record.hash, '完成', { progress: 1 });
            return;
          }
        }
        await sleep(10_000, signal);
      }
    } catch (error) {
      this.store.torrentStatus(record.id, 'error', errorText(error));
      this.runtime.torrent(supp.id, record.hash, '失败', { error: errorText(error) });
      throw error;
    }
  }
}

export async function crawlLoop(
  config: Config,
  store: Store,
  crawler: Crawler,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    runtime.crawlRunning = true;
    runtime.lastCrawlStart = new Date().toISOString();
    const errors: string[] = [];
    try {
      for (const article of await crawler.articles(config.page, signal)) {
        signal.throwIfAborted();
        try {
          const existing = store.findByPath(new URL(article.url).pathname);
          if (existing && ['done', 'error'].includes(existing.status)) continue;
          const magnets = existing && hashes(existing.magnets ?? '').length
            ? hashes(existing.magnets)
            : await crawler.magnets(article.url, signal);
          if (!magnets.length) throw new Error(`No magnets: ${new URL(article.url).pathname}`);
          store.enqueue(article, magnets);
        } catch (error) {
          if (signal.aborted) break;
          errors.push(errorText(error));
        }
      }
    } catch (error) {
      if (!signal.aborted) errors.push(errorText(error));
    }
    runtime.crawlRunning = false;
    runtime.lastCrawlEnd = new Date().toISOString();
    runtime.lastCrawlError = errors.join('\n');
    runtime.nextCrawl = new Date(Date.now() + config.crawlIntervalMs).toISOString();
    if (errors.length) console.error('Crawl:', errors.join('\n'));
    try {
      await sleep(config.crawlIntervalMs, signal);
    } catch {
      if (!signal.aborted) throw new Error('Crawl timer failed');
    }
  }
}
