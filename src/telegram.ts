import { pathToFileURL } from 'node:url';
import { Bot, GrammyError, InputFile } from 'grammy';
import type { Config } from './config.ts';
import type { Article, SendRecord, Supp } from './types.ts';
import { errorText, escapeHTML } from './types.ts';
import { Store } from './store.ts';
import { sleep } from './util.ts';

export class UncertainSendError extends Error {}

export interface Telegram {
  publish(supp: Supp, article: Article, signal: AbortSignal): Promise<void>;
  document(supp: Supp, record: SendRecord, path: string, caption: string, signal: AbortSignal): Promise<void>;
  screenshot(supp: Supp, record: SendRecord, path: string, name: string, signal: AbortSignal): Promise<void>;
  video(
    record: SendRecord,
    path: string,
    thumbnail: string,
    caption: string,
    width: number,
    height: number,
    duration: number,
    signal: AbortSignal,
  ): Promise<void>;
}

export function createBot(config: Config, store: Store): Bot {
  const bot = new Bot(config.botToken, { client: { apiRoot: config.apiRoot, timeoutSeconds: 7200 } });
  bot.on('message', (ctx) => {
    const message = ctx.message;
    const origin = message.forward_origin;
    if (
      !message.is_automatic_forward || origin?.type !== 'channel' || origin.chat.id !== config.channelId ||
      message.chat.id !== config.groupId
    ) return;
    store.chat(origin.chat);
    store.chat(message.chat);
    store.saveForward(origin.chat.id, origin.message_id, message.chat.id, message.message_id);
  });
  bot.catch((error) => console.error('Telegram update failed:', errorText(error.error)));
  return bot;
}

