import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Article, Job, SendRecord, Supp, TorrentRecord } from './types.ts';
import { hashes } from './types.ts';

const stamp = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.migrate();
  }
  close(): void {
    this.db.close();
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }
  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private migrate(): void {
    // Keep GORM table and column names so historical IDs and de-duplication keys survive.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS supps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at DATETIME, updated_at DATETIME, deleted_at DATETIME,
        article_url_path TEXT, channel_chat_id INTEGER DEFAULT 0, channel_id INTEGER DEFAULT 0,
        linked_group_chat_id INTEGER DEFAULT 0, linked_group_id INTEGER DEFAULT 0, magnets TEXT, status TEXT);
      CREATE TABLE IF NOT EXISTS supp_torrents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at DATETIME, updated_at DATETIME, deleted_at DATETIME,
        supp_id INTEGER, hash TEXT, status TEXT, error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_supp_torrent ON supp_torrents(supp_id, hash);
      CREATE TABLE IF NOT EXISTS send_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at DATETIME, updated_at DATETIME, deleted_at DATETIME,
        torrent_id INTEGER, source_path TEXT, send_type TEXT, file_name TEXT, status TEXT, error TEXT,
        file_id TEXT, file_unique_id TEXT, channel_chat_id INTEGER DEFAULT 0, channel_message_id INTEGER DEFAULT 0,
        group_chat_id INTEGER DEFAULT 0, group_message_id INTEGER DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_send_record_key ON send_records(torrent_id,source_path,send_type,file_name);
      CREATE TABLE IF NOT EXISTS chat_identities (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at DATETIME, updated_at DATETIME, deleted_at DATETIME,
        chat_id INTEGER NOT NULL UNIQUE, username TEXT, title TEXT, type TEXT);
      CREATE TABLE IF NOT EXISTS suppbot_jobs (
        supp_id INTEGER PRIMARY KEY, article_json TEXT, state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS idx_jobs_available ON suppbot_jobs(state,available_at);
      CREATE TABLE IF NOT EXISTS suppbot_forwards (
        channel_chat_id INTEGER, channel_id INTEGER, group_chat_id INTEGER, group_id INTEGER,
        PRIMARY KEY(channel_chat_id,channel_id));
      CREATE TABLE IF NOT EXISTS suppbot_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.transaction(() => {
      for (const supp of this.all<Supp>('SELECT * FROM supps WHERE deleted_at IS NULL')) {
        this.ensureTorrents(supp);
        // Existing failures remain visible until explicitly retried; running work is recovered at startup.
        if (supp.status === 'running' || supp.status === 'pending') {
          this.run("INSERT OR IGNORE INTO suppbot_jobs(supp_id,state) VALUES (?,'queued')", supp.id);
        }
      }
    });
  }
  supp(id: number): Supp {
    const value = this.one<Supp>('SELECT * FROM supps WHERE id=? AND deleted_at IS NULL', id);
    if (!value) throw new Error(`Supp ${id} not found`);
    return value;
  }
  findByPath(path: string): Supp | undefined {
    return this.one<Supp>(
      'SELECT * FROM supps WHERE article_url_path=? AND deleted_at IS NULL ORDER BY id LIMIT 1',
      path,
    );
  }
  enqueue(article: Article, magnets: string[]): Supp {
    return this.transaction(() => {
      const path = new URL(article.url).pathname;
      let supp = this.findByPath(path);
      if (!supp) {
        const time = stamp();
        const id = this.run(
          "INSERT INTO supps(created_at,updated_at,article_url_path,magnets,status) VALUES (?,?,?,?,'pending')",
          time,
          time,
          path,
          hashes(magnets.join(',')).join(','),
        ).lastInsertRowid;
        supp = this.supp(Number(id));
      } else if (!hashes(supp.magnets ?? '').length && magnets.length) {
        this.run(
          'UPDATE supps SET magnets=?,updated_at=? WHERE id=?',
          hashes(magnets.join(',')).join(','),
          stamp(),
          supp.id,
        );
        supp = this.supp(supp.id);
      }
      this.ensureTorrents(supp);
      if (supp.status !== 'done' && supp.status !== 'error') {
        this.run(
          "INSERT OR IGNORE INTO suppbot_jobs(supp_id,article_json,state) VALUES (?,?,'queued')",
          supp.id,
          JSON.stringify(article),
        );
      }
      this.run('UPDATE suppbot_jobs SET article_json=? WHERE supp_id=?', JSON.stringify(article), supp.id);
      return supp;
    });
  }
  ensureTorrents(supp: Supp): void {
    for (const hash of hashes(supp.magnets ?? '')) {
      this.run(
        "INSERT OR IGNORE INTO supp_torrents(created_at,updated_at,supp_id,hash,status,error) VALUES (?,?,?,?,'pending','')",
        stamp(),
        stamp(),
        supp.id,
        hash,
      );
    }
  }
  recover(): void {
    this.run("UPDATE suppbot_jobs SET state='queued',available_at=0 WHERE state='running'");
    this.run(
      "UPDATE supp_torrents SET status='pending',updated_at=? WHERE status='processing' AND supp_id IN (SELECT supp_id FROM suppbot_jobs WHERE state='queued')",
      stamp(),
    );
  }
  claim(now = Date.now()): Job | undefined {
    return this.transaction(() => {
      const job = this.one<Job>(
        "SELECT j.* FROM suppbot_jobs j JOIN supps s ON s.id=j.supp_id WHERE j.state='queued' AND j.available_at<=? AND s.deleted_at IS NULL AND s.status NOT IN ('done','error') ORDER BY j.available_at,j.supp_id LIMIT 1",
        now,
      );
      if (!job) return;
      this.run("UPDATE suppbot_jobs SET state='running',attempts=attempts+1 WHERE supp_id=?", job.supp_id);
      this.run("UPDATE supps SET status='running',updated_at=? WHERE id=?", stamp(), job.supp_id);
      return { ...job, state: 'running', attempts: job.attempts + 1 };
    });
  }
  finish(id: number): void {
    this.transaction(() => {
      this.run("UPDATE supps SET status='done',updated_at=? WHERE id=?", stamp(), id);
      this.run("UPDATE suppbot_jobs SET state='done',error='' WHERE supp_id=?", id);
    });
  }
  fail(job: Job, error: string, maxAttempts: number, interrupted = false): void {
    this.transaction(() => {
      const retry = interrupted || job.attempts < maxAttempts;
      this.run(
        'UPDATE suppbot_jobs SET state=?,error=?,available_at=?,attempts=? WHERE supp_id=?',
        retry ? 'queued' : 'error',
        error,
        interrupted ? 0 : Date.now() + Math.min(3_600_000, 60_000 * 2 ** (job.attempts - 1)),
        interrupted ? Math.max(0, job.attempts - 1) : job.attempts,
        job.supp_id,
      );
      this.run(
        'UPDATE supps SET status=?,updated_at=? WHERE id=?',
        retry ? 'pending' : 'error',
        stamp(),
        job.supp_id,
      );
    });
  }
  changeStatus(id: number, status: string): void {
    this.transaction(() => {
      this.supp(id);
      this.run(
        'UPDATE supps SET status=?,updated_at=? WHERE id=?',
        status === 'running' ? 'pending' : status,
        stamp(),
        id,
      );
      this.run(
        `INSERT INTO suppbot_jobs(supp_id,state) VALUES (?,?) ON CONFLICT(supp_id) DO UPDATE SET state=excluded.state,attempts=0,available_at=0,error=''`,
        id,
        status === 'running' ? 'queued' : status,
      );
    });
  }
  saveChannel(id: number, chatId: number, messageId: number): void {
    this.run(
      'UPDATE supps SET channel_chat_id=?,channel_id=?,updated_at=? WHERE id=?',
      chatId,
      messageId,
      stamp(),
      id,
    );
    this.attachForward(id);
  }
  saveForward(channelChatId: number, channelId: number, groupChatId: number, groupId: number): void {
    // Persist before looking for a task: automatic forwards may arrive before sendPhoto returns.
    this.transaction(() => {
      this.run(
        'INSERT OR IGNORE INTO suppbot_forwards VALUES (?,?,?,?)',
        channelChatId,
        channelId,
        groupChatId,
        groupId,
      );
      this.run(
        `UPDATE supps SET linked_group_chat_id=?,linked_group_id=?,updated_at=?
        WHERE channel_chat_id=? AND channel_id=? AND deleted_at IS NULL AND COALESCE(linked_group_id,0)=0`,
        groupChatId,
        groupId,
        stamp(),
        channelChatId,
        channelId,
      );
    });
  }
  private attachForward(id: number): void {
    const supp = this.supp(id);
    const forward = this.one<{ group_chat_id: number; group_id: number }>(
      'SELECT * FROM suppbot_forwards WHERE channel_chat_id=? AND channel_id=?',
      supp.channel_chat_id,
      supp.channel_id,
    );
    if (forward) {
      this.run(
        'UPDATE supps SET linked_group_chat_id=?,linked_group_id=?,updated_at=? WHERE id=?',
        forward.group_chat_id,
        forward.group_id,
        stamp(),
        id,
      );
    }
  }
  torrents(id: number): TorrentRecord[] {
    return this.all('SELECT * FROM supp_torrents WHERE supp_id=? AND deleted_at IS NULL ORDER BY id', id);
  }
  torrentStatus(id: number, status: string, error = ''): void {
    this.run('UPDATE supp_torrents SET status=?,error=?,updated_at=? WHERE id=?', status, error, stamp(), id);
  }
  prepareSend(torrentId: number, sourcePath: string, type: string, name: string): SendRecord {
    return this.transaction(() => {
      this.run(
        "INSERT OR IGNORE INTO send_records(created_at,updated_at,torrent_id,source_path,send_type,file_name,status,error) VALUES (?,?,?,?,?,?,'pending','')",
        stamp(),
        stamp(),
        torrentId,
        sourcePath,
        type,
        name,
      );
      const record = this.one<SendRecord>(
        'SELECT * FROM send_records WHERE torrent_id=? AND source_path=? AND send_type=? AND file_name=? AND deleted_at IS NULL',
        torrentId,
        sourcePath,
        type,
        name,
      );
      if (!record) {
        throw new Error('Send record conflicts with a deleted record; manual reconciliation required');
      }
      return record;
    });
  }
  updateSend(id: number, patch: Partial<SendRecord>): void {
    const allowed = [
      'status',
      'error',
      'file_id',
      'file_unique_id',
      'channel_chat_id',
      'channel_message_id',
      'group_chat_id',
      'group_message_id',
    ];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    this.run(
      `UPDATE send_records SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=?`,
      ...entries.map(([, value]) => value as SQLInputValue),
      stamp(),
      id,
    );
  }
  chat(chat: { id: number; username?: string; title?: string; type: string }): void {
    this.run(
      `INSERT INTO chat_identities(created_at,updated_at,chat_id,username,title,type) VALUES (?,?,?,?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET updated_at=excluded.updated_at,username=excluded.username,title=excluded.title,type=excluded.type`,
      stamp(),
      stamp(),
      chat.id,
      chat.username ?? '',
      chat.title ?? '',
      chat.type,
    );
  }
  telegramURL(chatId: number, messageId: number): string {
    if (!messageId) return '';
    const chat = this.one<{ username: string }>(
      'SELECT username FROM chat_identities WHERE chat_id=? AND deleted_at IS NULL',
      chatId,
    );
    if (chat?.username) {
      return `https://t.me/${encodeURIComponent(chat.username.replace(/^@/, ''))}/${messageId}`;
    }
    return String(chatId).startsWith('-100') ? `https://t.me/c/${String(chatId).slice(4)}/${messageId}` : '';
  }
  meta(key: string): string | undefined {
    return this.one<{ value: string }>('SELECT value FROM suppbot_meta WHERE key=?', key)?.value;
  }
  setMeta(key: string, value: string): void {
    this.run(
      'INSERT INTO suppbot_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      value,
    );
  }
}

export const sendComplete = (record: SendRecord): boolean =>
  ['success', 'skipped_too_large'].includes(record.status);
