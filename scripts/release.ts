import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInstalled } from './verify-installed.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'wcode-release-'));
const npm = (args: string[]) => {
  const result = spawnSync('npm', args, { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} 失败：${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
try {
  // The release command already checked and built once; avoid rerunning prepack.
  const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp])) as
    { filename: string; files: { path: string }[] }[];
  const paths = packed.files.map(file => file.path).sort();
  const allowed = /^(dist\/.*\.js|docs\/.*\.md|package\.json|README\.md|THIRD_PARTY_NOTICES\.md)$/;
  assert.ok(paths.every(path => allowed.test(path)), '安装包包含白名单之外的文件');
  const sourceFiles = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .filter(path => path.endsWith('.ts') && !path.endsWith('.d.ts'));
  assert.deepEqual(paths.filter(path => path.startsWith('dist/')), sourceFiles.map(path => `dist/${path.replace(/\.ts$/, '.js')}`).sort());
  const archive = join(temp, packed.filename), prefix = join(temp, 'install');
  npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  await verifyInstalled(join(prefix, 'lib', 'node_modules', 'wcode'));
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const output = join(root, 'artifacts', 'release', version);
  mkdirSync(output, { recursive: true });
  const destination = join(output, packed.filename);
  copyFileSync(archive, destination);
  const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
  writeFileSync(`${destination}.sha256`, `${sha256}  ${packed.filename}\n`);
  console.log(`已验证安装包：${relative(root, destination)}\nSHA-256：${sha256}`);
} finally { rmSync(temp, { recursive: true, force: true }); }
