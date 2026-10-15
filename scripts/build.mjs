// בנייה פשוטה לאתר סטטי: אריזת מודולי JS (כולל @hebcal/core ו-supabase-js) והעתקת קבצים ל-dist/
import { build } from 'esbuild';
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';

const out = 'dist';
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/assets`, { recursive: true });

const pages = (await readdir('web/js/pages')).filter((f) => f.endsWith('.js'));

// גיבוי: ערכי config.js נארזים גם בתוך ה-JS, למקרה שהקובץ הנפרד לא נטען (cache, חוסם תוכן וכו')
const cfgSrc = await readFile('web/config.js', 'utf8');
const pick = (k) => (new RegExp(`${k}:\\s*'([^']*)'`).exec(cfgSrc) || [])[1] || '';
const bundledConfig = { SUPABASE_URL: pick('SUPABASE_URL'), SUPABASE_PUBLISHABLE_KEY: pick('SUPABASE_PUBLISHABLE_KEY') };
const version = Date.now().toString(36);
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
  define: { __BUNDLED_CONFIG__: JSON.stringify(bundledConfig) },
  logLevel: 'info',
});

for (const f of await readdir('web')) {
  if (f === 'config.js') await cp(`web/${f}`, `${out}/${f}`);
  if (f.endsWith('.html')) {
    // מניעת גרסאות ישנות מה-cache: מספר גרסה בכל קישור לקבצים
    const html = (await readFile(`web/${f}`, 'utf8'))
      .replace(/(src|href)="\.\/(config\.js|css\/app\.css|assets\/[a-z]+\.js)"/g, `$1="./$2?v=${version}"`);
    await writeFile(`${out}/${f}`, html);
  }
}
await cp('web/css', `${out}/css`, { recursive: true });
await cp('web/assets', `${out}/assets`, { recursive: true });
// GitHub Pages: ללא עיבוד Jekyll
await cp('web/.nojekyll', `${out}/.nojekyll`).catch(() => {});
console.log('build ok ->', out);
