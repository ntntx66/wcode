import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const LOG_BACKUPS = 3;
export function rotateLog(path: string, limit = MAX_LOG_BYTES, backups = LOG_BACKUPS): boolean {
  // launchd keeps an open descriptor: copy/truncate preserves that descriptor after rotation.
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('日志必须为普通文件');
    fchmodSync(fd, 0o600);
    const size = fstatSync(fd).size;
    if (size <= limit) return false;
    try { unlinkSync(`${path}.${backups}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    for (let i = backups - 1; i >= 1; i--) {
      try { renameSync(`${path}.${i}`, `${path}.${i + 1}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const tail = Buffer.alloc(Math.min(size, limit));
    let count = 0;
    while (count < tail.length) {
      const read = readSync(fd, tail, count, tail.length - count, size - tail.length + count);
      if (!read) break;
      count += read;
    }
    const backup = openSync(`${path}.1`, 'wx', 0o600);
    try { writeFileSync(backup, tail.subarray(0, count)); } finally { closeSync(backup); }
    // Writers in this process cannot interleave with this synchronous block.
    ftruncateSync(fd, 0);
    return true;
  } finally { closeSync(fd); }
}
export function startLogRotation(home: string, log = console.error): () => void {
  const dir = join(home, 'logs'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error('日志目录不能是符号链接或其他文件类型');
  const rotate = () => {
    for (const name of ['stdout.log', 'stderr.log']) {
      try { rotateLog(join(dir, name)); } catch (e) { log(`日志轮转失败：${e}`); }
    }
  };
  rotate(); const timer = setInterval(rotate, 30_000); timer.unref();
  return () => clearInterval(timer);
}
