import { dirname } from 'node:path';
import type { Config } from './config.ts';
import type { Article } from './types.ts';
import { errorText } from './types.ts';
import { Crawler } from './crawler.ts';
import { Store } from './store.ts';
import { type SearchStatus, SearchStore } from './search-store.ts';
import { sleep } from './util.ts';

export class SearchService {
  store?: SearchStore;
  private error = '';
  constructor(private config: Config, private legacy: Store, private crawler: Crawler) {
    try {
      if (config.searchDatabase !== ':memory:') {
        Deno.mkdirSync(dirname(config.searchDatabase), { recursive: true });
      }
      this.store = new SearchStore(config.searchDatabase, config.simpleExtension);
    } catch (error) {
      this.unavailable(error);
    }
  }
  private unavailable(error: unknown): void {
    this.error = errorText(error);
    console.error('Search unavailable:', this.error);
    this.store?.close();
    this.store = undefined;
  }
  status(): SearchStatus {
    if (this.store) {
      try {
        return this.store.status();
      } catch (error) {
        this.unavailable(error);
      }
    }
    return {
      ready: false,
      total: 0,
      indexed: 0,
      pending: 0,
      failed: 0,
      last_indexed_at: null,
      last_error: this.error,
    };
  }
  close(): void {
    this.store?.close();
    this.store = undefined;
  }
  observe(article: Article): void {
    if (!this.store) return;
    try {
      this.store.enqueue(new URL(article.url).pathname, article.url, 1);
    } catch (error) {
      this.unavailable(error);
    }
  }
  async seed(): Promise<void> {
    const store = this.store;
    if (!store) return;
    const host = await this.crawler.host();
    const paths = this.legacy.all<{ article_url_path: string }>(
      "SELECT DISTINCT article_url_path FROM supps WHERE deleted_at IS NULL AND article_url_path LIKE '/wp/%'",
    );
    store.transaction(() => {
      for (const row of paths) {
        store.enqueue(row.article_url_path, `https://${host}${row.article_url_path}`, 0);
      }
    });
  }
  async run(signal: AbortSignal): Promise<void> {
    if (!this.store) return;
    try {
      await this.seed();
      while (!signal.aborted && this.store) {
        const store = this.store, document = store.due();
        if (!document) {
          await sleep(5000, signal);
          continue;
        }
        try {
          const article = await this.crawler.document(document.path, signal);
          signal.throwIfAborted();
          store.save(document.path, article);
        } catch (error) {
          if (signal.aborted) break;
          store.fail(document.path, errorText(error));
          console.error(`Search indexing ${document.path}:`, errorText(error));
        }
        await sleep(2000, signal);
      }
    } catch (error) {
      if (!signal.aborted) this.unavailable(error);
    }
  }
}
