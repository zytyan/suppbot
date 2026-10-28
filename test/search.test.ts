import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { SEARCH_REFRESH_MS, SEARCH_SESSION_MS, SearchStore } from '../src/search-store.ts';
import { type ArticleDocument, parseArticleDocument } from '../src/crawler.ts';
import { article, config } from './helpers.ts';

const document: ArticleDocument = {
  ...article,
  body: '这里是网页正文，支持中文和拼音搜索。',
  postTime: '2026-10-28T00:00:00Z',
};
function add(store: SearchStore, id: number, patch: Partial<ArticleDocument> = {}) {
  const value = { ...document, url: `https://example.test/wp/${id}.html`, ...patch };
  store.enqueue(`/wp/${id}.html`, value.url);
  store.save(`/wp/${id}.html`, value);
}
Deno.test('real FTS5 simple indexes Chinese, pinyin, English and metadata with weighted titles', () => {
  const store = new SearchStore(':memory:', config.simpleExtension);
  try {
    add(store, 1, {
      title: '星空故事 星空',
      body: 'A quiet evening',
      author: '张三',
      category: '动画',
      tags: ['温馨'],
    });
    add(store, 2, { title: '其他文章', body: '星空故事 星空', postTime: '2026-10-29' });
    equal(store.search('星空').total, 2);
    equal(store.search('星空').hits[0]!.path, '/wp/1.html');
    equal(store.search('xingkong').total, 2);
    equal(store.search('quiet evening').total, 1);
    equal(store.search('张三').total, 1);
    equal(store.search('温馨').total, 1);
    equal(store.search('动画').total, 1);
    add(store, 3, { title: '日本語タイトル', body: '日本語の本文です' });
    equal(store.search('日本語').total, 1);
    for (const query of ['***', '"', '()', 'OR', "x' OR 1=1 --", '星空 " OR *']) store.search(query);
    equal(store.search('***').total, 0);
    equal(store.status().indexed, 3);
    equal(store.status().ready, true);
  } finally {
    store.close();
  }
});
Deno.test('index updates atomically without duplicate rows and failed refresh retains searchable text', () => {
  const store = new SearchStore(':memory:', config.simpleExtension);
  try {
    add(store, 1, { title: '旧标题', body: '旧版正文' });
    store.fail('/wp/1.html', 'HTTP 503');
    equal(store.search('旧版正文').total, 1);
    equal(store.status().failed, 1);
    store.save('/wp/1.html', { ...document, title: '新标题', body: '新版内容' });
    equal(store.search('旧版正文').total, 0);
    equal(store.search('新版内容').total, 1);
    equal(store.status().total, 1);
    equal(store.status().failed, 0);
    throws(() =>
      store.transaction(() => {
        store.save('/wp/1.html', { ...document, title: '回滚', body: '不应提交' });
        throw new Error('rollback');
      })
    );
    equal(store.search('新版内容').total, 1);
    equal(store.search('不应提交').total, 0);
  } finally {
    store.close();
  }
});
Deno.test('new documents take priority, failures back off and successful pages refresh after 24 hours', () => {
  const store = new SearchStore(':memory:', config.simpleExtension), now = Date.now();
  try {
    store.enqueue('/wp/1.html', 'https://example.test/wp/1.html', 0);
    store.enqueue('/wp/2.html', 'https://example.test/wp/2.html', 1);
    equal(store.due(now)!.path, '/wp/2.html');
    store.fail('/wp/2.html', 'not found', now);
    equal(store.due(now)!.path, '/wp/1.html');
    store.save('/wp/1.html', document, now);
    equal(store.due(now + 59999), undefined);
    equal(store.due(now + 60000)!.path, '/wp/2.html');
    store.save('/wp/2.html', document, now);
    equal(store.due(now + SEARCH_REFRESH_MS - 1), undefined);
    ok(store.due(now + SEARCH_REFRESH_MS));
  } finally {
    store.close();
  }
});
Deno.test('sessions and fetch progress survive restart; pagination clamps and sessions expire', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'suppbot-search-store-' }), path = dir + '/search.db';
  let store: SearchStore | undefined;
  try {
    store = new SearchStore(path, config.simpleExtension);
    for (let index = 1; index <= 7; index++) add(store, index, { title: '分页测试' });
    store.enqueue('/wp/8.html', 'https://example.test/wp/8.html');
    const now = Date.now(), session = store.createSession('分页测试', 123, -456, now);
    store.close();
    store = new SearchStore(path, config.simpleExtension);
    equal(store.session(session.id, now)!.owner_id, 123);
    equal(store.session(session.id, now)!.chat_id, -456);
    equal(store.session(session.id, now + SEARCH_SESSION_MS), undefined);
    equal(store.search('分页测试', 1).hits.length, 5);
    equal(store.search('分页测试', 2).hits.length, 2);
    equal(store.search('分页测试', 999).page, 2);
    equal(store.status().pending, 1);
    equal(store.due()!.path, '/wp/8.html');
  } finally {
    store?.close();
    Deno.removeSync(dir, { recursive: true });
  }
});
Deno.test('detail parser reads a plain heading, preserves paragraphs and excludes navigation, comments and ads', () => {
  const parsed = parseArticleDocument(
    `<html><nav>导航秘密</nav><article><header><h1 class="entry-title">标题 &amp; 测试</h1><span class="author vcard">作者</span><time datetime="2026-10-28T00:00:00Z">昨天</time></header>
    <div class="entry-content"><p>第一段中文</p><p>第二段 English<br>下一行</p><script>脚本秘密</script><style>样式秘密</style><div class="ads">广告秘密</div></div>
    <footer><span class="cat-links"><a>分类</a></span><span class="tag-links"><a>标签</a></span></footer></article><div id="comments">评论秘密</div></html>`,
    article.url,
  );
  equal(parsed.title, '标题 & 测试');
  equal(parsed.author, '作者');
  equal(parsed.postTime, '2026-10-28T00:00:00Z');
  deepEqual(parsed.tags, ['标签']);
  equal(parsed.category, '分类');
  ok(parsed.body.includes('第一段中文\n第二段 English\n下一行'));
  ok(!parsed.body.includes('秘密'));
  throws(() => parseArticleDocument('<article><h1>错误页</h1></article>', article.url), /missing/);
});