export class TelegramClient implements Telegram {
  constructor(private bot: Bot, private config: Config, private store: Store) {}
  // A 429 is an explicit rejection and can be retried. Transport errors after a send are ambiguous.
  private async send<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0;; attempt++) {
      signal.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 429 && attempt < 4) {
          await sleep(((error.parameters.retry_after ?? 60) + 1) * 1000, signal);
          continue;
        }
        throw error;
      }
    }
  }
  private markError(record: SendRecord, error: unknown): never {
    const uncertain = !(error instanceof GrammyError) || error.error_code >= 500;
    this.store.updateSend(record.id, { status: uncertain ? 'uncertain' : 'failed', error: errorText(error) });
    if (uncertain) {
      throw new UncertainSendError(
        `Telegram send outcome unknown; reconcile record #${record.id} before retrying: ${errorText(error)}`,
      );
    }
    throw error;
  }
  private guard(record: SendRecord): void {
    if (['sending', 'uncertain'].includes(record.status)) {
      throw new UncertainSendError(
        `Send record #${record.id} requires reconciliation; automatic resend prevented`,
      );
    }
    this.store.updateSend(record.id, { status: 'sending', error: '' });
  }
  async publish(supp: Supp, article: Article, signal: AbortSignal): Promise<void> {
    if (supp.channel_id) return;
    const key = `channel-send:${supp.id}`;
    if (['sending', 'uncertain'].includes(this.store.meta(key) ?? '')) {
      throw new UncertainSendError(`Channel post for supp #${supp.id} requires reconciliation`);
    }
    const text = `<a href="${escapeHTML(article.url)}">${escapeHTML(article.title)}</a>\n由 ${
      escapeHTML(article.author)
    } 发表于 ${escapeHTML(article.postTime)}\n分类：${escapeHTML(article.category)}\n标签：${
      escapeHTML(article.tags.map((t) => '#' + t).join(' '))
    }\n#wp${new URL(article.url).pathname.split('/').pop()?.split('.')[0] ?? ''}`;
    // Download before marking the remote side effect as in flight.
    let photo = new InputFile('no_image.png');
    if (article.imgUrl) {
      try {
        const response = await fetch(article.imgUrl, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        });
        if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
        const image = new Uint8Array(await response.arrayBuffer());
        photo = new InputFile(image, 'article.jpg');
      } catch {
        signal.throwIfAborted();
      }
    }
    this.store.setMeta(key, 'sending');
    let message;
    try {
      message = await this.send(
        () =>
          this.bot.api.sendPhoto(this.config.channelId, photo, { caption: text, parse_mode: 'HTML' }, signal),
        signal,
      );
    } catch (error) {
      const uncertain = !(error instanceof GrammyError) || error.error_code >= 500;
      this.store.setMeta(key, uncertain ? 'uncertain' : 'failed');
      if (uncertain) throw new UncertainSendError(`Channel post outcome unknown for supp #${supp.id}`);
      throw error;
    }
    this.store.transaction(() => {
      this.store.saveChannel(supp.id, message.chat.id, message.message_id);
      this.store.setMeta(key, 'sent');
    });
    this.store.chat(message.chat);
  }
  async document(
    supp: Supp,
    record: SendRecord,
    path: string,
    caption: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.guard(record);
    let message;
    try {
      message = await this.send(() =>
        this.bot.api.sendDocument(supp.linked_group_chat_id, this.local(path), {
          caption,
          reply_parameters: { message_id: supp.linked_group_id, allow_sending_without_reply: false },
        }, signal), signal);
    } catch (error) {
      this.markError(record, error);
    }
    if (!message.document) {
      this.store.updateSend(record.id, { status: 'uncertain', error: 'Response has no document' });
      throw new UncertainSendError('Telegram response has no document');
    }
    this.store.updateSend(record.id, {
      status: 'success',
      error: '',
      file_id: message.document.file_id,
      file_unique_id: message.document.file_unique_id,
      group_chat_id: message.chat.id,
      group_message_id: message.message_id,
    });
    this.store.chat(message.chat);
  }
  async screenshot(
    supp: Supp,
    record: SendRecord,
    path: string,
    name: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (record.group_message_id) return;
    signal.throwIfAborted();
    this.guard(record);
    let message;
    try {
      message = await this.send(
        () =>
          this.bot.api.sendPhoto(supp.linked_group_chat_id, this.local(path), {
            caption: name,
            has_spoiler: true,
            reply_parameters: { message_id: supp.linked_group_id },
          }, signal),
        signal,
      );
    } catch (error) {
      this.markError(record, error);
    }
    this.store.updateSend(record.id, {
      status: 'pending',
      group_chat_id: message.chat.id,
      group_message_id: message.message_id,
    });
    record.group_chat_id = message.chat.id;
    record.group_message_id = message.message_id;
    record.status = 'pending';
    this.store.chat(message.chat);
  }
  async video(
    record: SendRecord,
    path: string,
    thumbnail: string,
    caption: string,
    width: number,
    height: number,
    duration: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.guard(record);
    let message;
    try {
      message = await this.send(() =>
        this.bot.api.sendVideo(this.config.videoChannelId, this.local(path), {
          caption,
          thumbnail: new InputFile(thumbnail),
          has_spoiler: true,
          supports_streaming: true,
          width,
          height,
          duration: Math.floor(duration),
          reply_parameters: { chat_id: record.group_chat_id, message_id: record.group_message_id },
        }, signal), signal);
    } catch (error) {
      this.markError(record, error);
    }
    if (!message.video) {
      this.store.updateSend(record.id, { status: 'uncertain', error: 'Response has no video' });
      throw new UncertainSendError('Telegram response has no video');
    }
    this.store.updateSend(record.id, {
      status: 'success',
      error: '',
      file_id: message.video.file_id,
      file_unique_id: message.video.file_unique_id,
      channel_chat_id: message.chat.id,
      channel_message_id: message.message_id,
    });
    this.store.chat(message.chat);
    try {
      const link = this.store.telegramURL(message.chat.id, message.message_id);
      await this.bot.api.editMessageCaption(record.group_chat_id, record.group_message_id, {
        caption: `<a href="${escapeHTML(link)}">${escapeHTML(caption.split('\n')[0])}</a>`,
        parse_mode: 'HTML',
      }, signal);
    } catch (error) {
      console.error('Video link caption update failed:', errorText(error));
    }
  }
  private local(path: string): string {
    return pathToFileURL(path).href;
  }
}
