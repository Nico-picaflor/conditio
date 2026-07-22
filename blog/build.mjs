// ─────────────────────────────────────────────────────────────────────────
// Conditio blog — static multilingual generator
//
// Source of truth:  blog/i18n/<slug>.json      (one object per language)
// Template:         blog/article-*.html         (the pristine English master)
//
// For every article it emits one physical, fully-baked page per target
// language so Googlebot indexes real translated HTML (not JS-injected text):
//
//   English (canonical):  /blog/<slug>.html          (master, in place)
//   Localized:            /<lang>/blog/<slug>.html
//
// Each page gets: <html lang>, translated <title>/<meta description>/OG tags,
// a full hreflang cluster + self-canonical + x-default, and the interactive
// language switcher is preserved (T is re-injected from the JSON).
//
// Run:  node blog/build.mjs
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';

const BLOG = import.meta.dirname;          // …/conditio-landing/blog
const ROOT = dirname(BLOG);                // …/conditio-landing
const I18N = join(BLOG, 'i18n');
const SITE = 'https://conditio.org';

// Languages we generate physical, SEO-indexed pages for. Only add a language
// here once it is FULLY translated in the JSON (body + title + meta) — a page
// that is English-under-a-foreign-tag hurts SEO. The client switcher still
// offers every language present in the JSON regardless of this list.
const EMIT = ['en', 'es', 'fr', 'de', 'it', 'pt'];
const OG_LOCALE = { en: 'en_US', es: 'es_ES', fr: 'fr_FR', de: 'de_DE', it: 'it_IT', pt: 'pt_PT' };

const pathFor = (lang, slug) => (lang === 'en' ? `/blog/${slug}.html` : `/${lang}/blog/${slug}.html`);
const ymd = (p) => new Date(statSync(p).mtime).toISOString().slice(0, 10);   // YYYY-MM-DD for <lastmod>

// ── small helpers ──────────────────────────────────────────────────────────
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');
const stripTags = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '') + '…';
}

// title/meta: use explicit JSON keys if the author added them, else derive
// from the already-translated h1 / sub.
function titleFor(t) {
  if (t.title) return t.title;
  const h1 = stripTags(t.h1 || '');
  const head = (h1.split(/[:：]/)[0] || h1).trim();
  return `${head} | Conditio`;
}
function descFor(t) {
  if (t.metaDesc) return t.metaDesc;
  return truncate(stripTags(t.sub || t.intro || ''), 158);
}

// Replace the inner content of the element carrying id="ID". Relies on the
// fact that no id'd element in these articles nests a tag of its own name.
function setInner(html, id, value) {
  const marker = `id="${id}"`;
  const at = html.indexOf(marker);
  if (at === -1) return html;                       // id not in this article
  const openLt = html.lastIndexOf('<', at);
  const tag = (html.slice(openLt + 1).match(/^([a-zA-Z0-9]+)/) || [])[1];
  if (!tag) return html;
  const openGt = html.indexOf('>', at);
  const closeAt = html.indexOf(`</${tag}>`, openGt);
  if (openGt === -1 || closeAt === -1) return html;
  return html.slice(0, openGt + 1) + value + html.slice(closeAt);
}

// Bake one language's text into the body, mirroring the page's own L():
//   h1  → innerHTML,  chk (array) → <li> list,  everything else → textContent.
function bakeBody(html, t) {
  for (const [key, val] of Object.entries(t)) {
    if (key === 'title' || key === 'metaDesc') continue;
    if (key === 'h1') html = setInner(html, key, val);
    else if (Array.isArray(val)) html = setInner(html, key, val.map((i) => `<li>${i}</li>`).join(''));
    else html = setInner(html, key, escHtml(val));
  }
  return html;
}

function injectTranslations(html, T) {
  const s = html.indexOf('const T={');
  const e = html.indexOf('function L(');
  if (s === -1 || e === -1) throw new Error('could not locate T / L block');
  return html.slice(0, s) + 'const T=' + JSON.stringify(T) + ';\n' + html.slice(e);
}

