import type { Config } from '../src/config.ts';
import type { Article } from '../src/types.ts';

export const article: Article = {
  url: 'https://example.test/wp/42.html',
  title: '测试资源',
  author: 'author',
  postTime: '2026-10-28',
  imgUrl: '',
  category: 'test',
  tags: ['tag'],
};
export const config: Config = {
  botToken: '123:fake',
  apiRoot: 'http://127.0.0.1:1',
  database: ':memory:',
  searchDatabase: ':memory:',
  simpleExtension: new URL('../lib/libsimple.so', import.meta.url).pathname,
  channelId: -100123,
  groupId: -100456,
  videoChannelId: -100789,
  qbit: { host: 'http://127.0.0.1:1', username: 'test', password: 'test' },
  page: 1,
  concurrency: 2,
  crawlIntervalMs: 7200000,
  taskTimeoutMs: 5000,
  linkedMessageTimeoutMs: 20,
  maxAttempts: 3,
  adminListen: '127.0.0.1:0',
  adminBasePath: '/suppbot',
};
