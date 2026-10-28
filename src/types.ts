export interface Article {
  url: string;
  title: string;
  author: string;
  postTime: string;
  imgUrl: string;
  category: string;
  tags: string[];
}

export interface Supp {
  id: number;
  article_url_path: string;
  created_at: string;
  updated_at: string;
  channel_chat_id: number;
  channel_id: number;
  linked_group_chat_id: number;
  linked_group_id: number;
  magnets: string;
  status: string;
}

export interface TorrentRecord {
  id: number;
  supp_id: number;
  hash: string;
  status: string;
  error: string;
}
export interface SendRecord {
  id: number;
  torrent_id: number;
  source_path: string;
  send_type: string;
  file_name: string;
  status: string;
  error: string;
  file_id: string;
  file_unique_id: string;
  channel_chat_id: number;
  channel_message_id: number;
  group_chat_id: number;
  group_message_id: number;
}
export interface Job {
  supp_id: number;
  article_json: string | null;
  state: string;
  attempts: number;
  available_at: number;
  error: string;
}
export interface Torrent {
  hash: string;
  infohash_v1?: string;
  name: string;
  content_path: string;
  progress: number;
  state: string;
  downloaded: number;
  total_size: number;
  dlspeed: number;
  eta: number;
  num_seeds: number;
}

export const hashes = (
  value: string,
): string[] => [...new Set(value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean))];
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const escapeHTML = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export class VideoRejectedError extends Error {}
