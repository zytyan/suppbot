import { equal, ok, rejects } from 'node:assert/strict';
import { Bot } from 'grammy';
import { load } from 'cheerio';
import { Store } from '../src/store.ts';
import { createBot, formatArticlePost, TelegramClient, UncertainSendError } from '../src/telegram.ts';
import { article, config } from './helpers.ts';

Deno.test('unknown send outcome is persisted and never automatically resent', async () => {
  const store = new Store(':memory:');
  try {
    const supp = store.enqueue(article, ['abc']);
    store.saveChannel(supp.id, config.channelId, 1);
    store.saveForward(config.channelId, 1, config.groupId, 2);
    const record = store.prepareSend(store.torrents(supp.id)[0]!.id, 'file.zip', 'original', 'file.zip');
    let calls = 0;
    const bot = new Bot(config.botToken);
    bot.api.config.use(() => {
      calls++;
      throw new Error('connection reset after upload');
    });
    const client = new TelegramClient(bot, config, store), signal = new AbortController().signal;
    await rejects(
      () => client.document(store.supp(supp.id), record, '/tmp/a #1.zip', '', signal),
      UncertainSendError,
    );
    const next = store.prepareSend(record.torrent_id, record.source_path, record.send_type, record.file_name);
    equal(next.status, 'uncertain');
    await rejects(
      () => client.document(store.supp(supp.id), next, '/tmp/a #1.zip', '', signal),
      UncertainSendError,
    );
    equal(calls, 1);
  } finally {
    store.close();
  }
});
Deno.test('confirmed Telegram success records IDs and safely encodes local file paths', async () => {
  const store = new Store(':memory:');
  try {
    const supp = store.enqueue(article, ['abc']);
    store.saveChannel(supp.id, config.channelId, 1);
    store.saveForward(config.channelId, 1, config.groupId, 2);
    const record = store.prepareSend(store.torrents(supp.id)[0]!.id, 'a #1.zip', 'original', 'a #1.zip');
    const bot = new Bot(config.botToken);
    bot.api.config.use((_prev, method, payload) => {
      equal(method, 'sendDocument');
      ok('document' in payload && payload.document === 'file:///tmp/a%20%231.zip');
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 55,
          date: 1,
          chat: { id: config.groupId, type: 'supergroup', title: 'group' },
          document: { file_id: 'f', file_unique_id: 'u' },
        },
      }) as ReturnType<typeof _prev>;
    });
    await new TelegramClient(bot, config, store).document(
      store.supp(supp.id),
      record,
      '/tmp/a #1.zip',
      '',
      new AbortController().signal,
    );
    const next = store.prepareSend(record.torrent_id, record.source_path, record.send_type, record.file_name);
    equal(next.status, 'success');
    equal(next.group_message_id, 55);
    equal(next.file_id, 'f');
  } finally {
    store.close();
  }
});
Deno.test('grammY update handler accepts only configured linked group and tolerates duplicate forwards', async () => {
  const store = new Store(':memory:');
  try {
    const bot = createBot(config, store);
    bot.api.config.use((_prev) =>
      Promise.resolve({
        ok: true,
        result: { id: 123, is_bot: true, first_name: 'test', username: 'test_bot' },
      }) as ReturnType<typeof _prev>
    );
    await bot.init();
    const supp = store.enqueue(article, ['abc']);
    store.saveChannel(supp.id, config.channelId, 11);
    const update = {
      update_id: 1,
      message: {
        message_id: 22,
        date: 1,
        from: { id: 777000, is_bot: false, first_name: 'Telegram' },
        is_automatic_forward: true as const,
        chat: { id: config.groupId, type: 'supergroup' as const, title: 'group' },
        forward_origin: {
          type: 'channel' as const,
          chat: { id: config.channelId, type: 'channel' as const, title: 'channel' },
          message_id: 11,
          date: 1,
        },
      },
    };
    await bot.handleUpdate(update);
    await bot.handleUpdate(update);
    equal(store.supp(supp.id).linked_group_id, 22);
    await bot.handleUpdate({
      ...update,
      update_id: 2,
      message: { ...update.message, chat: { ...update.message.chat, id: -100999 } },
    });
    equal(store.all('SELECT * FROM suppbot_forwards').length, 1);
  } finally {
    store.close();
  }
});

