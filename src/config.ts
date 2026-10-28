import { resolve } from 'node:path';
import { parse } from 'smol-toml';

export interface Config {
  botToken: string;
  apiRoot: string;
  database: string;
  channelId: number;
  groupId: number;
  videoChannelId: number;
  qbit: { host: string; username: string; password: string };
  page: number;
  concurrency: number;
  crawlIntervalMs: number;
  taskTimeoutMs: number;
  linkedMessageTimeoutMs: number;
  maxAttempts: number;
  adminListen: string;
  adminBasePath: string;
}

export function loadConfig(args = Deno.args, env = Deno.env.toObject()): Config {
  const arg = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return args.find((v) => v.startsWith(name + '='))?.slice(name.length + 1) ??
      (index >= 0 ? args[index + 1] : undefined);
  };
  const raw = parse(
    Deno.readTextFileSync(
      arg('--config') ?? env.SUPPBOT_CONFIG ??
        (args.includes('-test') ? 'config/config-test.toml' : 'config/config.toml'),
    ),
  );
  const string = (v: unknown, name: string): string => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Missing configuration: ${name}`);
    return v.trim();
  };
  const integer = (v: unknown, name: string, positive = false): number => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n === 0 || (positive && n < 1)) {
      throw new Error(`Invalid configuration: ${name}`);
    }
    return n;
  };
  const q = raw.qbit as Record<string, unknown> | undefined;
  if (!q) throw new Error('Missing qbit configuration');
  return {
    botToken: string(raw['bot-token'], 'bot-token'),
    apiRoot: string(raw['base-url'], 'base-url').replace(/\/$/, ''),
    database: resolve(string(raw.database, 'database')),
    channelId: integer(raw['channel-id'], 'channel-id'),
    groupId: integer(raw['group-id'], 'group-id'),
    videoChannelId: integer(raw['video-channel-id'], 'video-channel-id'),
    qbit: {
      host: string(q.host, 'qbit.host').replace(/\/$/, ''),
      username: string(q.username, 'qbit.username'),
      password: string(q.password, 'qbit.password'),
    },
    page: integer(arg('--page') ?? arg('-page') ?? 1, 'page', true),
    concurrency: integer(raw['max-concurrent'] ?? 2, 'max-concurrent', true),
    crawlIntervalMs: integer(raw['crawl-interval-seconds'] ?? 7200, 'crawl-interval-seconds', true) * 1000,
    taskTimeoutMs: integer(raw['task-timeout-seconds'] ?? 72000, 'task-timeout-seconds', true) * 1000,
    linkedMessageTimeoutMs:
      integer(raw['linked-message-timeout-seconds'] ?? 300, 'linked-message-timeout-seconds', true) * 1000,
    maxAttempts: integer(raw['max-attempts'] ?? 3, 'max-attempts', true),
    adminListen: env.SUPPBOT_ADMIN_LISTEN ?? '127.0.0.1:9001',
    adminBasePath: '/suppbot',
  };
}
