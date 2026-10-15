// בנייה פשוטה לאתר סטטי: אריזת מודולי JS (כולל @hebcal/core ו-supabase-js) והעתקת קבצים ל-dist/
import { build } from 'esbuild';
import { cp, mkdir, rm, readdir } from 'node:fs/promises';

const out = 'dist';
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/assets`, { recursive: true });

const pages = (await readdir('web/js/pages')).filter((f) => f.endsWith('.js'));
await build({
  entryPoints: pages.map((p) => `web/js/pages/${p}`),
  outdir: `${out}/assets`,
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  target: ['es2020', 'safari14'],
  chunkNames: 'chunks/[name]-[hash]',
  legalComments: 'none',
  logLevel: 'info',
});

for (const f of await readdir('web')) {
  if (f.endsWith('.html') || f === 'config.js') await cp(`web/${f}`, `${out}/${f}`);
}
await cp('web/css', `${out}/css`, { recursive: true });
await cp('web/assets', `${out}/assets`, { recursive: true });
// GitHub Pages: ללא עיבוד Jekyll
await cp('web/.nojekyll', `${out}/.nojekyll`).catch(() => {});
console.log('build ok ->', out);
