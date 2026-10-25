import { packager } from '@electron/packager';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const releaseDir = path.resolve('../app/releases', version);
const hash = createHash('sha256');
async function fingerprint(dir) {
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Build inputs must not be symbolic links');
    if (entry.isDirectory()) await fingerprint(file);
    else { hash.update(file.replaceAll('\\', '/') + '\0'); hash.update(await fs.readFile(file)); }
  }
}
await fingerprint('dist');
for (const file of ['package.json', 'package-lock.json', 'scripts/package.mjs']) { hash.update(file); hash.update(await fs.readFile(file)); }
const digest = hash.digest('hex');
const marker = path.join(releaseDir, 'build.sha256');
try {
  await fs.access(releaseDir);
  if ((await fs.readFile(marker, 'utf8')).trim() !== digest) throw new Error(`Release ${version} contains another build. Bump the version; existing files were preserved.`);
  await fs.access(path.join(releaseDir, 'LocalCode-win32-x64/LocalCode.exe'));
  await fs.writeFile('../app/current.txt', `releases\\${version}\\LocalCode-win32-x64\r\n`);
  console.log('Identical release already packaged. Reused existing build.');
  process.exit(0);
} catch (error) { if (error.code !== 'ENOENT') throw error; if (await fs.stat(releaseDir).catch(() => undefined)) throw new Error('Incomplete release preserved. Choose a new version or inspect it manually.'); }
const electronVersion = JSON.parse(await fs.readFile('node_modules/electron/package.json', 'utf8')).version;
const folders = await packager({ dir: '.', electronVersion, name: 'LocalCode', executableName: 'LocalCode', platform: 'win32', arch: 'x64', out: releaseDir, overwrite: false, prune: true, asar: false, download: { cacheRoot: path.resolve('../cache/electron') }, tmpdir: path.resolve('../cache/packager'), ignore: file => { const relative = file.replaceAll('\\', '/').replace(/^\//, ''); return !!relative && !['dist', 'node_modules', 'package.json', 'LICENSE'].includes(relative.split('/')[0]); }, appVersion: version, appCopyright: 'LocalCode contributors', win32metadata: { CompanyName: 'LocalCode', FileDescription: 'LocalCode 本地编程助手', ProductName: 'LocalCode' } });
const relative = path.relative(path.resolve('../app'), path.resolve(folders[0]));
await fs.writeFile(marker, digest + '\n', { flag: 'wx' });
if (relative.startsWith('..') || path.isAbsolute(relative) || /[\r\n"]/.test(relative)) throw new Error('Invalid installed release path');
if (process.env.LOCALCODE_DEFER_ACTIVATION !== '1') await fs.writeFile('../app/current.txt', relative + '\r\n', 'utf8');
console.log(folders.join('\n'));
