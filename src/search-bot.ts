import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import type { Config } from './config.ts';
import { errorText, escapeHTML as e } from './types.ts';
import { Store } from './store.ts';
import type { SearchService } from './search-service.ts';
import type { SearchPage } from './search-store.ts';
import { SEARCH_COMMANDS } from './bot-commands.ts';

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
export function renderSearchResults(query: string, result: SearchPage, store: Store): string {
  const heading = `搜索：${e(query)}\n共 ${result.total} 条 · 第 ${result.page}/${result.pages} 页`;
  const rows = result.hits.map((hit, index) => {
    const supp = store.findByPath(hit.path);
    const links: string[] = [];
    if (supp) {
      const channel = store.telegramURL(supp.channel_chat_id, supp.channel_id),
        group = store.telegramURL(supp.linked_group_chat_id, supp.linked_group_id);
      if (channel) links.push(`<a href="${e(channel)}">补档频道帖</a>`);
      if (group) links.push(`<a href="${e(group)}">关联群消息</a>`);
    }
    return `${(result.page - 1) * 5 + index + 1}. <a href="${e(hit.url)}">${e(clip(hit.title, 160))}</a>\n${
      e(clip(hit.excerpt, 120))
    }\n${links.join(' · ') || '尚无补档消息'}`;
  });
  return heading + '\n\n' + (rows.join('\n\n') || '没有找到匹配的网页内容。');
}
function buttons(id: string, result: SearchPage): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (result.page > 1) keyboard.text('上一页', `ss:${id}:${result.page - 1}`);
  if (result.page < result.pages) keyboard.text('下一页', `ss:${id}:${result.page + 1}`);
  return keyboard;
}
export function registerSearch(bot: Bot, config: Config, legacy: Store, search: SearchService): void {
  const allowed = (chat: { id: number; type: string } | undefined) =>
    chat?.type === 'private' || chat?.id === config.groupId;
  bot.command(SEARCH_COMMANDS.map((command) => command.command), async (ctx) => {
    if (!allowed(ctx.chat) || !ctx.from) return;
    const query = ctx.match.trim();
    if (!query) {
      await ctx.reply('用法：/serarch 关键词\n也支持 /search 关键词。');
      return;
    }
    if (query.length > 200) {
      await ctx.reply('关键词过长，请限制在 200 个字符以内。');
      return;
    }
    const status = search.status(), index = search.store;
    if (!status.ready || !index) {
      await ctx.reply('搜索暂时不可用，请稍后重试。');
      return;
    }
    if (!status.indexed) {
      await ctx.reply(`网页索引准备中，已收录 0/${status.total} 篇，请稍后重试。`);
      return;
    }
    try {
      const result = index.search(query), session = index.createSession(query, ctx.from.id, ctx.chat.id);
      let text = renderSearchResults(query, result, legacy);
      if (status.pending) text += `\n\n网页索引进行中：已收录 ${status.indexed}/${status.total} 篇。`;
      await ctx.reply(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: buttons(session.id, result),
      });
    } catch (error) {
      console.error('Search query failed:', errorText(error));
      await ctx.reply('搜索失败，请稍后重试或换一组关键词。');
    }
  });
  bot.callbackQuery(/^ss:([a-f0-9]{24}):(\d+)$/, async (ctx) => {
    if (!allowed(ctx.chat)) {
      await ctx.answerCallbackQuery({ text: '此聊天不支持搜索。' });
      return;
    }
    const index = search.store;
    if (!search.status().ready || !index) {
      await ctx.answerCallbackQuery({ text: '搜索暂时不可用，请稍后重试。' });
      return;
    }
    const session = index.session(ctx.match[1]!);
    if (!session) {
      await ctx.answerCallbackQuery({ text: '搜索已过期，请重新使用 /serarch 搜索。' });
      return;
    }
    if (session.owner_id !== ctx.from.id || session.chat_id !== ctx.chat!.id) {
      await ctx.answerCallbackQuery({ text: '请使用 /serarch 发起自己的搜索。', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      const result = index.search(session.query, Number(ctx.match[2]));
      await ctx.editMessageText(renderSearchResults(session.query, result, legacy), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: buttons(session.id, result),
      });
    } catch (error) {
      if (
        error instanceof GrammyError && error.description.toLowerCase().includes('message is not modified')
      ) return;
      console.error('Search pagination failed:', errorText(error));
      await ctx.reply('翻页失败，请重新使用 /serarch 搜索。');
    }
  });
}
