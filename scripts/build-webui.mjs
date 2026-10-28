/**
 * 面板 bundle：src/webui/client.ts → dist/webui.js
 * 只 import type 框架，编译期擦除，产物自包含；服务端给它分配 URL。
 * esbuild 直接取 Coopanion 安装目录里的那份，避免再装依赖。
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COOPANION_APP = 'D:/coopanion/resources/app/package.json';
const require = createRequire(COOPANION_APP);
const esbuild = require('esbuild');

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = `${root}dist`;

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [{ in: `${root}src/webui/client.ts`, out: 'webui' }],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  sourcemap: true,
  metafile: true,
});

for (const [path, info] of Object.entries(result.metafile.outputs)) {
  if (path.endsWith('.map')) continue;
  console.log(`${path.replace(/\\/g, '/')}  ${(info.bytes / 1024).toFixed(1)} KB`);
}
