import { equal, ok, rejects } from 'node:assert/strict';
import { fetchArticlePhoto } from '../src/article-photo.ts';
import { article } from './helpers.ts';

const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
const noWait = () => Promise.resolve();
Deno.test('cover download retries transient failures and sends the article Referer', async () => {
  let attempts = 0;
  const image = await fetchArticlePhoto(
    { ...article, imgUrl: 'https://images.example.test/cover.jpg' },
    new AbortController().signal,
    {
      fetch: (_input, init) => {
        attempts++;
        equal(new Headers(init?.headers).get('Referer'), article.url);
        return Promise.resolve(
          attempts === 1 ? new Response('unavailable', { status: 503 }) : new Response(jpeg),
        );
      },
      wait: noWait,
    },
  );
  equal(attempts, 2);
  equal(image.source, 'cover');
  equal(image.filename, 'article.jpg');
  equal(image.attempts, 2);
  equal(image.bytes?.length, jpeg.length);
});
Deno.test('an HTML error page with HTTP 200 is rejected and a refreshed cover URL can recover', async () => {
  let attempts = 0, refreshes = 0;
  const image = await fetchArticlePhoto(
    { ...article, imgUrl: 'https://images.example.test/stale.jpg' },
    new AbortController().signal,
    {
      fetch: (url) => {
        attempts++;
        return Promise.resolve(
          String(url).endsWith('fresh.jpg')
            ? new Response(jpeg)
            : new Response('<html>Denied</html>', { headers: { 'Content-Type': 'text/html' } }),
        );
      },
      wait: noWait,
      refresh: () => {
        refreshes++;
        return Promise.resolve('https://images.example.test/fresh.jpg');
      },
    },
  );
  equal(attempts, 4);
  equal(refreshes, 1);
  equal(image.url, 'https://images.example.test/fresh.jpg');
  equal(image.source, 'cover');
});
Deno.test('a known but unavailable cover fails the task instead of silently sending a placeholder', async () => {
  let attempts = 0;
  await rejects(
    () =>
      fetchArticlePhoto(
        { ...article, imgUrl: 'https://images.example.test/cover.jpg' },
        new AbortController().signal,
        {
          fetch: () => {
            attempts++;
            return Promise.resolve(new Response('unavailable', { status: 503 }));
          },
          wait: noWait,
          refresh: () => Promise.resolve('https://images.example.test/cover.jpg'),
        },
      ),
    /Cover download failed after 3 attempts/,
  );
  equal(attempts, 3);
});
Deno.test('missing cover URL is explicitly recorded as a placeholder, and cancellation stops retries', async () => {
  const image = await fetchArticlePhoto(article, new AbortController().signal);
  equal(image.source, 'placeholder');
  ok(image.reason.includes('no cover URL'));
  const abort = new AbortController();
  let attempts = 0;
  await rejects(
    () =>
      fetchArticlePhoto({ ...article, imgUrl: 'https://images.example.test/cover.jpg' }, abort.signal, {
        fetch: () => {
          attempts++;
          abort.abort(new Error('cancelled'));
          return Promise.reject(new Error('network'));
        },
        wait: noWait,
      }),
    /cancelled/,
  );
  equal(attempts, 1);
});
