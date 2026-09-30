import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
export type LocalFile = { path: string; name: string; size: number; sha256: string };
export const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export function safeName(name: string): string {
  const chars = Array.from(basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_'));
  while (Buffer.byteLength(chars.join('')) > 180) chars.shift();
  return chars.join('') || 'file.bin';
}
export function saveMedia(home: string, bucket: 'inbound' | 'outbound', name: string, data: Buffer): LocalFile {
  if (data.length > MAX_MEDIA_BYTES) throw new Error('文件超过 100 MiB');
  const dir = join(home, 'media', bucket);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileName = safeName(name), path = join(dir, `${randomUUID()}-${fileName}`);
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  return { path, name: fileName, size: data.length, sha256: digest(data) };
}
export function readLocalFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('只能发送普通文件');
    if (stat.size > MAX_MEDIA_BYTES) throw new Error('文件超过 100 MiB');
    const data = Buffer.alloc(stat.size + 1);
    let size = 0, count: number;
    while (size < data.length && (count = readSync(fd, data, size, data.length - size, null))) size += count;
    if (size !== stat.size) throw new Error('文件读取期间大小发生变化，请重试');
    return data.subarray(0, size);
  } finally { closeSync(fd); }
}
export function snapshotFile(home: string, path: string, cwd: string): LocalFile {
  path = resolve(cwd, path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
  return saveMedia(home, 'outbound', basename(path), readLocalFile(path));
}
export const fileInstructions = '\n\n[微信文件回传]\n仅当用户需要接收文件时，在最终回复单独写一行 WCODE_FILE: /文件的绝对路径（不加引号，最多 3 个文件，每个不超过 100 MiB）。不要将文件内容编码到回复中。';
export function returnedFiles(text: string): { text: string; paths: string[] } {
  const paths: string[] = [], lines: string[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && line.match(/^WCODE_FILE:\s*(\/[^\r\n]+)\s*$/);
    if (match) paths.push(match[1].trim()); else lines.push(line);
  }
  return { text: lines.join('\n').trim(), paths: [...new Set(paths)] };
}
