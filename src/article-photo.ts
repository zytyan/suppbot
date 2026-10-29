import { Crawler } from './crawler.ts';
import type { Article } from './types.ts';
import { errorText } from './types.ts';
import { sleep } from './util.ts';

const MAX_PHOTO_BYTES = 10_000_000;
export interface ArticlePhoto {
  bytes?: Uint8Array;
  filename: string;
  source: 'cover' | 'placeholder';
  url: string;
  attempts: number;
  reason: string;
}
interface PhotoOptions {
  fetch?: typeof fetch;
  wait?: typeof sleep;
  refresh?: () => Promise<string>;
}
function filenameFor(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'article.jpg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'article.png';
  if (new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/)) return 'article.gif';
  if (
    new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
    new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
  ) return 'article.webp';
  throw new Error('Cover response is not a supported image');
}
export async function fetchArticlePhoto(
  article: Article,
  signal: AbortSignal,
  options: PhotoOptions = {},
): Promise<ArticlePhoto> {
  signal.throwIfAborted();
  if (!article.imgUrl) {
    return {
      filename: 'no_image.png',
      source: 'placeholder',
      url: '',
      attempts: 0,
      reason: 'Article has no cover URL',
    };
  }
  const request = options.fetch ?? fetch, wait = options.wait ?? sleep;
  let attempts = 0;
  const errors: string[] = [];
  const download = async (url: string): Promise<ArticlePhoto> => {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Cover URL must use HTTP or HTTPS');
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      attempts++;
      try {
        const response = await request(url, {
          headers: { Referer: article.url, 'User-Agent': 'Mozilla/5.0 (compatible; suppbot/2.0)' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Image HTTP ${response.status}`);
        }
        if (Number(response.headers.get('content-length')) > MAX_PHOTO_BYTES) {
          await response.body?.cancel();
          throw new Error('Cover exceeds 10 MB');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Cover response has no body');
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > MAX_PHOTO_BYTES) {
              await reader.cancel();
              throw new Error('Cover exceeds 10 MB');
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return { bytes, filename: filenameFor(bytes), source: 'cover', url, attempts, reason: '' };
      } catch (error) {
        signal.throwIfAborted();
        const message = errorText(error);
        errors.push(message);
        console.warn(`Cover ${new URL(article.url).pathname} attempt ${attempts}: ${message}`);
        if (attempt < 2) await wait(attempt === 0 ? 500 : 1500, signal);
      }
    }
    throw new Error(errors.at(-1));
  };
  try {
    return await download(article.imgUrl);
  } catch (error) {
    signal.throwIfAborted();
    if (!errors.length) errors.push(errorText(error));
  }
  try {
    const fresh = await (options.refresh ?? (async () => {
      const document = await new Crawler().document(new URL(article.url).pathname, signal);
      return document.imgUrl;
    }))();
    if (fresh && fresh !== article.imgUrl) return await download(fresh);
  } catch (error) {
    signal.throwIfAborted();
    errors.push(`Refresh: ${errorText(error)}`);
  }
  throw new Error(
    `Cover download failed after ${attempts} attempts for ${new URL(article.url).pathname}: ${
      errors.join('; ')
    }`,
  );
}
