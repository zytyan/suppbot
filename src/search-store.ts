import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ArticleDocument } from './crawler.ts';

export const SEARCH_PAGE_SIZE = 5;
export const SEARCH_REFRESH_MS = 24 * 60 * 60 * 1000;
export const SEARCH_SESSION_MS = 30 * 60 * 1000;
export interface SearchDocument {
  id: number;
  path: string;
  url: string;
  title: string;
  author: string;
  posted_at: string;
  category: string;
  tags: string;
  body: string;
  indexed_at: number | null;
  next_fetch_at: number;
  attempts: number;
  last_error: string;
  priority: number;
}
export interface SearchHit {
  path: string;
  url: string;
  title: string;
  excerpt: string;
}
export interface SearchPage {
  hits: SearchHit[];
  total: number;
  page: number;
  pages: number;
}
export interface SearchStatus {
  ready: boolean;
  total: number;
  indexed: number;
  pending: number;
  failed: number;
  last_indexed_at: string | null;
  last_error: string;
}
export interface SearchSession {
  id: string;
  query: string;
  owner_id: number;
  chat_id: number;
  expires_at: number;
}

export class SearchStore {
  private db: DatabaseSync;
  constructor(path: string, extension: string) {
    this.db = new DatabaseSync(path, { allowExtension: true });
    try {
      this.db.loadExtension(extension);
      // Deno exposes loadExtension but keeps the SQL load_extension() function disabled.
      const connection = this.db as DatabaseSync & { enableLoadExtension?: (enabled: boolean) => void };
      connection.enableLoadExtension?.(false);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, url TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', posted_at TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
          indexed_at INTEGER, next_fetch_at INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS idx_search_fetch ON documents(next_fetch_at,priority);
        CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
          title,author,category,tags,body,content='documents',content_rowid='id',tokenize='simple');
        CREATE TRIGGER IF NOT EXISTS search_insert AFTER INSERT ON documents BEGIN
          INSERT INTO documents_fts(rowid,title,author,category,tags,body)
          VALUES(new.id,new.title,new.author,new.category,new.tags,new.body);
        END;
        CREATE TRIGGER IF NOT EXISTS search_delete AFTER DELETE ON documents BEGIN
          INSERT INTO documents_fts(documents_fts,rowid,title,author,category,tags,body)
          VALUES('delete',old.id,old.title,old.author,old.category,old.tags,old.body);
        END;
        CREATE TRIGGER IF NOT EXISTS search_update AFTER UPDATE OF title,author,category,tags,body ON documents BEGIN
          INSERT INTO documents_fts(documents_fts,rowid,title,author,category,tags,body)
          VALUES('delete',old.id,old.title,old.author,old.category,old.tags,old.body);
          INSERT INTO documents_fts(rowid,title,author,category,tags,body)
          VALUES(new.id,new.title,new.author,new.category,new.tags,new.body);
        END;
        CREATE TABLE IF NOT EXISTS search_sessions (
          id TEXT PRIMARY KEY,query TEXT NOT NULL,owner_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_search_sessions_expiry ON search_sessions(expires_at);
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  private all<T>(sql: string, ...values: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...values) as unknown as T[];
  }
  private one<T>(sql: string, ...values: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...values) as unknown as T | undefined;
  }
  transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  enqueue(path: string, url: string, priority = 1): void {
    this.db.prepare(`INSERT INTO documents(path,url,priority) VALUES (?,?,?)
      ON CONFLICT(path) DO UPDATE SET url=excluded.url,priority=MAX(documents.priority,excluded.priority)`)
      .run(path, url, priority);
  }
  due(now = Date.now()): SearchDocument | undefined {
    return this.one<SearchDocument>(
      `SELECT * FROM documents WHERE next_fetch_at<=?
      ORDER BY priority DESC,(indexed_at IS NOT NULL),next_fetch_at,id LIMIT 1`,
      now,
    );
  }
  save(path: string, article: ArticleDocument, now = Date.now()): void {
    this.db.prepare(`UPDATE documents SET url=?,title=?,author=?,posted_at=?,category=?,tags=?,body=?,
      indexed_at=?,next_fetch_at=?,attempts=0,last_error='',priority=0 WHERE path=?`).run(
      article.url,
      article.title,
      article.author,
      article.postTime,
      article.category,
      article.tags.join(' '),
      article.body,
      now,
      now + SEARCH_REFRESH_MS,
      path,
    );
  }
  fail(path: string, error: string, now = Date.now()): void {
    const attempts =
      (this.one<{ attempts: number }>('SELECT attempts FROM documents WHERE path=?', path)?.attempts ?? 0) +
      1;
    const delay = Math.min(SEARCH_REFRESH_MS, 60_000 * 2 ** Math.min(attempts - 1, 11));
    this.db.prepare('UPDATE documents SET attempts=?,last_error=?,next_fetch_at=?,priority=0 WHERE path=?')
      .run(attempts, error, now + delay, path);
  }
  status(): SearchStatus {
    const stats = this.one<
      { total: number; indexed: number; pending: number; failed: number; last: number | null }
    >(`SELECT COUNT(*) total,
      COUNT(indexed_at) AS "indexed",COUNT(*)-COUNT(indexed_at) pending,
      COALESCE(SUM(last_error<>''),0) failed,MAX(indexed_at) last FROM documents`)!;
    const lastError = this.one<{ last_error: string }>(
      "SELECT last_error FROM documents WHERE last_error<>'' ORDER BY next_fetch_at DESC LIMIT 1",
    );
    return {
      ready: true,
      total: stats.total,
      indexed: stats.indexed,
      pending: stats.pending,
      failed: stats.failed,
      last_indexed_at: stats.last === null ? null : new Date(stats.last).toISOString(),
      last_error: lastError?.last_error ?? '',
    };
  }
  search(query: string, page = 1): SearchPage {
    const expression = this.one<{ query: string }>('SELECT simple_query(?) query', query)?.query;
    if (!expression?.trim()) return { hits: [], total: 0, page: 1, pages: 1 };
    const total = this.one<{ total: number }>(
      `SELECT COUNT(*) total FROM documents_fts f
      JOIN documents d ON d.id=f.rowid WHERE documents_fts MATCH ? AND d.indexed_at IS NOT NULL`,
      expression,
    )!.total;
    const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
    page = Math.min(pages, Math.max(1, Number.isSafeInteger(page) ? page : 1));
    const hits = this.all<SearchHit>(
      `SELECT d.path,d.url,d.title,
      simple_snippet(documents_fts,4,'','',' … ',32) excerpt FROM documents_fts
      JOIN documents d ON d.id=documents_fts.rowid WHERE documents_fts MATCH ? AND d.indexed_at IS NOT NULL
      ORDER BY bm25(documents_fts,10.0,3.0,3.0,3.0,1.0),d.posted_at DESC,d.id DESC LIMIT ? OFFSET ?`,
      expression,
      SEARCH_PAGE_SIZE,
      (page - 1) * SEARCH_PAGE_SIZE,
    );
    return { hits, total, page, pages };
  }
  createSession(query: string, owner: number, chat: number, now = Date.now()): SearchSession {
    this.db.prepare('DELETE FROM search_sessions WHERE expires_at<=?').run(now);
    const session = {
      id: crypto.randomUUID().replaceAll('-', '').slice(0, 24),
      query,
      owner_id: owner,
      chat_id: chat,
      expires_at: now + SEARCH_SESSION_MS,
    };
    this.db.prepare('INSERT INTO search_sessions VALUES (?,?,?,?,?)').run(
      session.id,
      query,
      owner,
      chat,
      session.expires_at,
    );
    return session;
  }
  session(id: string, now = Date.now()): SearchSession | undefined {
    return this.one<SearchSession>('SELECT * FROM search_sessions WHERE id=? AND expires_at>?', id, now);
  }
}
