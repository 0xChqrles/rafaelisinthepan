// Bundles the Fargate entry (src/main.ts) into dist/main.mjs: our own TypeScript and
// @whippin/shared inlined, every npm dependency left external (baileys, pino and the AWS
// SDK are installed in the image by pnpm, exactly as the lockfile pins them).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@whippin/'));

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'inline',
  external,
  banner: {
    // The ESM bundle still meets a CommonJS `require` in a few dependencies' transitive
    // imports; give it one.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
