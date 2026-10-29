import { dirname } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Runtime } from './runtime.ts';
import { Crawler } from './crawler.ts';
import { QbitClient } from './qbit.ts';
import { createBot, TelegramClient } from './telegram.ts';
import { MediaProcessor } from './media.ts';
import { crawlLoop, Worker } from './worker.ts';
import { adminHandler } from './admin.ts';
import { errorText } from './types.ts';
import { SearchService } from './search-service.ts';
import { syncBotCommands } from './bot-commands.ts';

// The SQLite backup API includes committed WAL content without copying a live database file.
export async function backupBeforeMigration(path: string): Promise<string | undefined> {
  try {
    Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='suppbot_jobs'")
      .get();
    if (migrated) return;
    const backup = `${path}.bak.before-deno-${Date.now()}`;
    await sqliteBackup(db, backup);
    Deno.chmodSync(backup, 0o600);
    return backup;
  } finally {
    db.close();
  }
}

export async function main(): Promise<void> {
  const config = loadConfig();
  if (Deno.args.includes('--check')) {
    const db = new DatabaseSync(config.database, { readOnly: true });
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get();
      if (integrity?.integrity_check !== 'ok') throw new Error('SQLite integrity check failed');
      console.log('Configuration and SQLite integrity OK. No migration or network requests performed.');
    } finally {
      db.close();
    }
    return;
  }
  Deno.mkdirSync(dirname(config.database), { recursive: true });
  const lock = Deno.openSync(`${config.database}.deno.lock`, {
    read: true,
    write: true,
    create: true,
    mode: 0o600,
  });
  if (!lock.tryLockSync(true)) {
    lock.close();
    throw new Error('Another Deno suppbot instance holds the database lock');
  }
  let store: Store | undefined;
  let search: SearchService | undefined;
  try {
    const backup = await backupBeforeMigration(config.database);
    if (backup) console.log(`Pre-migration database backup: ${backup}`);
    store = new Store(config.database);
    if (Deno.args.includes('--migrate-only')) {
      console.log('Database migration complete; no network requests performed.');
      return;
    }
    const runtime = new Runtime(config.concurrency),
      crawler = new Crawler(),
      qbit = new QbitClient(config.qbit);
    search = new SearchService(config, store, crawler);
    runtime.searchStatus = () => search!.status();
    const bot = createBot(config, store, search), telegram = new TelegramClient(bot, config, store);
    const media = new MediaProcessor(store, telegram, runtime),
      worker = new Worker(config, store, crawler, qbit, telegram, media, runtime);
    const controller = new AbortController();
    const listen = new URL(`http://${config.adminListen}`);
    const server = Deno.serve({
      hostname: listen.hostname.replace(/^\[|\]$/g, ''),
      port: Number(listen.port || 80),
      onListen: (address) => console.log(`suppbot admin listening on ${address.hostname}:${address.port}`),
    }, adminHandler(config, store, runtime, qbit, controller.signal));
    const shutdown = () => {
      controller.abort(new Error('Service shutting down'));
    };
    Deno.addSignalListener('SIGINT', shutdown);
    Deno.addSignalListener('SIGTERM', shutdown);
    controller.signal.addEventListener('abort', () => {
      if (bot.isRunning()) void bot.stop().catch((error) => console.error('Polling stop:', errorText(error)));
      void server.shutdown();
    }, { once: true });
    const tasks: Promise<unknown>[] = [];
    let backgroundError: unknown;
    const supervise = (task: Promise<void>): Promise<void> =>
      task.catch((error) => {
        backgroundError = error;
        shutdown();
      });
    try {
      await bot.init(controller.signal);
      console.log(`Authorized on account ${bot.botInfo.username}`);
      // Start workers only after polling is initialized. No long jobs run inside middleware.
      const polling = bot.start({
        onStart: () => {
          tasks.push(
            supervise(worker.run(controller.signal)),
            supervise(crawlLoop(config, store!, crawler, runtime, controller.signal, search)),
            search!.run(controller.signal),
            syncBotCommands(bot, config.groupId, controller.signal),
          );
        },
      });
      tasks.push(polling);
      await polling;
      if (backgroundError) throw backgroundError;
    } finally {
      shutdown();
      await Promise.allSettled(tasks);
      await server.finished;
      Deno.removeSignalListener('SIGINT', shutdown);
      Deno.removeSignalListener('SIGTERM', shutdown);
    }
  } finally {
    search?.close();
    store?.close();
    lock.unlockSync();
    lock.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(errorText(error));
    Deno.exitCode = 1;
  }
}
