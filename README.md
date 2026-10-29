# suppbot

Deno + TypeScript + grammY 实现的 Telegram 自动补档机器人。负责抓取文章、下载磁链、处理视频、上传文件及提供管理后台。频道文章附带可复制的完整 magnet 链接；超出图片说明长度时以该帖回复分批发送，并记录发送进度。提供基于网页正文的中文、拼音全文搜索。

## 运行

需要 Deno 2.9+、FFmpeg（含 ffprobe、libx264、drawtext）和 `rar`。搜索扩展安装脚本需要 Python 3；固定发布包适用于 Linux x86_64。

```sh
cp config/config-template.toml config/config.toml
# 编辑 bot token、Telegram 本地 API、频道/群组和 qBittorrent 配置
# 从仓库根目录执行所有任务
deno task setup:simple
deno task check
deno task test
deno task lint
deno task start --check
deno task start
```

`--check` 只读检查配置与现有 SQLite 完整性，不登录任何服务、不迁移数据库；数据库尚未创建时，直接启动即可。

依赖固定在 `deno.json` 与 `deno.lock`。首次运行会缓存依赖。`deno task setup:simple` 安装并校验 simple v0.7.1 原生扩展；程序加载扩展需要 Deno 的 `--allow-ffi`，已包含在 start/test 任务中。执行权限只允许 `ffmpeg`、`ffprobe`、`rar` 三个外部程序；文件、网络、环境变量权限用于已有配置指定的数据库、媒体路径和本地 API。测试没有网络权限，使用临时数据库和模拟 Telegram 请求。

沿用 `config/config.toml`。可用 `--config PATH` 或 `SUPPBOT_CONFIG` 指定其他配置；`-test` 读取旧的测试配置；`--page N`（兼容 `-page N`）选择抓取页，默认第一页。`liuli.link` 继续指定文章站点域名。

可选配置（放在 `[qbit]` 之前）：

```toml
max-concurrent = 2
crawl-interval-seconds = 7200
task-timeout-seconds = 72000
linked-message-timeout-seconds = 300
max-attempts = 3
```

管理后台默认 `127.0.0.1:9001`，可通过 `SUPPBOT_ADMIN_LISTEN` 调整。对外路径仍为 `/suppbot/`，支持现有反向代理剥离前缀的方式。页面包含运行状态、历史查询/筛选、发送详情与状态管理。“重新入队”会真正创建可执行任务。保留现有反向代理的访问控制；应用本身不实现登录，不应直接向公网暴露管理端口。

Telegram Bot API 必须运行在 local 模式，并与本进程共享媒体文件路径。文件通过编码后的 `file://` URI 发送，避免将大文件载入内存。视频缩略图使用 multipart 上传。

## 架构与行为

- `src/main.ts`：显式初始化、首次迁移备份、进程锁和退出清理。
- `src/config.ts`：TOML 配置与参数校验，无模块导入副作用。
- `src/store.ts`：SQLite 兼容层、持久化队列及发送记录。
- `src/crawler.ts`、`src/qbit.ts`：抓取与下载适配器。
- `src/telegram.ts`：grammY 更新处理、消息关联与发送。
- `src/worker.ts`：并发限制、超时、重试、任务恢复。
- `src/search-store.ts`、`src/search-service.ts`、`src/search-bot.ts`：FTS5 搜索库、正文索引任务、命令与分页。
- `src/media.ts`：文件打包、视频转码、音频转换、九宫格截图。
- `src/runtime.ts`、`src/admin.ts`：实时快照和管理页面。

抓取发现的文章先入库排队，不再因并发满而丢弃。每个 worker 同时处理一个 torrent，避免单篇文章启动大量转码。临时错误按退避策略重试，达到上限后标记 error。每次尝试都有整体时限，关联群消息另有较短等待时限。退出信号贯穿下载轮询、转码、API 请求与等待；中断任务重新排队且不消耗重试次数。

频道封面下载携带文章 Referer，并校验图片格式和大小；临时失败最多重试 3 次，必要时刷新网页封面地址。有封面地址但仍无法取得有效图片时，任务报错并按队列策略重试，发帖前不会进入发送中状态。网页未提供封面地址时使用占位图并明确记录原因；`suppbot_meta` 的 `channel-photo:<id>` 保存图片来源、尝试次数、发送后的文件 ID 和尺寸。

关联群消息先持久化，再绑定频道消息，因此支持早到、重复消息及重启恢复。已有频道消息不会因为缺少群消息而重新发帖。成功文件及因大小限制跳过的视频保持原有去重规则。后台标记为 done 是人工确认，不执行文件上传。

## 网页全文搜索

私聊或补档关联群发送 `/serarch 关键词`，也支持 `/search` 和群内 `/search@机器人用户名 关键词`。启动后 Bot 会自动将命令及中文说明注册到 Telegram 的私聊与关联群命令菜单，私聊菜单按钮使用 commands 模式；同步失败在后台退避重试，不阻塞补档与搜索。命令定义和处理器共用同一份列表。每页 5 条，按相关度排序，标题权重更高；结果包含命中摘要、原文链接和已有补档消息入口。“上一页／下一页”只允许发起用户在原聊天中操作，会话 30 分钟后失效。关键词上限 200 字符。

