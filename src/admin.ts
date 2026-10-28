import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import type { Config } from './config.ts';
import { Store } from './store.ts';
import { Runtime } from './runtime.ts';
import type { Job, SendRecord, Supp, TorrentRecord } from './types.ts';
import { errorText, escapeHTML as e, hashes } from './types.ts';
import type { QbitClient } from './qbit.ts';

const security = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
const badge = (value: string) => `<span class="badge">${e(value)}</span>`;
const formatTime = (value: string) => value ? e(value) : '-';
const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) => v.toString(16).padStart(2, '0')).join('');

export function adminHandler(
  config: Config,
  store: Store,
  runtime: Runtime,
  qbit: QbitClient,
  signal: AbortSignal,
): (request: Request) => Promise<Response> {
  const base = config.adminBasePath;
  const form = (supp: Supp, csrf: string) =>
    `<form method="post" action="${base}/supps/${supp.id}/status"><input type="hidden" name="csrf_token" value="${csrf}"><select name="status">${
      ['done', 'error', 'running'].map((s) =>
        `<option value="${s}" ${supp.status === s ? 'selected' : ''}>${
          s === 'running' ? '重新入队' : s
        }</option>`
      ).join('')
    }</select><button>修改状态</button></form>`;
  const link = (chat: number, message: number) => {
    const url = store.telegramURL(chat, message);
    return url
      ? `<a href="${e(url)}" target="_blank" rel="noreferrer">${chat} / ${message}</a>`
      : `${chat || 0} / ${message || 0}`;
  };
  const counts = (table: 'supps' | 'supp_torrents' | 'send_records') =>
    store.all<{ status: string; count: number }>(
      `SELECT status,COUNT(*) count FROM ${table} WHERE deleted_at IS NULL GROUP BY status ORDER BY status`,
    );
  const options = (table: 'supps' | 'supp_torrents' | 'send_records', selected: string) =>
    counts(table).map((row) =>
      `<option value="${e(row.status)}" ${row.status === selected ? 'selected' : ''}>${
        e(row.status)
      } (${row.count})</option>`
    ).join('');
  return async (request) => {
    const url = new URL(request.url);
    // Accept both the public prefix and the prefix-stripped path used by the existing reverse proxy.
    const path = url.pathname === base
      ? '/'
      : url.pathname.startsWith(base + '/')
      ? url.pathname.slice(base.length)
      : url.pathname;
    const headers = new Headers(security);
    const response = (body: string, status = 200, type = 'text/html; charset=utf-8') => {
      headers.set('Content-Type', type);
      return new Response(body, { status, headers });
    };
    try {
      if (request.method === 'GET' && path.startsWith('/static/')) {
        const filename = path.slice('/static/'.length);
        if (!['admin.css', 'admin.js'].includes(filename)) return response('Not found', 404);
        const body = await Deno.readTextFile(resolve('web/static', filename));
        return response(
          body,
          200,
          filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        );
      }
      if (request.method === 'GET' && path === '/api/runtime') {
        return response(JSON.stringify(runtime.snapshot()), 200, 'application/json');
      }
      const cookie = request.headers.get('cookie')?.split(';').map((v) => v.trim()).find((v) =>
        v.startsWith('suppbot_csrf=')
      )?.slice(13);
      const csrf = cookie && /^[a-f0-9]{64}$/.test(cookie) ? cookie : token();
      if (csrf !== cookie) {
        headers.append(
          'Set-Cookie',
          `suppbot_csrf=${csrf}; Path=${base}/; HttpOnly; SameSite=Strict${
            url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https'
              ? '; Secure'
              : ''
          }; Max-Age=86400`,
        );
      }
      const match = path.match(/^\/supps\/(\d+)(\/status)?$/);
      if (request.method === 'POST' && match?.[2]) {
        const body = await request.text();
        if (body.length > 4096) return response('Request too large', 413);
        const fields = new URLSearchParams(body), submitted = fields.get('csrf_token') ?? '';
        if (
          !cookie || submitted.length !== csrf.length ||
          !timingSafeEqual(new TextEncoder().encode(submitted), new TextEncoder().encode(csrf))
        ) return response('CSRF 校验失败', 403);
        const id = Number(match[1]), status = fields.get('status') ?? '';
        if (!Number.isSafeInteger(id) || !['done', 'error', 'running'].includes(status)) {
          return response('无效状态或 ID', 400);
        }
        if (!store.one('SELECT id FROM supps WHERE id=? AND deleted_at IS NULL', id)) {
          return response('Not found', 404);
        }
        if (runtime.active(id)) return response('该补档正在执行，不能修改', 409);
        store.changeStatus(id, status);
        headers.set(
          'Location',
          `${base}/supps/${id}?notice=${
            encodeURIComponent(status === 'running' ? '任务已重新入队' : '状态已更新')
          }`,
        );
        return new Response(null, { status: 303, headers });
      }
      if (request.method !== 'GET') return response('Method not allowed', 405);
      let title = '', content = '';
      if (path === '/') {
        title = '运行总览';
        content = `<section class="stats">${
          (['supps', 'supp_torrents', 'send_records'] as const).map((table, index) =>
            `<article><h2>${['补档状态', 'Torrent 状态', '发送状态'][index]}</h2><div class="count-grid">${
              counts(table).map((row) =>
                `<div class="count"><strong>${row.count}</strong><span>${e(row.status)}</span></div>`
              ).join('') || '暂无记录'
            }</div></article>`
          ).join('')
        }</section><section><div class="section-head"><h2>实时运行状态</h2><span id="runtime-updated">每 5 秒刷新</span></div><div id="runtime-root"></div></section>`;
      } else if (path === '/supps') {
        title = '补档查询';
        const query = url.searchParams.get('q') ?? '',
          status = url.searchParams.get('status') ?? '',
          torrentStatus = url.searchParams.get('torrent_status') ?? '',
          sendStatus = url.searchParams.get('send_status') ?? '';
        const clauses = ['s.deleted_at IS NULL'], params: (string | number)[] = [];
        if (status) {
          clauses.push('s.status=?');
          params.push(status);
        }
        if (torrentStatus) {
          clauses.push(
            'EXISTS (SELECT 1 FROM supp_torrents t WHERE t.supp_id=s.id AND t.deleted_at IS NULL AND t.status=?)',
          );
          params.push(torrentStatus);
        }
        if (sendStatus) {
          clauses.push(
            'EXISTS (SELECT 1 FROM supp_torrents t JOIN send_records r ON r.torrent_id=t.id AND r.deleted_at IS NULL WHERE t.supp_id=s.id AND t.deleted_at IS NULL AND r.status=?)',
          );
          params.push(sendStatus);
        }
        if (query) {
          clauses.push(
            `(s.article_url_path LIKE ? OR CAST(s.id AS TEXT)=? OR EXISTS (SELECT 1 FROM supp_torrents t LEFT JOIN send_records r ON r.torrent_id=t.id AND r.deleted_at IS NULL WHERE t.supp_id=s.id AND t.deleted_at IS NULL AND (t.hash LIKE ? OR t.error LIKE ? OR r.file_name LIKE ? OR r.source_path LIKE ? OR r.error LIKE ?)))`,
          );
          const like = `%${query}%`;
          params.push(like, query, like, like, like, like, like);
        }
        const where = clauses.join(' AND '),
          count =
            store.one<{ count: number }>(`SELECT COUNT(*) count FROM supps s WHERE ${where}`, ...params)!
              .count;
        const pages = Math.max(1, Math.ceil(count / 50)),
          page = Math.min(pages, Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1') || 1));
        const supps = store.all<Supp & { torrent_count: number; send_count: number; error_count: number }>(
          `SELECT s.*,
          (SELECT COUNT(*) FROM supp_torrents t WHERE t.supp_id=s.id AND t.deleted_at IS NULL) torrent_count,
          (SELECT COUNT(*) FROM supp_torrents t JOIN send_records r ON r.torrent_id=t.id AND r.deleted_at IS NULL WHERE t.supp_id=s.id AND t.deleted_at IS NULL) send_count,
          (SELECT COUNT(*) FROM supp_torrents t LEFT JOIN send_records r ON r.torrent_id=t.id AND r.deleted_at IS NULL WHERE t.supp_id=s.id AND t.deleted_at IS NULL AND (t.status='error' OR r.status IN ('failed','uncertain','sending'))) error_count
          FROM supps s WHERE ${where} ORDER BY s.updated_at DESC,s.id DESC LIMIT 50 OFFSET ?`,
          ...params,
          (page - 1) * 50,
        );
        content = `<form class="filters" method="get"><input name="q" value="${
          e(query)
        }" placeholder="ID、文章路径、hash、文件名或错误"><select name="status"><option value="">全部补档状态</option>${
          options('supps', status)
        }</select><select name="torrent_status"><option value="">全部 torrent 状态</option>${
          options('supp_torrents', torrentStatus)
        }</select><select name="send_status"><option value="">全部发送状态</option>${
          options('send_records', sendStatus)
        }</select><button>查询</button></form><div class="cards">${
          supps.map((supp) =>
            `<article class="row-card"><div class="task-head"><a href="${base}/supps/${supp.id}">#${supp.id} · ${
              e(supp.article_url_path)
            }</a>${
              badge(supp.status)
            }</div><p>Torrent ${supp.torrent_count} · 发送 ${supp.send_count} · 错误 ${supp.error_count} · Magnet ${
              hashes(supp.magnets ?? '').length
            }</p><small>${formatTime(supp.updated_at)}</small>${form(supp, csrf)}</article>`
          ).join('') || '<div class="empty">没有匹配记录</div>'
        }</div>`;
        const pageLink = (number: number, label: string) => {
          const search = new URLSearchParams(url.searchParams);
          search.set('page', String(number));
          return `<a href="?${e(search.toString())}">${label}</a>`;
        };
        content += `<div class="pager">第 ${page} / ${pages} 页 ${
          page > 1 ? pageLink(page - 1, '上一页') : ''
        } ${page < pages ? pageLink(page + 1, '下一页') : ''}</div>`;
      } else if (match && !match[2]) {
        title = '补档详情';
        const id = Number(match[1]);
        if (!store.one('SELECT id FROM supps WHERE id=? AND deleted_at IS NULL', id)) {
          return response('Not found', 404);
        }
        const supp = store.supp(id),
          torrents = store.torrents(id),
          job = store.one<Job>('SELECT * FROM suppbot_jobs WHERE supp_id=?', id);
        const sends = store.all<SendRecord>(
          'SELECT r.* FROM send_records r JOIN supp_torrents t ON t.id=r.torrent_id WHERE t.supp_id=? AND r.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY r.id',
          id,
        );
        let live: Awaited<ReturnType<QbitClient['torrents']>> = [];
        try {
          live = await qbit.torrents(signal);
        } catch (error) {
          runtime.torrentCacheError = errorText(error);
        }
        let host = 'www.hacg.mov';
        try {
          host = (await Deno.readTextFile('liuli.link')).trim() || host;
        } catch { /* Default host. */ }
        const articleURL = `https://${host}${supp.article_url_path}`;
        content = `<article class="detail"><div class="task-head"><h2>#${id} · ${
          e(supp.article_url_path)
        }</h2>${badge(supp.status)}</div><dl><dt>原文</dt><dd><a href="${
          e(articleURL)
        }" target="_blank" rel="noreferrer">${e(articleURL)}</a></dd><dt>创建</dt><dd>${
          formatTime(supp.created_at)
        }</dd><dt>更新</dt><dd>${formatTime(supp.updated_at)}</dd><dt>频道消息</dt><dd>${
          link(supp.channel_chat_id, supp.channel_id)
        }</dd><dt>群组消息</dt><dd>${link(supp.linked_group_chat_id, supp.linked_group_id)}</dd></dl>${
          form(supp, csrf)
        }${
          job
            ? `<p>队列：${e(job.state)} · 尝试 ${job.attempts}</p>${
              job.error ? `<pre>${e(job.error)}</pre>` : ''
            }`
            : ''
        }</article><section><h2>Magnets</h2>${
          hashes(supp.magnets ?? '').map((hash) => `<p><code>${e(hash)}</code></p>`).join('')
        }</section><section><h2>Torrents</h2><div class="cards">${
          torrents.map((record: TorrentRecord) => {
            const torrent = live.find((t) =>
              [t.hash?.toLowerCase(), t.infohash_v1?.toLowerCase()].includes(record.hash.toLowerCase())
            );
            return `<article class="row-card"><div class="task-head"><code>${e(record.hash)}</code>${
              badge(record.status)
            }</div>${
              torrent
                ? `<p>${e(torrent.name)} · ${e(torrent.state)} · ${
                  (torrent.progress * 100).toFixed(1)
                }%</p><progress max="1" value="${
                  Number(torrent.progress)
                }"></progress><small>${torrent.downloaded} / ${torrent.total_size} bytes · ${torrent.dlspeed} bytes/s · ETA ${torrent.eta}s · Seeds ${torrent.num_seeds}</small>`
                : ''
            }${record.error ? `<pre>${e(record.error)}</pre>` : ''}</article>`;
          }).join('') || '无 torrent 记录'
        }</div></section><section><h2>发送记录</h2><div class="cards">${
          sends.map((record) =>
            `<article class="row-card"><div class="task-head"><strong>${e(record.file_name)}</strong>${
              badge(record.status)
            }</div><p>${e(record.send_type)} · ${e(record.source_path)}</p><p>频道 ${
              link(record.channel_chat_id, record.channel_message_id)
            } · 群组 ${link(record.group_chat_id, record.group_message_id)}</p>${
              record.error ? `<pre>${e(record.error)}</pre>` : ''
            }</article>`
          ).join('') || '无发送记录'
        }</div></section>`;
      } else return response('Not found', 404);
      return response(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · suppbot</title><link rel="stylesheet" href="${base}/static/admin.css"><script defer src="${base}/static/admin.js"></script></head><body data-runtime-url="${base}/api/runtime"><header><a class="brand" href="${base}/">suppbot</a><nav><a href="${base}/">运行总览</a><a href="${base}/supps">补档查询</a><a href="/">服务器首页</a></nav></header><main>${
          url.searchParams.get('notice')
            ? `<div class="notice">${e(url.searchParams.get('notice'))}</div>`
            : ''
        }<h1>${title}</h1>${content}</main></body></html>`,
      );
    } catch (error) {
      console.error('Admin:', errorText(error));
      return response('请求处理失败，请查看服务日志', 500);
    }
  };
}
