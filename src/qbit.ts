import type { Torrent } from './types.ts';

export class QbitClient {
  private cookie = '';
  private loginPromise?: Promise<void>;
  private cached?: { at: number; torrents: Torrent[] };
  private refreshing?: Promise<Torrent[]>;
  constructor(private config: { host: string; username: string; password: string }) {}
  async login(signal: AbortSignal): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const response = await fetch(`${this.config.host}/api/v2/auth/login`, {
        method: 'POST',
        body: new URLSearchParams({ username: this.config.username, password: this.config.password }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      const text = await response.text();
      if (!response.ok || (text !== '' && text.trim() !== 'Ok.')) {
        throw new Error(`qBittorrent login failed (${response.status})`);
      }
      this.cookie = response.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
    })();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = undefined;
    }
  }
  private async request(
    path: string,
    signal: AbortSignal,
    body?: URLSearchParams,
    relogin = true,
  ): Promise<Response> {
    if (!this.cookie) await this.login(signal);
    const response = await fetch(this.config.host + path, {
      method: body ? 'POST' : 'GET',
      body,
      headers: { Cookie: this.cookie },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (response.status === 403 && relogin) {
      await response.body?.cancel();
      await this.login(signal);
      return this.request(path, signal, body, false);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`qBittorrent ${path}: HTTP ${response.status}`);
    }
    return response;
  }
  async torrents(signal: AbortSignal, fresh = false): Promise<Torrent[]> {
    if (!fresh && this.cached && Date.now() - this.cached.at < 5000) return this.cached.torrents;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const response = await this.request('/api/v2/torrents/info', signal);
      const torrents = await response.json() as Torrent[];
      this.cached = { at: Date.now(), torrents };
      return torrents;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  async add(hashes: string[], signal: AbortSignal): Promise<void> {
    const existing = new Set(
      (await this.torrents(signal, true)).flatMap(
        (t) => [t.hash.toLowerCase(), t.infohash_v1?.toLowerCase()],
      ),
    );
    const missing = hashes.filter((h) => !existing.has(h.toLowerCase()));
    if (!missing.length) return;
    const response = await this.request(
      '/api/v2/torrents/add',
      signal,
      new URLSearchParams({ urls: missing.map((h) => `magnet:?xt=urn:btih:${h}`).join('\n') }),
    );
    const text = await response.text();
    if (text.trim() !== 'Ok.') {
      let valid = false;
      try {
        const result = JSON.parse(text);
        valid = result.failure_count === 0 && result.success_count + result.pending_count > 0;
      } catch { /* Legacy text response. */ }
      if (!valid) throw new Error('qBittorrent rejected torrent addition');
    }
    this.cached = undefined;
  }
}