搜索使用独立 `search.db`，FTS5 分词器为 [wangfenjin/simple v0.7.1](https://github.com/wangfenjin/simple/releases/tag/v0.7.1)，支持中文、拼音和英文。使用参数化 `simple_query()`，不要求用户输入 FTS 语法，不依赖外部 Jieba 词典。索引标题、正文、作者、分类和标签，排除评论、导航、广告与脚本。

首次启动后台补抓补档数据库内的历史文章；新发现的文章优先索引，无磁链或补档失败的网页也可收录。单并发、每次请求完成后至少等待 2 秒，成功后每 24 小时刷新；失败退避重试并保留旧索引。进度持久化，退出后继续。补抓过程中即可使用已收录内容，不重新发布历史消息。首次全量收录至少约 25 分钟，具体取决于网页响应与失效链接。

可选根配置（放在 `[qbit]` 前）：

```toml
search-database = "search.db" # 默认与补档数据库同目录
simple-extension = "lib/libsimple.so"
```

`libsimple.so`、搜索数据库和会话不提交到 Git。安装脚本校验固定的官方 ZIP 和二进制 SHA-256，并原子替换扩展文件。Deno 的 SQLite 仅在初始化时加载配置指定的扩展，SQL `load_extension()` 保持禁用。扩展缺失、权限错误或索引初始化失败时，只关闭搜索，补档继续运行；修复后重启服务即可恢复。

`/suppbot/api/runtime` 的 `search` 字段提供 `ready`、`total`、`indexed`、`pending`、`failed`、`last_indexed_at`、`last_error`。数据库包含网页正文及短期搜索会话，应按服务数据管理；丢失后可从已知文章重建。回滚只需恢复旧代码，补档主库结构与发送记录不变。

## 视频压缩

视频目标码率为 4 Mbps；源视频码率严格超过 4.5 Mbps 或源文件超过 2 GB 时压缩。码率字段缺失时按文件大小和时长估算。音频沿用原策略：码率已知的 AAC 直接复制，其他音频转换为 AAC 192 kbps。

按目标码率预估总大小（包括音频与 3% 封装余量）超过 2 GB 时，按 1.90 GB 总预算计算视频码率，采用 H.264 两遍编码。计算结果低于 400 kbps 则报错并停止自动重试；等于 400 kbps 允许编码。1 GB 按 1,000,000,000 字节计算。

上传前检查实际输出大小；超过预算会降低码率后重压，最多编码三轮。仍超限或重压需要低于 400 kbps 时标记 failed，不发送视频或将其作为原文件打包发送。成功的历史发送记录保持去重，历史 skipped_too_large 记录不会自动补发。

## 数据迁移与上线

Go 源码及迁移前的本地 Go 修复保存在分支 **`archive/go-before-deno`**（快照提交 `67678f8`）。当前工作分支仅保留 Deno 实现及共用资源。

继续使用原有 `supps`、`supp_torrents`、`send_records`、`chat_identities` 表及主键。首次启动新增 `suppbot_jobs`、`suppbot_forwards`、`suppbot_meta`，并在修改前用 SQLite 在线备份 API 创建一致性备份 `data.db.bak.before-deno-*`。已有 running/pending 任务进入队列；历史 done/error 保持原状态，error 可在后台手动重新入队。没有保存文章元数据的历史任务，在缺少频道消息时才重新抓取原文。

同一个 token、数据库只能运行一个补档实例。新版本用文件锁防止多个 Deno 实例，但旧 Go 进程不使用这个锁，必须先停止旧服务再启动新版。

上线步骤：

1. 先通过检查和测试；可在数据库副本上运行 `deno task start --config /tmp/suppbot-test.toml --migrate-only` 验证迁移。
2. 停止旧服务，确认原有 Go 进程已退出。
3. 已有服务可将 `deploy/suppbot-deno.conf` 安装到 `/etc/systemd/system/suppbot.service.d/20-deno.conf`，保留原有依赖和启动前检查；新安装可使用 `deploy/suppbot-deno.service`。按实际路径修改工作目录、Deno 路径和运行用户，并给运行用户创建可写 `.deno-cache` 目录。先以该用户设置 `DENO_DIR` 执行 `deno cache --frozen --allow-import=deno.land,cdn.skypack.dev,jsr.io src/main.ts` 缓存依赖，再执行 `systemctl daemon-reload`。
4. 启动新服务，检查任务恢复、自动转发关联和后台；只让新进程轮询该 token。

`--check` 和 `--migrate-only` 不向频道发消息。正常启动会恢复队列并继续自动补档。首次线上收发仍需在切换后验证。

回滚时先停止 Deno；使用 drop-in 切换的服务，移除 `20-deno.conf` 并执行 `systemctl daemon-reload` 即可恢复原 Go 启动命令。代码可切回归档分支并使用旧二进制。如果需要恢复首次迁移备份，须评估切换后已成功发送的消息，不能直接丢弃新发送记录后重跑，否则可能重复发送。额外队列表不会被 Go 使用。

## 发送结果不确定

Telegram 消息发送与 SQLite 写入无法组成同一个事务。如果网络断开或进程在发送后、记录前退出，系统无法证明消息未发送。此时文件记录保留 `sending`/`uncertain`（频道发帖使用 `suppbot_meta` 的 `channel-send:<supp_id>`），暂停自动重发。HTTP 429 等明确拒绝按限流提示重试。

遇到待核对记录，先检查实际频道/群消息，再离线修复对应的消息 ID、文件 ID 和状态。确认已发送则标记 success；明确未发送才改回 failed/pending。频道消息需补齐 `supps.channel_chat_id`/`channel_id` 并将对应 meta 标记 sent，或在确认未发送后标记 failed。最后通过后台重新入队。直接重新入队不会绕过这项保护。
