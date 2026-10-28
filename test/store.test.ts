import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sendComplete, Store } from '../src/store.ts';
import { article } from './helpers.ts';
import { backupBeforeMigration } from '../src/main.ts';

Deno.test('queue persists every article, claims once, retries and recovers interrupted work', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 5; i++) {
      store.enqueue({ ...article, url: `https://example.test/wp/${i}.html` }, ['ABC']);
    }
    equal(store.all('SELECT * FROM suppbot_jobs').length, 5);
    const first = store.claim()!, second = store.claim()!;
    ok(first.supp_id !== second.supp_id);
    store.fail(first, 'temporary failure', 3);
    equal(store.supp(first.supp_id).status, 'pending');
    equal(
      store.one<{ state: string }>('SELECT state FROM suppbot_jobs WHERE supp_id=?', second.supp_id)!.state,
      'running',
    );
    store.recover();
    equal(
      store.one<{ state: string }>('SELECT state FROM suppbot_jobs WHERE supp_id=?', second.supp_id)!.state,
      'queued',
    );
    const retry = store.claim(Date.now() + 3_600_000)!;
    ok(retry);
    store.changeStatus(first.supp_id, 'running');
    equal(
      store.one<{ attempts: number }>('SELECT attempts FROM suppbot_jobs WHERE supp_id=?', first.supp_id)!
        .attempts,
      0,
    );
  } finally {
    store.close();
  }
});

Deno.test('early and repeated automatic forwards survive before channel message is saved', () => {
  const store = new Store(':memory:');
  try {
    const supp = store.enqueue(article, ['ABC']);
    store.saveForward(-100123, 11, -100456, 22);
    store.saveForward(-100123, 11, -100456, 22);
    store.saveChannel(supp.id, -100123, 11);
    equal(store.supp(supp.id).linked_group_id, 22);
    equal(store.all('SELECT * FROM suppbot_forwards').length, 1);
  } finally {
    store.close();
  }
});

Deno.test('successful and skipped sends retain historical IDs and are never reset', () => {
  const store = new Store(':memory:');
  try {
    const supp = store.enqueue(article, ['ABC', 'abc', 'DEF']);
    equal(store.torrents(supp.id).length, 2);
    const torrent = store.torrents(supp.id)[0]!;
    const record = store.prepareSend(torrent.id, 'a.mp4', 'video', 'a.mp4');
    store.updateSend(record.id, {
      status: 'success',
      file_id: 'file',
      channel_chat_id: -1001,
      channel_message_id: 123,
    });
    const next = store.prepareSend(torrent.id, 'a.mp4', 'video', 'a.mp4');
    equal(next.id, record.id);
    equal(next.channel_message_id, 123);
    ok(sendComplete(next));
    store.finish(supp.id);
    store.enqueue(article, ['ABC']);
    equal(store.supp(supp.id).status, 'done');
    equal(store.claim(), undefined);
    throws(() =>
      store.transaction(() => {
        store.run("UPDATE supps SET status='error'");
        throw new Error('rollback');
      })
    );
    equal(store.supp(supp.id).status, 'done');
  } finally {
    store.close();
  }
});

Deno.test('migrates a GORM-shaped database without changing history and makes a consistent backup', async () => {
  const dir = Deno.makeTempDirSync({ prefix: 'suppbot-test-' }), path = `${dir}/legacy.db`;
  try {
    const old = new DatabaseSync(path);
    old.exec(
      `CREATE TABLE supps (id INTEGER PRIMARY KEY AUTOINCREMENT,created_at DATETIME,updated_at DATETIME,deleted_at DATETIME,article_url_path TEXT,channel_chat_id INTEGER,channel_id INTEGER,linked_group_chat_id INTEGER,linked_group_id INTEGER,magnets TEXT,status TEXT);
      INSERT INTO supps VALUES (42,'2026-01-01','2026-01-02',NULL,'/wp/42.html',-100123,11,-100456,22,'ABC,def','running');`,
    );
    old.close();
    const backup = (await backupBeforeMigration(path))!;
    ok(backup);
    const copy = new DatabaseSync(backup, { readOnly: true });
    equal(copy.prepare('SELECT id FROM supps').get()!.id, 42);
    copy.close();
    let store = new Store(path);
    equal(store.supp(42).channel_id, 11);
    deepEqual(store.torrents(42).map((t) => t.hash), ['abc', 'def']);
    equal(store.claim()!.supp_id, 42);
    store.close();
    store = new Store(path);
    store.recover();
    equal(store.claim()!.supp_id, 42);
    equal(await backupBeforeMigration(path), undefined);
    store.close();
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
