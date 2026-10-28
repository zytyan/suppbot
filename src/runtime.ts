import type { Supp, Torrent } from './types.ts';

interface LiveTorrent {
  hash: string;
  phase: string;
  progress: number;
  updated_at: string;
  name?: string;
  state?: string;
  downloaded?: number;
  total_size?: number;
  speed?: number;
  eta?: number;
  seeds?: number;
  current?: string;
  completed?: number;
  total?: number;
  retry?: number;
  error?: string;
}
interface LiveSupp {
  id: number;
  article_url_path: string;
  phase: string;
  started_at: string;
  updated_at: string;
  torrents: LiveTorrent[];
}
export class Runtime {
  private startedAt = new Date().toISOString();
  private running = new Map<number, LiveSupp>();
  crawlRunning = false;
  lastCrawlStart?: string;
  lastCrawlEnd?: string;
  nextCrawl?: string;
  lastCrawlError = '';
  torrentCacheAt?: string;
  torrentCacheError = '';
  constructor(readonly concurrency: number) {}
  active(id: number): boolean {
    return this.running.has(id);
  }
  start(supp: Supp): void {
    const time = new Date().toISOString();
    this.running.set(supp.id, {
      id: supp.id,
      article_url_path: supp.article_url_path,
      phase: '准备补档',
      started_at: time,
      updated_at: time,
      torrents: [],
    });
  }
  phase(id: number, phase: string): void {
    const supp = this.running.get(id);
    if (supp) {
      supp.phase = phase;
      supp.updated_at = new Date().toISOString();
    }
  }
  torrent(
    id: number,
    hash: string,
    phase: string,
    patch: Partial<LiveTorrent> = {},
    torrent?: Torrent,
  ): void {
    const supp = this.running.get(id);
    if (!supp) return;
    let live = supp.torrents.find((t) => t.hash === hash);
    if (!live) {
      live = { hash, phase, progress: 0, updated_at: new Date().toISOString() };
      supp.torrents.push(live);
    }
    Object.assign(live, { phase, updated_at: new Date().toISOString() }, patch);
    if (torrent) {
      Object.assign(live, {
        name: torrent.name,
        progress: torrent.progress,
        state: torrent.state,
        downloaded: torrent.downloaded,
        total_size: torrent.total_size,
        speed: torrent.dlspeed,
        eta: torrent.eta,
        seeds: torrent.num_seeds,
      });
    }
    supp.updated_at = live.updated_at;
  }
  done(id: number): void {
    this.running.delete(id);
  }
  snapshot() {
    return {
      started_at: this.startedAt,
      max_concurrent: this.concurrency,
      running: structuredClone([...this.running.values()]),
      crawl_running: this.crawlRunning,
      last_crawl_start: this.lastCrawlStart,
      last_crawl_end: this.lastCrawlEnd,
      next_crawl: this.nextCrawl,
      last_crawl_error: this.lastCrawlError,
      torrent_cache_at: this.torrentCacheAt,
      torrent_cache_error: this.torrentCacheError,
    };
  }
}
