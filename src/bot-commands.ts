import { Bot, GrammyError } from 'grammy';
import { errorText } from './types.ts';
import { sleep } from './util.ts';

// Handlers and Telegram's command menu share the same command definitions.
export const SEARCH_COMMANDS = [
  { command: 'search', description: '搜索网页内容（支持中文和拼音）' },
] as const;
export const BOT_COMMANDS = [...SEARCH_COMMANDS];

export async function syncBotCommands(
  bot: Bot,
  groupId: number,
  shutdown: AbortSignal,
  wait = sleep,
): Promise<void> {
  let failures = 0;
  while (!shutdown.aborted) {
    let delay = Math.min(300_000, 5000 * 2 ** Math.min(failures, 6));
    try {
      const signal = () => AbortSignal.any([shutdown, AbortSignal.timeout(20_000)]);
      await bot.api.setMyCommands(BOT_COMMANDS, { scope: { type: 'all_private_chats' } }, signal());
      await bot.api.setMyCommands(BOT_COMMANDS, { scope: { type: 'chat', chat_id: groupId } }, signal());
      await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } }, signal());
      console.log(
        `Telegram command menu synced: ${
          BOT_COMMANDS.map((command) => '/' + command.command).join(', ')
        } (private chats and linked group)`,
      );
      return;
    } catch (error) {
      if (shutdown.aborted) return;
      failures++;
      if (error instanceof GrammyError && error.error_code === 429) {
        delay = Math.max(delay, ((error.parameters.retry_after ?? 60) + 1) * 1000);
      }
      console.error('Telegram command menu sync failed; will retry:', errorText(error));
    }
    try {
      await wait(delay, shutdown);
    } catch (error) {
      if (shutdown.aborted) return;
      throw error;
    }
  }
}