Deno.test('article post includes all normalized magnet links as copyable code in its photo caption', async () => {
  const store = new Store(':memory:');
  const first = 'a'.repeat(40), second = 'b'.repeat(40);
  try {
    const supp = store.enqueue({ ...article, title: 'Title <&>' }, [first.toUpperCase(), first, second]);
    const bot = new Bot(config.botToken);
    let calls = 0;
    bot.api.config.use((prev, method, payload) => {
      calls++;
      equal(method, 'sendPhoto');
      ok('caption' in payload);
      const $ = load(payload.caption!);
      equal($('code').length, 2);
      equal($('code').eq(0).text(), `magnet:?xt=urn:btih:${first}`);
      equal($('code').eq(1).text(), `magnet:?xt=urn:btih:${second}`);
      ok($.text().includes('Title <&>'));
      ok($.text().length <= 1024);
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 42,
          date: 1,
          chat: { id: config.channelId, type: 'channel', title: 'channel' },
        },
      }) as ReturnType<typeof prev>;
    });
    const client = new TelegramClient(bot, config, store), signal = new AbortController().signal;
    await client.publish(supp, { ...article, title: 'Title <&>' }, signal);
    await client.pendingMagnets(store.supp(supp.id), signal);
    await client.publish(store.supp(supp.id), article, signal);
    equal(calls, 1);
    equal(store.supp(supp.id).channel_id, 42);
  } finally {
    store.close();
  }
});

Deno.test('long magnet lists split at message limits without dropping links or breaking HTML', () => {
  const links = Array.from({ length: 80 }, (_, index) => index.toString(16).padStart(40, '0'));
  const post = formatArticlePost({ magnets: links.join(',') } as import('../src/types.ts').Supp, {
    ...article,
    title: '<标题>'.repeat(1000),
    tags: ['long'.repeat(2000)],
  });
  ok(load(post.caption).text().length <= 1024);
  ok(post.followups.length > 1);
  const actual = post.followups.flatMap((text) => {
    const $ = load(text);
    ok($.text().length <= 4096);
    return $('code').toArray().map((element) => $(element).text());
  });
  equal(actual.length, 80);
  for (const [index, link] of links.entries()) equal(actual[index], `magnet:?xt=urn:btih:${link}`);
});

Deno.test('retries only unsent magnet replies and never reposts the article photo', async () => {
  const store = new Store(':memory:');
  try {
    const links = Array.from({ length: 80 }, (_, index) => index.toString(16).padStart(40, '0'));
    const supp = store.enqueue(article, links), bot = new Bot(config.botToken);
    let photos = 0, replies = 0;
    bot.api.config.use((prev, method, payload) => {
      if (method === 'sendPhoto') {
        photos++;
        return Promise.resolve({
          ok: true,
          result: {
            message_id: 42,
            date: 1,
            chat: { id: config.channelId, type: 'channel', title: 'channel' },
          },
        }) as ReturnType<typeof prev>;
      }
      equal(method, 'sendMessage');
      ok('reply_parameters' in payload);
      equal(payload.reply_parameters?.message_id, 42);
      replies++;
      if (replies === 2) {
        return Promise.resolve({
          ok: false,
          error_code: 400,
          description: 'Bad Request: temporary test rejection',
        }) as ReturnType<typeof prev>;
      }
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 100 + replies,
          date: 1,
          chat: { id: config.channelId, type: 'channel', title: 'channel' },
        },
      }) as ReturnType<typeof prev>;
    });
    const client = new TelegramClient(bot, config, store), signal = new AbortController().signal;
    await client.publish(supp, article, signal);
    await rejects(() => client.pendingMagnets(store.supp(supp.id), signal), /Bad Request/);
    await client.publish(store.supp(supp.id), article, signal);
    await client.pendingMagnets(store.supp(supp.id), signal);
    await client.pendingMagnets(store.supp(supp.id), signal);
    equal(photos, 1);
    equal(replies, 3);
  } finally {
    store.close();
  }
});
