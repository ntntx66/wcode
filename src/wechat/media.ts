// Protocol adapted from @tencent-weixin/openclaw-weixin 2.4.9 (MIT).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { record } from '../config.ts';
import { digest, MAX_MEDIA_BYTES, readLocalFile, saveMedia } from '../files.ts';
import type { LocalFile } from '../files.ts';
import type { Ilink } from './ilink.ts';

export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
export type Attachment = { kind: 'image' | 'file'; item: Record<string, unknown> };
export type Downloaded = LocalFile & { kind: 'image' | 'file' };
export type FileItem = { type: 4; file_item: { media: { encrypt_query_param: string; aes_key: string; encrypt_type: 1 }; file_name: string; len: string } };
export function cdnUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.port || url.username || url.password)
    throw new Error('不可信的微信 CDN 地址');
  return url;
}
export function aesKey(base64: string): Buffer {
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-f0-9]{32}$/i.test(decoded.toString())) return Buffer.from(decoded.toString(), 'hex');
  throw new Error('无效的媒体 AES 密钥');
}
export function imageExtension(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return '.gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return '.webp';
}
async function boundedBody(response: Response): Promise<Buffer> {
  const max = MAX_MEDIA_BYTES + 16;
  if (!response.ok || Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw new Error(response.ok ? '媒体超过 100 MiB' : `CDN HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('CDN 响应为空');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error('媒体超过 100 MiB');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
export async function download(attachment: Attachment, home: string, signal: AbortSignal, fetcher = fetch): Promise<Downloaded> {
  signal.throwIfAborted();
  const { item, kind } = attachment, media = record(item.media);
  const full = typeof media.full_url === 'string' && media.full_url.trim();
  const param = typeof media.encrypt_query_param === 'string' && media.encrypt_query_param;
  if (!full && !param) throw new Error('媒体缺少 CDN 下载信息');
  let key: Buffer | undefined;
  if (kind === 'image' && typeof item.aeskey === 'string' && item.aeskey) {
    if (!/^[a-f0-9]{32}$/i.test(item.aeskey)) throw new Error('无效的图片 AES 密钥');
    key = Buffer.from(item.aeskey, 'hex');
  } else if (typeof media.aes_key === 'string' && media.aes_key) key = aesKey(media.aes_key);
  if (kind === 'file' && !key) throw new Error('文件缺少 AES 密钥');
  if (item.len !== undefined && (!/^\d+$/.test(String(item.len)) || Number(item.len) > MAX_MEDIA_BYTES)) throw new Error('文件长度无效或超过 100 MiB');
  const url = cdnUrl(full || `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(param || '')}`);
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
  let data = await boundedBody(response);
  if (key) {
    try { const decipher = createDecipheriv('aes-128-ecb', key, null); data = Buffer.concat([decipher.update(data), decipher.final()]); }
    catch { throw new Error('媒体 AES 解密失败'); }
  }
  if (kind === 'file' && item.len !== undefined && Number(item.len) !== data.length) throw new Error('下载文件长度不符');
  if (typeof item.md5 === 'string' && item.md5 && createHash('md5').update(data).digest('hex') !== item.md5.toLowerCase()) throw new Error('下载文件 MD5 不符');
  const extension = imageExtension(data);
  if (kind === 'image' && !extension) throw new Error('图片格式不支持（支持 PNG、JPEG、GIF、WebP）');
  signal.throwIfAborted();
  return { ...saveMedia(home, 'inbound', kind === 'image' ? `image${extension}` : String(item.file_name || 'file.bin'), data), kind };
}
export async function upload(file: LocalFile, api: Pick<Ilink, 'request' | 'auth' | 'fetcher'>, signal?: AbortSignal): Promise<FileItem> {
  signal?.throwIfAborted();
  const data = readLocalFile(file.path);
  if (data.length !== file.size || digest(data) !== file.sha256) throw new Error('待发送文件快照已改变');
  const key = randomBytes(16), filekey = randomBytes(16).toString('hex');
  const cipher = createCipheriv('aes-128-ecb', key, null), ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const result = await api.request<{ upload_full_url?: string; upload_param?: string }>('getuploadurl', {
    filekey, media_type: 3, to_user_id: api.auth.ownerId, rawsize: data.length,
    rawfilemd5: createHash('md5').update(data).digest('hex'), filesize: ciphertext.length, no_need_thumb: true, aeskey: key.toString('hex'),
  }, signal);
  if (!result.upload_full_url?.trim() && !result.upload_param) throw new Error('微信未返回上传地址');
  const url = cdnUrl(result.upload_full_url?.trim() || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(result.upload_param!)}&filekey=${filekey}`);
  const response = await api.fetcher(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext), signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`CDN 上传 HTTP ${response.status}`);
  const param = response.headers.get('x-encrypted-param');
  if (!param) throw new Error('CDN 上传响应缺少下载参数');
  return { type: 4, file_item: { media: { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }, file_name: file.name, len: String(data.length) } };
}
