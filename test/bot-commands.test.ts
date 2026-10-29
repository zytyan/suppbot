import { deepEqual, equal, ok } from 'node:assert/strict';
import { Bot } from 'grammy';
import { BOT_COMMANDS, syncBotCommands } from '../src/bot-commands.ts';
import { config } from './helpers.ts';

Deno.test('Telegram command registration scopes search commands to private chats and the linked group', async () => {
  deepEqual(BOT_COMMANDS.map((command) => command.command), ['search']);
  const bot = new Bot(config.botToken), calls: { method: string; payload: unknown }[] = [];
  bot.api.config.use((prev, method, payload) => {
    calls.push({ method, payload });
    return Promise.resolve({ ok: true, result: true }) as ReturnType<typeof prev>;
  });
  await syncBotCommands(bot, config.groupId, new AbortController().signal);
  deepEqual(calls, [
    { method: 'setMyCommands', payload: { commands: BOT_COMMANDS, scope: { type: 'all_private_chats' } } },
    {
      method: 'setMyCommands',
      payload: { commands: BOT_COMMANDS, scope: { type: 'chat', chat_id: config.groupId } },
    },
    { method: 'setChatMenuButton', payload: { menu_button: { type: 'commands' } } },
  ]);
});
Deno.test('command sync retries a failed API call and completes without affecting other tasks', async () => {
  const bot = new Bot(config.botToken);
  let calls = 0, waits = 0;
  bot.api.config.use((prev) => {
    calls++;
    if (calls === 1) throw new Error('temporary network failure');
    return Promise.resolve({ ok: true, result: true }) as ReturnType<typeof prev>;
  });
  await syncBotCommands(bot, config.groupId, new AbortController().signal, (ms) => {
    waits++;
    equal(ms, 5000);
    return Promise.resolve();
  });
  equal(waits, 1);
  equal(calls, 4);
});
Deno.test('command sync honors Telegram retry_after and stops cleanly on shutdown', async () => {
  const bot = new Bot(config.botToken), shutdown = new AbortController();
  let calls = 0;
  bot.api.config.use((prev) => {
    calls++;
    return Promise.resolve({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 20 },
    }) as ReturnType<typeof prev>;
  });
  await syncBotCommands(bot, config.groupId, shutdown.signal, (ms) => {
    ok(ms >= 21000);
    shutdown.abort(new Error('shutdown'));
    return Promise.reject(shutdown.signal.reason);
  });
  equal(calls, 1);
  await syncBotCommands(bot, config.groupId, shutdown.signal);
  equal(calls, 1);
});
