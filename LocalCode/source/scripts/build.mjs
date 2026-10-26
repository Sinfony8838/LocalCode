import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
await fs.mkdir('dist', { recursive: true });
await fs.copyFile('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
for (const name of ['codex', 'opencode']) {
  const target = `dist/licenses/${name}`; await fs.mkdir(target, { recursive: true });
  for (const file of await fs.readdir(`third_party/${name}`)) if (/^(LICENSE|NOTICE)/i.test(file)) await fs.copyFile(`third_party/${name}/${file}`, `${target}/${file}`);
}
await fs.cp('skills/create-desktop-pet', 'dist/skills/create-desktop-pet', { recursive: true });
await build({ entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', packages: 'external', sourcemap: true });
await build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['src/main/pet-bridge.ts'], outfile: 'dist/pet-preload.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['src/agent/worker.ts'], outfile: 'dist/worker.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external', sourcemap: true });
await viteBuild({ root: 'src/renderer', base: './', build: { outDir: '../../dist/renderer', emptyOutDir: true, rollupOptions: { input: { main: path.resolve('src/renderer/index.html'), pet: path.resolve('src/renderer/pet.html') } } }, esbuild: { jsx: 'automatic' } });
