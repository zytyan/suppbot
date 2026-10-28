import { equal, ok } from 'node:assert/strict';
import type { Bot } from 'grammy';
import { createBot } from '../src/telegram.ts';
import { Store } from '../src/store.ts';
import { SearchService } from '../src/search-service.ts';
import { Crawler } from '../src/crawler.ts';
import { article, config } from './helpers.ts';

type Update = Parameters<Bot['handleUpdate']>[0];
const user = (id: number) => ({ id, is_bot: false, first_name: 'user' });
const chat = (id: number) =>
  id < 0
    ? { id, type: 'supergroup' as const, title: 'group' }
    : { id, type: 'private' as const, first_name: 'user' };
const command = (text: string, chatId = 1, owner = 1): Update => ({
  update_id: 1,
  message: {
    message_id: 1,
    date: 1,
    from: user(owner),
    chat: chat(chatId),
    text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
  },
});
const callback = (data: string, chatId = 1, owner = 1): Update => ({
  update_id: 2,
  callback_query: {
    id: 'callback',
    from: user(owner),
    chat_instance: 'test',
    data,
    message: { message_id: 50, date: 1, chat: chat(chatId), text: 'results' },
  },
});
async function setup(count = 6) {
  const legacy = new Store(':memory:'), search = new SearchService(config, legacy, new Crawler());
  for (let id = 1; id <= count; id++) {
    const path = `/wp/${id}.html`, url = `https://example.test${path}`;
    search.store!.enqueue(path, url);
    search.store!.save(path, {
      ...article,
      url,
      title: `网页 <${id}>`,
      postTime: id === 1 ? '2026-10-29' : '2026-10-28',
      body: '正文中的唯一关键词，支持搜索。',
    });
  }
  const supp = legacy.enqueue({ ...article, url: 'https://example.test/wp/1.html' }, ['abc']);
  legacy.saveChannel(supp.id, config.channelId, 11);
  legacy.saveForward(config.channelId, 11, config.groupId, 22);
  const bot = createBot(config, legacy, search),
    calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use((prev, method, payload) => {
    if (method === 'getMe') {
      return Promise.resolve({
        ok: true,
        result: { id: 123, is_bot: true, first_name: 'test', username: 'search_test_bot' },
      }) as ReturnType<typeof prev>;
    }
    calls.push({ method, payload: payload as unknown as Record<string, unknown> });
    const result = method === 'answerCallbackQuery' ? true : {
      message_id: 50,
      date: 1,
      chat: chat('chat_id' in payload ? Number(payload.chat_id) : 1),
      text: 'text' in payload ? payload.text : 'result',
    };
    return Promise.resolve({ ok: true, result }) as ReturnType<typeof prev>;
  });
  await bot.init();
  return {
    legacy,
    search,
    bot,
    calls,
    close: () => {
      search.close();
      legacy.close();
    },
  };
}
Deno.test('serarch searches webpage body and returns escaped results, supp links and five-result pagination', async () => {
  const t = await setup();
  try {
    await t.bot.handleUpdate(command('/serarch 唯一关键词'));
    equal(t.calls.length, 1);
    equal(t.calls[0]!.method, 'sendMessage');
    const payload = t.calls[0]!.payload, text = String(payload.text);
    ok(text.includes('共 6 条'));
    ok(text.includes('1/2'));
    ok(text.includes('&lt;1&gt;'));
    ok(text.includes('https://t.me/c/123/11'));
    ok(text.includes('https://t.me/c/456/22'));
    equal((text.match(/网页 &lt;/g) || []).length, 5);
    equal(payload.parse_mode, 'HTML');
    const markup = payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    const data = markup.inline_keyboard[0]![0]!.callback_data;
    ok(data.length <= 64);
    await t.bot.handleUpdate(callback(data));
    equal(t.calls[1]!.method, 'answerCallbackQuery');
    equal(t.calls[2]!.method, 'editMessageText');
    ok(String(t.calls[2]!.payload.text).includes('2/2'));
    const before = t.calls.length;
    await t.bot.handleUpdate(callback(data, 1, 2));
    equal(t.calls.length, before + 1);
    equal(t.calls.at(-1)!.method, 'answerCallbackQuery');
    equal(t.calls.at(-1)!.payload.show_alert, true);
  } finally {
    t.close();
  }
});
Deno.test('search alias works in private chats and the linked group but ignores other groups', async () => {
  const t = await setup();
  try {
    await t.bot.handleUpdate(command('/search@search_test_bot 唯一关键词', config.groupId));
    equal(t.calls.length, 1);
    equal(t.calls[0]!.payload.chat_id, config.groupId);
    await t.bot.handleUpdate(command('/serarch 唯一关键词', -100999));
    equal(t.calls.length, 1);
    await t.bot.handleUpdate(command('/search 不存在的词', 9, 9));
    ok(String(t.calls.at(-1)!.payload.text).includes('没有找到'));
    await t.bot.handleUpdate(command('/serarch'));
    ok(String(t.calls.at(-1)!.payload.text).includes('用法'));
    await t.bot.handleUpdate(command('/serarch ' + '长'.repeat(201)));
    ok(String(t.calls.at(-1)!.payload.text).includes('200'));
  } finally {
    t.close();
  }
});
Deno.test('pagination sessions reject a different chat or expired token without changing messages', async () => {
  const t = await setup();
  try {
    const session = t.search.store!.createSession('关键词', 1, 1);
    await t.bot.handleUpdate(callback(`ss:${session.id}:2`, config.groupId));
    equal(t.calls.length, 1);
    equal(t.calls[0]!.method, 'answerCallbackQuery');
    equal(t.calls[0]!.payload.show_alert, true);
    const expired = t.search.store!.createSession('关键词', 1, 1, Date.now() - 31 * 60_000);
    await t.bot.handleUpdate(callback(`ss:${expired.id}:2`));
    equal(t.calls.length, 2);
    ok(String(t.calls[1]!.payload.text).includes('过期'));
  } finally {
    t.close();
  }
});
Deno.test('preparing and unavailable indexes return friendly messages', async () => {
  const t = await setup(0);
  try {
    t.search.observe(article);
    await t.bot.handleUpdate(command('/serarch 关键词'));
    ok(String(t.calls.at(-1)!.payload.text).includes('索引准备中'));
    t.search.close();
    await t.bot.handleUpdate(command('/serarch 关键词'));
    ok(String(t.calls.at(-1)!.payload.text).includes('暂时不可用'));
  } finally {
    t.close();
  }
});
Deno.test('a full page of long titles and bodies stays within Telegram message limits', async () => {
  const t = await setup(0);
  try {
    for (let id = 1; id <= 6; id++) {
      const path = `/wp/${id}.html`;
      t.search.store!.enqueue(path, `https://example.test${path}`);
      t.search.store!.save(path, {
        ...article,
        url: `https://example.test${path}`,
        title: '很长的标题<&>'.repeat(1000),
        body: '正文关键词'.repeat(1000),
      });
    }
    await t.bot.handleUpdate(command('/serarch 关键词'));
    const { load } = await import('cheerio');
    ok(load(String(t.calls[0]!.payload.text)).text().length <= 4096);
  } finally {
    t.close();
  }
});
Deno.test('search middleware preserves automatic-forward binding', async () => {
  const t = await setup();
  try {
    const supp = t.legacy.enqueue({ ...article, url: 'https://example.test/wp/99.html' }, ['def']);
    t.legacy.saveChannel(supp.id, config.channelId, 99);
    await t.bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 100,
        date: 1,
        from: user(777000),
        chat: { id: config.groupId, type: 'supergroup', title: 'group' },
        is_automatic_forward: true,
        forward_origin: {
          type: 'channel',
          chat: { id: config.channelId, type: 'channel', title: 'channel' },
          message_id: 99,
          date: 1,
        },
      },
    });
    equal(t.legacy.supp(supp.id).linked_group_id, 100);
    equal(t.calls.length, 0);
  } finally {
    t.close();
  }
});
