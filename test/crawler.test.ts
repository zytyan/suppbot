import { deepEqual, equal, ok } from 'node:assert/strict';
import { parseArticles, parseMagnets } from '../src/crawler.ts';

Deno.test('parses original crawler fixture and article metadata', async () => {
  const html = await Deno.readTextFile(new URL('./fixtures/articles.html', import.meta.url));
  const articles = parseArticles(html, 'https://example.test/wp/');
  ok(articles.length > 0);
  ok(articles[0]!.title);
  ok(articles[0]!.url.startsWith('http'));
});
Deno.test('extracts visible hashes, normalizes duplicates, rejects invisible scripts and longer hex values', () => {
  const hash = 'abcdef0123456789'.repeat(2) + 'abcdef01';
  deepEqual(
    parseMagnets(
      `<html><body>${hash} ${hash.toUpperCase()} <script>${'b'.repeat(40)}</script><style>${
        'c'.repeat(40)
      }</style> ${'a'.repeat(41)}</body></html>`,
    ),
    [hash],
  );
});
Deno.test('resolves relative article links and image URLs', () => {
  const [article] = parseArticles(
    '<article><h1><a href="42.html">Title &amp; more</a></h1><img src="/cover.jpg"><span class="tag-links"><a>测试</a></span></article>',
    'https://example.test/wp/',
  );
  equal(article!.url, 'https://example.test/wp/42.html');
  equal(article!.imgUrl, 'https://example.test/cover.jpg');
  deepEqual(article!.tags, ['测试']);
});
