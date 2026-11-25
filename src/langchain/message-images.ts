import type { BaseMessage } from '@langchain/core/messages';
import { isMime, type Mime } from '../library.ts';
import { decode, ref } from '../core/images.ts';

export type ImageResolver = (url: string, signal?: AbortSignal) => Promise<{ mimeType: Mime; data: Uint8Array }>;
export interface SavedImage { name: string; mimeType: Mime; data: string }
/** Content addressing keeps references stable across history refreshes and checkpoints. */
function nameOf(mime: string, data: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${mime}:${data}`)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
export function messageImages(message: BaseMessage): { content: BaseMessage['content']; images: (SavedImage | { name: string; url: string })[] } {
  const images: (SavedImage | { name: string; url: string })[] = [];
  if (typeof message.content === 'string') return { content: message.content, images };
  const content = message.content.map(block => {
    if (block.type !== 'image_url' && block.type !== 'image') return block;
    const value = block as Record<string, unknown>;
    let data: unknown, mime: unknown;
    const source = value.source && typeof value.source === 'object' ? value.source as Record<string, unknown> : undefined;
    if (block.type === 'image_url' || value.url !== undefined || source?.type === 'url') {
      const url = block.type === 'image_url' ? (typeof value.image_url === 'string' ? value.image_url : (value.image_url as { url?: unknown })?.url) : value.url ?? source?.url;
      const match = typeof url === 'string' && /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
      if (!match) {
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('OptChat image URL must be an inline data URI or HTTP(S) URL.');
        const name = nameOf('url', url);
        images.push({ name, url });
        return { type: 'text' as const, text: ref(name) };
      }
      [, mime, data] = match;
    } else {
      data = value.data ?? value.base64;
      mime = value.mimeType ?? value.mime_type;
      if (source) {
        data = source.data; mime = source.media_type;
      }
    }
    if (typeof data !== 'string' || typeof mime !== 'string' || !isMime(mime)) throw new Error('OptChat image content requires base64 data and a supported PNG, JPEG, GIF or WebP MIME type.');
    let canonical: string;
    try { decode(data); canonical = data.replace(/[\t\n\f\r ]/g, '').replace(/=+$/, ''); canonical += '='.repeat((4 - canonical.length % 4) % 4); }
    catch { throw new Error('OptChat image content contains invalid base64 data.'); }
    const name = nameOf(mime, canonical);
    images.push({ name, mimeType: mime, data: canonical });
    return { type: 'text' as const, text: ref(name) };
  });
  return { content, images };
}