function seoBlock(lang, slug, title, desc) {
  const lines = [
    '<!-- i18n:seo:start -->',
    `<link rel="canonical" href="${SITE}${pathFor(lang, slug)}"/>`,
    ...EMIT.map((L) => `<link rel="alternate" hreflang="${L}" href="${SITE}${pathFor(L, slug)}"/>`),
    `<link rel="alternate" hreflang="x-default" href="${SITE}${pathFor('en', slug)}"/>`,
    '<meta property="og:type" content="article"/>',
    `<meta property="og:title" content="${escAttr(title)}"/>`,
    `<meta property="og:description" content="${escAttr(desc)}"/>`,
    `<meta property="og:url" content="${SITE}${pathFor(lang, slug)}"/>`,
    `<meta property="og:locale" content="${OG_LOCALE[lang]}"/>`,
    '<meta name="twitter:card" content="summary_large_image"/>',
    '<!-- i18n:seo:end -->',
  ];
  return lines.join('\n');
}

function render(tpl, lang, slug, T) {
  const t = T[lang];
  const isEn = lang === 'en';
  const title = titleFor(t);
  const desc = descFor(t);

  let html = injectTranslations(tpl, T);
  html = html.replace(/<html[^>]*>/, `<html lang="${lang}"${lang === 'ar' ? ' dir="rtl"' : ''}>`);

  if (!isEn) {
    html = bakeBody(html, t);
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escHtml(title)}</title>`);
    html = html.replace(/(<meta name="description" content=")[^"]*(")/, `$1${escAttr(desc)}$2`);
    // Default a localized page to its own language (honouring an explicit
    // user choice saved earlier) instead of the visitor's browser language.
    html = html.replace(
      /const initLang\s*=\s*detectLang\(\);/,
      `const initLang=(function(){var s=localStorage.getItem('conditio_lang');return (s&&T[s])?s:${JSON.stringify(lang)};})();`
    );
  }

  // (re)insert the SEO block right before </head>
  html = html.replace(/\n?[ \t]*<!-- i18n:seo:start -->[\s\S]*?<!-- i18n:seo:end -->/, '');
  html = html.replace('</head>', seoBlock(lang, slug, title, desc) + '\n</head>');
  return html;
}

// ── run ─────────────────────────────────────────────────────────────────────
const articles = readdirSync(BLOG).filter((f) => /^article-.*\.html$/.test(f)).sort();
const sitemap = [];

for (const file of articles) {
  const slug = basename(file, '.html');
  const tpl = readFileSync(join(BLOG, file), 'utf8');
  const T = JSON.parse(readFileSync(join(I18N, `${slug}.json`), 'utf8'));

  for (const lang of EMIT) {
    if (!T[lang]) { console.warn(`  ! ${slug}: missing "${lang}" in JSON — skipped`); continue; }
    const out = render(tpl, lang, slug, T);
    const dest = lang === 'en' ? join(BLOG, file) : join(ROOT, lang, 'blog', file);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out);
  }

  sitemap.push({ slug, langs: EMIT.filter((l) => T[l]), lastmod: ymd(join(BLOG, file)) });
  console.log(`✓ ${slug}  →  ${EMIT.join(', ')}`);
}

// ── sitemap.xml with hreflang alternates ────────────────────────────────────
const urls = [];
// homepage
const homeLastmod = existsSync(join(ROOT, 'index.html')) ? ymd(join(ROOT, 'index.html')) : ymd(BLOG);
urls.push(`  <url>\n    <loc>${SITE}/</loc>\n    <lastmod>${homeLastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>`);
for (const { slug, langs, lastmod } of sitemap) {
  for (const lang of langs) {
    const alts = langs
      .map((L) => `    <xhtml:link rel="alternate" hreflang="${L}" href="${SITE}${pathFor(L, slug)}"/>`)
      .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${pathFor('en', slug)}"/>`)
      .join('\n');
    urls.push(`  <url>\n    <loc>${SITE}${pathFor(lang, slug)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n${alts}\n  </url>`);
  }
}
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
writeFileSync(join(ROOT, 'sitemap.xml'), xml);
console.log(`\n✓ sitemap.xml  →  ${urls.length} URLs`);
