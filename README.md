# suppbot

Deno + TypeScript + grammY 实现的 Telegram 自动补档机器人。负责抓取文章、下载磁链、处理视频、上传文件及提供管理后台。用户搜索功能留待后续实现。

## 运行

需要 Deno 2.9+、FFmpeg（含 ffprobe、libx264、drawtext）和 `rar`。

```sh
cp config/config-template.toml config/config.toml
# 编辑 bot token、Telegram 本地 API、频道/群组和 qBittorrent 配置
# 从仓库根目录执行所有任务
deno task check
deno task test
deno task lint
deno task start --check
deno task start
```

`--check` 只读检查配置与现有 SQLite 完整性，不登录任何服务、不迁移数据库；数据库尚未创建时，直接启动即可。

依赖固定在 `deno.json` 与 `deno.lock`。首次运行会缓存依赖。执行权限只允许 `ffmpeg`、`ffprobe`、`rar` 三个外部程序；文件、网络、环境变量权限用于已有配置指定的数据库、媒体路径和本地 API。测试没有网络权限，使用临时数据库和模拟 Telegram 请求。

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
- `src/media.ts`：文件打包、视频转码、音频转换、九宫格截图。
- `src/runtime.ts`、`src/admin.ts`：实时快照和管理页面。

抓取发现的文章先入库排队，不再因并发满而丢弃。每个 worker 同时处理一个 torrent，避免单篇文章启动大量转码。临时错误按退避策略重试，达到上限后标记 error。每次尝试都有整体时限，关联群消息另有较短等待时限。退出信号贯穿下载轮询、转码、API 请求与等待；中断任务重新排队且不消耗重试次数。

关联群消息先持久化，再绑定频道消息，因此支持早到、重复消息及重启恢复。已有频道消息不会因为缺少群消息而重新发帖。成功文件及因大小限制跳过的视频保持原有去重规则。后台标记为 done 是人工确认，不执行文件上传。

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
