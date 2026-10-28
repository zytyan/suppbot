import { equal, ok } from 'node:assert/strict';
import { SearchService } from '../src/search-service.ts';
import { Crawler } from '../src/crawler.ts';
import { Store } from '../src/store.ts';
import { article, config } from './helpers.ts';

Deno.test('search seeds known completed and failed articles, observes new pages independently of magnets', async () => {
  const legacy = new Store(':memory:'), crawler = new Crawler();
  crawler.host = () => Promise.resolve('example.test');
  const first = legacy.enqueue(article, ['abc']);
  legacy.finish(first.id);
  const second = legacy.enqueue({ ...article, url: 'https://example.test/wp/43.html' }, ['def']);
  legacy.changeStatus(second.id, 'error');
  const search = new SearchService(config, legacy, crawler);
  try {
    await search.seed();
    equal(search.status().total, 2);
    equal(search.status().pending, 2);
    search.observe({ ...article, url: 'https://example.test/wp/44.html' });
    equal(search.status().total, 3);
    equal(legacy.all('SELECT * FROM supps').length, 2);
    equal(legacy.supp(first.id).status, 'done');
    equal(legacy.supp(second.id).status, 'error');
  } finally {
    search.close();
    legacy.close();
  }
});
Deno.test('indexer fetches website body, persists it and cancels without failing or requeuing supp tasks', async () => {
  const legacy = new Store(':memory:'), crawler = new Crawler(), shutdown = new AbortController();
  legacy.enqueue(article, ['abc']);
  crawler.host = () => Promise.resolve('example.test');
  crawler.document = () => Promise.resolve({ ...article, body: '来自网页的全文搜索正文' });
  const search = new SearchService(config, legacy, crawler);
  const timer = setInterval(() => {
    if (search.status().indexed === 1) shutdown.abort();
  }, 5);
  try {
    await search.run(shutdown.signal);
    equal(search.status().indexed, 1);
    equal(search.store!.search('全文搜索').total, 1);
    equal(legacy.supp(1).status, 'pending');
  } finally {
    clearInterval(timer);
    shutdown.abort();
    search.close();
    legacy.close();
  }
});
Deno.test('missing native extension disables search while the legacy database remains usable', async () => {
  const legacy = new Store(':memory:');
  const search = new SearchService(
    { ...config, simpleExtension: '/tmp/suppbot-search-missing-library.so' },
    legacy,
    new Crawler(),
  );
  try {
    equal(search.status().ready, false);
    ok(search.status().last_error);
    await search.run(new AbortController().signal);
    const supp = legacy.enqueue(article, ['abc']);
    equal(legacy.supp(supp.id).status, 'pending');
  } finally {
    search.close();
    legacy.close();
  }
});
