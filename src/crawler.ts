import { load } from 'cheerio';
import type { Article } from './types.ts';

export function parseArticles(html: string, baseURL: string): Article[] {
  const $ = load(html);
  return $('article').toArray().flatMap((element) => {
    const item = $(element), heading = item.find('h1 > a').first(), href = heading.attr('href');
    if (!href) return [];
    const image = item.find('img').first().attr('src');
    return [{
      url: new URL(href, baseURL).href,
      title: heading.text().trim(),
      author: item.find('span.author.vcard').text().trim(),
      postTime: item.find('time').text().trim(),
      imgUrl: image ? new URL(image, baseURL).href : '',
      category: item.find('span.cat-links > a').text().trim(),
      tags: item.find('span.tag-links > a').toArray().map((tag) => $(tag).text().trim()),
    }];
  });
}

export function parseMagnets(html: string): string[] {
  const $ = load(html);
  $('script,style,head,iframe,noscript').remove();
  const text = $('body').text();
  // Keep the legacy 40-character extraction, including the boundary rules, for compatibility.
  return [
    ...new Set(
      [...text.matchAll(/(?<![a-fA-F0-9])[a-zA-Z0-9]{40}(?![a-fA-F0-9])/g)].map((m) => m[0].toLowerCase()),
    ),
  ];
}

export class Crawler {
  async host(): Promise<string> {
    try {
      return (await Deno.readTextFile('liuli.link')).trim() || 'www.hacg.mov';
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      return 'www.hacg.mov';
    }
  }
  async html(url: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    if (!response.ok) throw new Error(`Crawler HTTP ${response.status}`);
    return response.text();
  }
  async articles(page: number, signal: AbortSignal): Promise<Article[]> {
    const url = `https://${await this.host()}/wp/${page <= 1 ? '' : `page/${page}/`}`;
    return parseArticles(await this.html(url, signal), url);
  }
  async article(path: string, signal: AbortSignal): Promise<Article> {
    const url = `https://${await this.host()}${path}`;
    const article = parseArticles(await this.html(url, signal), url)[0];
    if (!article) throw new Error(`Cannot recover article ${path}`);
    return article;
  }
  async magnets(url: string, signal: AbortSignal): Promise<string[]> {
    return parseMagnets(await this.html(url, signal));
  }
}
