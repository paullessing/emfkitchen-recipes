#!/usr/bin/env node
/*
 * build.js - regenerate EMF Kitchen recipe cards from Markdown sources.
 *
 * Pure Node, no npm install. PDF uses a Chromium already on your machine
 * (Microsoft Edge ships with Windows, so it works out of the box); if none is
 * found it falls back to a Docker container.
 *
 * USAGE
 *   node build.js [filter] [options]
 *
 *   filter        optional substring; only recipes whose path matches are built
 *
 * OUTPUTS (choose any combination; default = individual HTML for both versions)
 *   --html            individual HTML cards            (default on)
 *   --pdf             individual PDF per card
 *   --combined-html   one scrollable HTML with every card
 *   --combined-pdf    one PDF with every card
 *   --all             = --html --pdf --combined-html --combined-pdf
 *
 * WHICH VERSION
 *   --catering        kitchen copy: 150-scale amounts only        -> Recipes/catering/
 *   --home            dual copy: home amount first, catering muted -> Recipes/home/
 *   (omit both = build both versions)
 *
 * PATHS
 *   --src <dir>       Markdown sources        (default ./src)
 *   --out <dir>       output root             (default .)
 *
 * EXAMPLES
 *   node build.js                     rebuild every HTML card, both versions
 *   node build.js --pdf               ...and a PDF for each
 *   node build.js --combined-pdf      the single "All Recipes" PDF
 *   node build.js "Tarka Dal" --pdf   just one recipe
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { pathToFileURL } = require('url');

// ============================ CONFIG ============================
// Edit these defaults to change the output layout. The base output
// directory and the source directory can also be overridden on the
// command line (--out / --src), which take precedence over these.
const OUTPUT_DIR    = '.';         // base output directory (default; --out overrides)
const SOURCE_DIR    = 'src';       // markdown sources        (default; --src overrides)
const CATERING_DIR  = 'catering';  // kitchen cards  -> <OUTPUT_DIR>/<CATERING_DIR>/
const HOME_DIR      = 'home';      // home cards     -> <OUTPUT_DIR>/<HOME_DIR>/
const COMBINED_NAME = 'EMF Kitchen - All Recipes'; // base name of the combined file(s)
// ===============================================================

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
function optVal(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && argv[i - 1] !== '--src' && argv[i - 1] !== '--out');
const FILTER = positional[0] || '';
const SRC = path.resolve(optVal('--src', SOURCE_DIR));
const OUT = path.resolve(optVal('--out', OUTPUT_DIR));
if (flags.has('--all')) ['--html', '--pdf', '--combined-html', '--combined-pdf'].forEach(f => flags.add(f));
let wantHtml = flags.has('--html');
const wantPdf = flags.has('--pdf');
const wantCombHtml = flags.has('--combined-html');
const wantCombPdf = flags.has('--combined-pdf');
if (!wantHtml && !wantPdf && !wantCombHtml && !wantCombPdf) wantHtml = true; // default
// which audiences
let audiences = [];
if (flags.has('--catering')) audiences.push('catering');
if (flags.has('--home')) audiences.push('home');
if (!audiences.length) audiences = ['catering', 'home'];

const DAY_ABBR = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu',
                   Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
const DAY_INDEX = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };

// ---------------------------------------------------------------- helpers
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// inline markdown -> html: **bold** and [text](url), on already-escaped text
function rich(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}
function fsSafe(s) { return String(s).replace(/[\\/:*?"<>|]/g, ' ').trim(); }
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- parse .md
function parseMd(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const rec = { meta: {}, ings: [], variants: [], method: [], notes: [] };
  let i = 0;
  // title
  while (i < lines.length && !lines[i].startsWith('# ')) i++;
  rec.title = (lines[i] || '# ').slice(2).trim();
  i++;
  // overview: lines until blank / table / heading
  const ov = [];
  while (i < lines.length && lines[i].trim() && !lines[i].startsWith('|') && !lines[i].startsWith('#')) {
    ov.push(lines[i].trim()); i++;
  }
  rec.overview = ov.join(' ');
  // metadata table (before first "## ")
  function tableRows(from) {
    const rows = [];
    let j = from;
    while (j < lines.length && lines[j].trim().startsWith('|')) {
      const cells = lines[j].split('|').slice(1, -1).map(c => c.trim());
      if (!cells.every(c => /^:?-{1,}:?$/.test(c) || c === '')) rows.push(cells); // skip separator
      j++;
    }
    return { rows, end: j };
  }
  while (i < lines.length && !lines[i].startsWith('## ')) {
    if (lines[i].trim().startsWith('|')) {
      const t = tableRows(i);
      for (const r of t.rows) {
        if (/^field$/i.test(r[0])) continue; // header
        if (r[0]) rec.meta[r[0].toLowerCase()] = (r[1] || '').trim();
      }
      i = t.end;
    } else i++;
  }
  // sections
  while (i < lines.length) {
    if (!lines[i].startsWith('## ')) { i++; continue; }
    const name = lines[i].slice(3).trim().toLowerCase();
    i++;
    const body = [];
    while (i < lines.length && !lines[i].startsWith('## ')) { body.push(lines[i]); i++; }
    if (name.startsWith('ingredient')) {
      // shared rows, then optional "### <label>" variant sub-tables
      const shared = [];
      const variants = [];
      let cur = shared;
      for (const l of body) {
        const h3 = l.match(/^###\s+(.+?)\s*$/);
        if (h3) { const v = { label: h3[1].trim(), lines: [] }; variants.push(v); cur = v.lines; }
        else cur.push(l);
      }
      rec.ings = parseIngredients(shared);
      rec.variants = variants
        .map(v => ({ label: v.label, ings: parseIngredients(v.lines) }))
        .filter(v => v.ings.length);
    } else if (name.startsWith('method')) {
      rec.method = body.map(l => l.trim())
        .filter(l => /^(\d+\.|[-*])\s+/.test(l))
        .map(l => l.replace(/^(\d+\.|[-*])\s+/, ''));
    } else if (name.startsWith('note')) {
      rec.notes = body.join('\n').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
    }
  }
  return rec;
}

function parseIngredients(body) {
  const rows = body.filter(l => l.trim().startsWith('|'))
    .map(l => l.split('|').slice(1, -1).map(c => c.trim()));
  if (!rows.length) return [];
  const header = rows.shift().map(h => h.toLowerCase());
  const idx = {
    name: header.findIndex(h => h.startsWith('ingredient')),
    cat: header.findIndex(h => h === 'catering' || h === 'amount' || h.startsWith('cater')),
    home: header.findIndex(h => h === 'home'),
    prep: header.findIndex(h => h.startsWith('prep')),
  };
  const at = (r, k) => (idx[k] >= 0 ? (r[idx[k]] || '') : '');
  return rows
    .filter(r => !r.every(c => /^:?-{1,}:?$/.test(c) || c === '')) // drop separator
    .map(r => ({ name: at(r, 'name'), cat: at(r, 'cat'), home: at(r, 'home'), prep: at(r, 'prep') }))
    .filter(g => g.name || g.cat || g.home || g.prep);
}

// ---------------------------------------------------------------- derive
function derive(file, rec) {
  const m = rec.meta;
  const dayFull = (m.day || '').trim();               // "Sunday 4"
  const dw = dayFull.match(/^([A-Za-z]+)\s*(-?\d+)?/) || [];
  rec.weekday = dw[1] || '';
  rec.dayNum = dw[2] != null ? dw[2] : '';
  rec.meal = (m.meal || '').trim();                    // "Dinner"
  rec.theme = (m.theme || '').trim();                  // cuisine
  rec.type = (m.type || 'side').trim();                // colour class
  rec.feeds = (m.feeds || '').trim();
  // Feeds may carry a home figure in parens, e.g. "150 (4)" -> catering 150, home 4
  const fmFeeds = rec.feeds.match(/^(.*?)\s*\((.*?)\)\s*$/);
  rec.feedsCatering = fmFeeds ? fmFeeds[1].trim() : rec.feeds;
  rec.feedsHome = fmFeeds ? fmFeeds[2].trim() : '';
  rec.vessel = (m.vessel || '').trim();
  rec.diet = (m.diet || '').trim();
  rec.label = (m.label || '').trim();
  rec.source = parseSource(m.source);
  const baseName = path.basename(file, '.md');
  const om = baseName.match(/^(\d+)\s+(.*)$/);
  rec.order = om ? om[1] : '';
  rec.fileName = (om ? om[2] : baseName).trim();  // output filename comes from the source filename
  rec.name = rec.title || rec.fileName;           // display title comes from the h1
  // reconstruct the flat output filename, matching the original scheme
  const abbr = DAY_ABBR[rec.weekday] || rec.weekday;
  const ml = /^l/i.test(rec.meal) ? 'L' : 'D';
  const slot = abbr && rec.dayNum !== '' ? `${abbr} ${rec.dayNum}${ml} ` : '';
  const cui = rec.theme ? `${rec.theme} ` : '';
  const ord = rec.order ? `${rec.order} ` : '';
  rec.outBase = `${slot}${cui}- ${ord}${rec.fileName}`.replace(/\s+/g, ' ').trim();
  if (!slot && !cui) rec.outBase = rec.fileName;
  rec.sortKey = [rec.dayNum === '' ? 99 : parseInt(rec.dayNum, 10),
                 /^l/i.test(rec.meal) ? 0 : 1,
                 rec.order === '' ? 99 : parseInt(rec.order, 10),
                 rec.name];
  return rec;
}
function parseSource(v) {
  if (!v) return null;
  const m = v.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  return m ? { text: m[1], url: m[2] } : { text: v, url: '' };
}

// ---------------------------------------------------------------- render
const DUAL_STYLE =
  '<style>.amt-alt{display:block;font-weight:400;color:var(--mut);font-size:12px;margin-top:2px}</style>';

function chips(rec, audience) {
  const out = [];
  if (rec.feedsCatering) {
    if (audience === 'home') {
      const home = rec.feedsHome ? ` (<b>${esc(rec.feedsHome)}</b>)` : '';
      out.push(`<span class="chip">Serves <b>${esc(rec.feedsCatering)}</b>${home}</span>`);
    } else {
      out.push(`<span class="chip">Yield <b>${esc(rec.feedsCatering)}</b></span>`);
    }
  }
  if (rec.vessel) out.push(`<span class="chip">Vessel <b>${esc(rec.vessel)}</b></span>`);
  if (rec.diet) out.push(`<span class="chip">Diet <b>${esc(rec.diet)}</b></span>`);
  return out.join('');
}
function ingredientRows(ings, audience) {
  return ings.map(g => {
    const isNote = !g.cat && !g.home && !g.prep && g.name;
    if (isNote) return `    <tr>\n      <td colspan="3" class="prep">${esc(g.name)}</td>\n    </tr>`;
    let amtCell;
    if (audience === 'home' && g.home) {
      amtCell = `${esc(g.home)}<span class="amt-alt">catering: ${esc(g.cat || '—')}</span>`;
    } else {
      amtCell = esc(g.cat || '—');
    }
    return `    <tr>\n      <td>${esc(g.name)}</td>\n      <td class="amt">${amtCell}</td>` +
           `\n      <td class="prep">${g.prep ? esc(g.prep) : '—'}</td>\n    </tr>`;
  }).join('\n');
}
function ingredientTable(ings, audience) {
  return `  <table>
    <thead>
    <tr>
      <th style="width:44%">Ingredient</th>
      <th style="width:22%">Amount</th>
      <th style="width:34%">Prep</th>
    </tr>
    </thead>
    <tbody>
${ingredientRows(ings, audience)}
    </tbody>
  </table>`;
}
// Ingredients section: shared table, then any "### <label>" variant sub-tables.
function ingredientsBlock(rec, audience) {
  let html = '  <h2>Ingredients &amp; Prep</h2>';
  if (rec.ings.length) html += '\n' + ingredientTable(rec.ings, audience);
  for (const v of rec.variants) {
    html += `\n  <h3 class="variant">${esc(v.label)}</h3>\n` + ingredientTable(v.ings, audience);
  }
  return html;
}
function footer(rec) {
  const left = rec.label || rec.diet || '';
  const spans = [`<span>${rich(left)}</span>`];
  if (rec.source) {
    spans.push(rec.source.url
      ? `<span>Source: <a href="${esc(rec.source.url)}">${esc(rec.source.text)}</a></span>`
      : `<span>Source: ${esc(rec.source.text)}</span>`);
  }
  const right = rec.weekday ? `${esc(rec.weekday)}${rec.dayNum !== '' ? ' ' + esc(rec.dayNum) : ''}` +
                              `${rec.meal ? ' \u00b7 ' + esc(rec.meal) : ''}` : '';
  spans.push(`<span>${right}</span>`);
  return `<footer>${spans.join('')}</footer>`;
}
// inner .page fragment (shared by single cards and the combined file)
function pageFragment(rec, audience) {
  const kicker = rec.theme ? `EMF Kitchen 2026 \u00b7 ${esc(rec.theme)}` : 'EMF Kitchen 2026 \u00b7 Recipe';
  const notes = rec.notes.map(n => `  <div class="note">${rich(n)}</div>`).join('\n');
  return `  <header>
    <div class="kicker">${kicker}</div>
    <h1>${esc(rec.name)}</h1>
    <div class="meta">${chips(rec, audience)}</div>
  </header>
  <div class="overview"><b>Recipe overview</b><br>${rich(rec.overview)}</div>
${ingredientsBlock(rec, audience)}
  <h2>Method</h2>
  <ol class="method">
${rec.method.map(s => `    <li>${rich(s)}</li>`).join('\n')}
  </ol>
${notes ? notes + '\n' : ''}  ${footer(rec)}`;
}
function singleCard(rec, audience, cssHref) {
  const dual = audience === 'home' ? '\n  ' + DUAL_STYLE : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(rec.name)} \u2014 EMF Kitchen</title>
  <link rel="stylesheet" href="${cssHref}">${dual}
</head>
<body class="t-${esc(rec.type)}">
<div class="page">
${pageFragment(rec, audience)}
</div>
</body>
</html>
`;
}
function combined(recs, audience, cssText) {
  const dual = audience === 'home' ? DUAL_STYLE + '\n' : '';
  const sections = recs.map(rec =>
    `<section class="t-${esc(rec.type)}">\n<div class="page">\n${pageFragment(rec, audience)}\n</div>\n</section>`
  ).join('\n');
  const title = audience === 'home' ? `${COMBINED_NAME} (Home)` : COMBINED_NAME;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
${cssText}
section { break-after: page; page-break-after: always; }
section:last-child { break-after: auto; page-break-after: auto; }
</style>
  ${dual}</head>
<body>
${sections}
</body>
</html>
`;
}

// ---------------------------------------------------------------- PDF (system chromium / docker)
function which(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, bin + e);
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}
let BROWSER; // memoised
function findBrowser() {
  if (BROWSER !== undefined) return BROWSER;
  const envs = [process.env.RECIPE_CHROME, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH];
  for (const e of envs) if (e && fs.existsSync(e)) return (BROWSER = { cmd: e, docker: false });
  let cands;
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env['LOCALAPPDATA'] || '';
    cands = [
      pf86 + '\\Microsoft\\Edge\\Application\\msedge.exe',
      pf + '\\Microsoft\\Edge\\Application\\msedge.exe',
      pf + '\\Google\\Chrome\\Application\\chrome.exe',
      pf86 + '\\Google\\Chrome\\Application\\chrome.exe',
      la + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
  } else if (process.platform === 'darwin') {
    cands = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  } else {
    cands = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  }
  for (const c of cands) {
    if (c.includes('/') || c.includes('\\')) { if (fs.existsSync(c)) return (BROWSER = { cmd: c, docker: false }); }
    else { const p = which(c); if (p) return (BROWSER = { cmd: p, docker: false }); }
  }
  if (which('docker')) return (BROWSER = { cmd: 'docker', docker: true });
  return (BROWSER = null);
}
function htmlToPdf(htmlAbs, pdfAbs) {
  const b = findBrowser();
  if (!b) throw new Error(
    'No Chromium browser found for PDF. Install Microsoft Edge or Google Chrome, ' +
    'or set CHROME_PATH, or install Docker. HTML output is unaffected.');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'emf-'));
  const common = ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--no-first-run',
                  '--no-default-browser-check'];
  if (b.docker) {
    const root = OUT;
    const rel = p => path.relative(root, p).split(path.sep).join('/');
    cp.execFileSync('docker', ['run', '--rm', '-v', `${root}:/work`, 'zenika/alpine-chrome',
      '--no-sandbox', ...common, `--print-to-pdf=/work/${rel(pdfAbs)}`,
      `file:///work/${rel(htmlAbs)}`], { stdio: 'inherit' });
  } else {
    cp.execFileSync(b.cmd, [...common, '--user-data-dir=' + tmp,
      '--print-to-pdf=' + pdfAbs, pathToFileURL(htmlAbs).href], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
}

// ---------------------------------------------------------------- main
function main() {
  if (!fs.existsSync(SRC)) { console.error(`No source folder at ${SRC}. Run import-html.js first?`); process.exit(1); }
  let files = walk(SRC).sort();
  if (FILTER) files = files.filter(f => f.toLowerCase().includes(FILTER.toLowerCase()));
  if (!files.length) { console.error('No matching .md sources.'); process.exit(1); }
  const recs = files.map(f => derive(f, parseMd(f)));
  recs.sort((a, b) => {
    for (let k = 0; k < a.sortKey.length; k++) {
      if (a.sortKey[k] < b.sortKey[k]) return -1;
      if (a.sortKey[k] > b.sortKey[k]) return 1;
    }
    return 0;
  });
  const cssPath = path.join(OUT, 'recipe.css');
  const cssText = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
  const pdfWanted = wantPdf || wantCombPdf;
  const canPdf = pdfWanted ? !!findBrowser() : false;
  if (pdfWanted && !canPdf) console.warn(
    '! No Chromium browser or Docker found - writing HTML only, skipping PDF.\n' +
    '  Install Microsoft Edge or Google Chrome (or set CHROME_PATH), then re-run with --pdf.');
  let nHtml = 0, nPdf = 0;

  for (const audience of audiences) {
    const dir = path.join(OUT, audience === 'home' ? HOME_DIR : CATERING_DIR);
    const depth = path.relative(OUT, dir).split(path.sep).filter(Boolean).length;
    const cssHref = depth ? '../'.repeat(depth) + 'recipe.css' : 'recipe.css'; // back to recipe.css at OUT root
    fs.mkdirSync(dir, { recursive: true });

    if (wantHtml || wantPdf) {
      for (const rec of recs) {
        const fname = fsSafe(rec.outBase);
        const htmlPath = path.join(dir, fname + '.html');
        fs.writeFileSync(htmlPath, singleCard(rec, audience, cssHref));
        nHtml++;
        if (wantPdf && canPdf) { htmlToPdf(htmlPath, path.join(dir, fname + '.pdf')); nPdf++; }
      }
    }
    if (wantCombHtml || wantCombPdf) {
      const label = audience === 'home' ? `${COMBINED_NAME} (Home)` : COMBINED_NAME;
      const combHtml = path.join(dir, label + '.html');
      fs.writeFileSync(combHtml, combined(recs, audience, cssText));
      if (wantCombPdf && canPdf) { htmlToPdf(combHtml, path.join(dir, label + '.pdf')); nPdf++; }
    }
  }
  const b = (wantPdf || wantCombPdf) ? findBrowser() : null;
  console.log(`Built ${nHtml} HTML card(s)` + (nPdf ? `, ${nPdf} PDF(s)` : '') +
              ` for [${audiences.join(', ')}] -> ${OUT}` +
              (b ? ` (PDF via ${b.docker ? 'Docker' : path.basename(b.cmd)})` : ''));
}
main();
