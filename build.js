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
 *   --catering        kitchen copy: 150-scale amounts only        -> <out>/catering/
 *   --home            dual copy: home amount first, catering muted -> <out>/home/
 *   (omit both = build both versions)
 *
 * Builds a self-contained site under the output dir (default ./dist):
 *   dist/index.html -> dist/catering/index.html and dist/home/index.html;
 *   recipe.css is copied in so the folder stands alone.
 *
 * PATHS
 *   --src <dir>            Markdown sources          (default ./src / SOURCE_DIR)
 *   --out <dir>            output root               (default .    / OUTPUT_DIR)
 *   --combined-name <name> base name for combined files (default COMBINED_NAME)
 *
 * EXAMPLES
 *   node build.js                     rebuild every HTML card, both versions
 *   node build.js --pdf               ...and a PDF for each
 *   node build.js --combined-pdf      the single "All Recipes" PDF
 *   node build.js "Tarka Dal" --pdf   just one recipe
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { pathToFileURL } = require('url');

// ============================ CONFIG ============================
// Edit these defaults to change the output layout. The base output
// directory and the source directory can also be overridden on the
// command line (--out / --src), which take precedence over these.
const OUTPUT_DIR = 'dist'; // base output directory (default; --out overrides)
const SOURCE_DIR = 'src'; // markdown sources        (default; --src overrides)
const CATERING_DIR = 'catering'; // kitchen cards  -> <OUTPUT_DIR>/<CATERING_DIR>/
const HOME_DIR = 'home'; // home cards     -> <OUTPUT_DIR>/<HOME_DIR>/
const COMBINED_NAME = 'EMF Kitchen - All Recipes'; // combined file base name (--combined-name overrides)
// ===============================================================

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));

/**
 * Read the value that follows a `--name value` pair on the command line.
 * @param {string} name - flag to look for, e.g. `'--src'`.
 * @param {string} def - value to fall back to when the flag is absent or has no value.
 * @returns {string}
 */
function getFlagValue(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const VALUE_OPTS = ['--src', '--out', '--combined-name'];
const KNOWN_FLAGS = new Set([
  '--html',
  '--pdf',
  '--combined-html',
  '--combined-pdf',
  '--all',
  '--catering',
  '--home',
  ...VALUE_OPTS,
]);
for (const f of flags) {
  if (!KNOWN_FLAGS.has(f)) {
    console.error(`Unknown flag: ${f}\nRun with no arguments to see usage in the file header.`);
    process.exit(1);
  }
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.includes(argv[i - 1]));
const FILTER = positional[0] || '';
const SRC = path.resolve(getFlagValue('--src', SOURCE_DIR));
const OUT = path.resolve(getFlagValue('--out', OUTPUT_DIR));
const COMBINED = getFlagValue('--combined-name', COMBINED_NAME);
if (flags.has('--all')) {
  ['--html', '--pdf', '--combined-html', '--combined-pdf'].forEach(f => flags.add(f));
}
let wantHtml = flags.has('--html');
const wantPdf = flags.has('--pdf');
const wantCombHtml = flags.has('--combined-html');
const wantCombPdf = flags.has('--combined-pdf');
if (!wantHtml && !wantPdf && !wantCombHtml && !wantCombPdf) {
  wantHtml = true; // default
}
// which audiences
let audiences = [];
if (flags.has('--catering')) {
  audiences.push('catering');
}
if (flags.has('--home')) {
  audiences.push('home');
}
if (!audiences.length) {
  audiences = ['catering', 'home'];
}

const DAY_ABBR = {
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
  Sunday: 'Sun',
};

// ---------------------------------------------------------------- helpers

/**
 * HTML-escape a value for safe interpolation into markup.
 * @param {*} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// inline markdown -> html: **bold** and [text](url), on already-escaped text
/**
 * Render a small subset of inline Markdown (`**bold**` and `[text](url)`) as
 * HTML, escaping everything else first.
 * @param {*} s
 * @returns {string}
 */
function renderInlineMarkdown(s) {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

/**
 * Strip characters that are illegal in filenames on common filesystems.
 * @param {*} s
 * @returns {string}
 */
function sanitizeFilename(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .trim();
}

/**
 * Recursively collect every `.md` file under `dir`.
 * @param {string} dir
 * @returns {string[]} file paths, in readdir order.
 */
function findMarkdownFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...findMarkdownFiles(p));
    } else if (e.name.toLowerCase().endsWith('.md')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * @typedef {Object} Ingredient
 * @property {string} name
 * @property {string} cat  - catering-scale amount.
 * @property {string} home - home-scale amount, if the source gave one.
 * @property {string} prep
 */

/**
 * @typedef {Object} Recipe
 * @property {Object<string,string>} meta - raw lowercased metadata table (day, meal, theme, ...).
 * @property {Ingredient[]} ings - shared ingredient rows.
 * @property {{label: string, ings: Ingredient[]}[]} variants - "### <label>" ingredient sub-tables.
 * @property {string[]} method
 * @property {string[]} notes
 * @property {string} title
 * @property {string} overview
 * @property {string} weekday
 * @property {string} dayNum
 * @property {string} meal
 * @property {string} theme
 * @property {string} type
 * @property {string} feeds
 * @property {string} feedsCatering
 * @property {string} feedsHome
 * @property {string} vessel
 * @property {string} diet
 * @property {string} label
 * @property {{text: string, url: string}|null} source
 * @property {string} order
 * @property {string} fileName
 * @property {string} name
 * @property {string} outBase - flat output filename (without extension).
 * @property {Array} sortKey
 */

// ---------------------------------------------------------------- parse .md
/**
 * Parse one Markdown recipe source file into a raw record. {@link deriveRecipeFields}
 * fills in the remaining fields computed from the record and its filename.
 * @param {string} file - path to the .md source.
 * @returns {Recipe} partially-populated recipe record.
 */
function parseRecipeFile(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const rec = { meta: {}, ings: [], variants: [], method: [], notes: [] };
  let i = 0;
  // title
  while (i < lines.length && !lines[i].startsWith('# ')) {
    i++;
  }
  rec.title = (lines[i] || '# ').slice(2).trim();
  i++;
  // overview: lines until blank / table / heading
  const ov = [];
  while (i < lines.length && lines[i].trim() && !lines[i].startsWith('|') && !lines[i].startsWith('#')) {
    ov.push(lines[i].trim());
    i++;
  }
  rec.overview = ov.join(' ');
  // metadata table (before first "## ")
  /**
   * Collect consecutive `| ... |` table rows starting at line `from`, dropping the separator row.
   * @param {number} from
   * @returns {{rows: string[][], end: number}}
   */
  function tableRows(from) {
    const rows = [];
    let j = from;
    while (j < lines.length && lines[j].trim().startsWith('|')) {
      const cells = lines[j]
        .split('|')
        .slice(1, -1)
        .map(c => c.trim());
      if (!cells.every(c => /^:?-{1,}:?$/.test(c) || c === '')) {
        rows.push(cells); // skip separator
      }
      j++;
    }
    return { rows, end: j };
  }
  while (i < lines.length && !lines[i].startsWith('## ')) {
    if (lines[i].trim().startsWith('|')) {
      const t = tableRows(i);
      for (const r of t.rows) {
        if (/^field$/i.test(r[0])) {
          continue; // header
        }
        if (r[0]) {
          rec.meta[r[0].toLowerCase()] = (r[1] || '').trim();
        }
      }
      i = t.end;
    } else {
      i++;
    }
  }
  // sections
  while (i < lines.length) {
    if (!lines[i].startsWith('## ')) {
      i++;
      continue;
    }
    const name = lines[i].slice(3).trim().toLowerCase();
    i++;
    const body = [];
    while (i < lines.length && !lines[i].startsWith('## ')) {
      body.push(lines[i]);
      i++;
    }
    if (name.startsWith('ingredient')) {
      // shared rows, then optional "### <label>" variant sub-tables
      const shared = [];
      const variants = [];
      let cur = shared;
      for (const l of body) {
        const h3 = l.match(/^###\s+(.+?)\s*$/);
        if (h3) {
          const v = { label: h3[1].trim(), lines: [] };
          variants.push(v);
          cur = v.lines;
        } else {
          cur.push(l);
        }
      }
      rec.ings = parseIngredientTable(shared);
      rec.variants = variants
        .map(v => ({ label: v.label, ings: parseIngredientTable(v.lines) }))
        .filter(v => v.ings.length);
    } else if (name.startsWith('method')) {
      rec.method = body
        .map(l => l.trim())
        .filter(l => /^(\d+\.|[-*])\s+/.test(l))
        .map(l => l.replace(/^(\d+\.|[-*])\s+/, ''));
    } else if (name.startsWith('note')) {
      rec.notes = body
        .join('\n')
        .split(/\n\s*\n/)
        .map(b => b.trim())
        .filter(Boolean);
    }
  }
  return rec;
}

/**
 * Parse an ingredient table body (rows only, no surrounding markdown) into
 * `{ name, cat, home, prep }` objects. Column order is inferred from the
 * header row so authors can reorder/omit "Home" or "Prep".
 * @param {string[]} body
 * @returns {Ingredient[]}
 */
function parseIngredientTable(body) {
  const rows = body
    .filter(l => l.trim().startsWith('|'))
    .map(l =>
      l
        .split('|')
        .slice(1, -1)
        .map(c => c.trim())
    );
  if (!rows.length) {
    return [];
  }
  const header = rows.shift().map(h => h.toLowerCase());
  const idx = {
    name: header.findIndex(h => h.startsWith('ingredient')),
    cat: header.findIndex(h => h === 'catering' || h === 'amount' || h.startsWith('cater')),
    home: header.findIndex(h => h === 'home'),
    prep: header.findIndex(h => h.startsWith('prep')),
  };
  /**
   * Read one column's value out of a table row using the resolved column-index map.
   * @param {string[]} r - a table row.
   * @param {string} k - column key (`'name'`, `'cat'`, `'home'`, or `'prep'`).
   * @returns {string}
   */
  const cellAt = (r, k) => (idx[k] >= 0 ? r[idx[k]] || '' : '');
  return rows
    .filter(r => !r.every(c => /^:?-{1,}:?$/.test(c) || c === '')) // drop separator
    .map(r => ({ name: cellAt(r, 'name'), cat: cellAt(r, 'cat'), home: cellAt(r, 'home'), prep: cellAt(r, 'prep') }))
    .filter(g => g.name || g.cat || g.home || g.prep);
}

// ---------------------------------------------------------------- derive
/**
 * Fill in every field computed from the raw parsed record plus the source
 * file's name/location: display name, output filename, sort key, etc.
 * Mutates and returns `rec`.
 * @param {string} file - path to the source .md file.
 * @param {Recipe} rec - value returned by {@link parseRecipeFile}.
 * @returns {Recipe} `rec`, with the derived fields attached.
 */
function deriveRecipeFields(file, rec) {
  const meta = rec.meta;
  const dayFull = (meta.day || '').trim(); // "Sunday 4"
  const weekdayMatch = dayFull.match(/^([A-Za-z]+)\s*(-?\d+)?/) || [];
  rec.weekday = weekdayMatch[1] || '';
  rec.dayNum = weekdayMatch[2] != null ? weekdayMatch[2] : '';
  rec.meal = (meta.meal || '').trim(); // "Dinner"
  rec.theme = (meta.theme || '').trim(); // cuisine
  rec.type = (meta.type || 'side').trim(); // colour class
  rec.feeds = (meta.feeds || '').trim();
  // Feeds may carry a home figure in parens, e.g. "150 (4)" -> catering 150, home 4
  const feedsMatch = rec.feeds.match(/^(.*?)\s*\((.*?)\)\s*$/);
  rec.feedsCatering = feedsMatch ? feedsMatch[1].trim() : rec.feeds;
  rec.feedsHome = feedsMatch ? feedsMatch[2].trim() : '';
  rec.vessel = (meta.vessel || '').trim();
  rec.diet = (meta.diet || '').trim();
  rec.label = (meta.label || '').trim();
  rec.source = parseSourceLink(meta.source);
  const baseName = path.basename(file, '.md');
  const orderMatch = baseName.match(/^(\d+)\s+(.*)$/);
  rec.order = orderMatch ? orderMatch[1] : '';
  rec.fileName = (orderMatch ? orderMatch[2] : baseName).trim(); // output filename comes from the source filename
  rec.name = rec.title || rec.fileName; // display title comes from the h1
  // reconstruct the flat output filename, matching the original scheme
  const dayAbbr = DAY_ABBR[rec.weekday] || rec.weekday;
  const isLunch = /^l/i.test(rec.meal);
  const mealAbbr = isLunch ? 'L' : 'D';
  const daySlot = dayAbbr && rec.dayNum !== '' ? `${dayAbbr} ${rec.dayNum}${mealAbbr} ` : '';
  const cuisinePrefix = rec.theme ? `${rec.theme} ` : '';
  const orderPrefix = rec.order ? `${rec.order} ` : '';
  rec.outBase = `${daySlot}${cuisinePrefix}- ${orderPrefix}${rec.fileName}`.replace(/\s+/g, ' ').trim();
  if (!daySlot && !cuisinePrefix) {
    rec.outBase = rec.fileName;
  }
  rec.sortKey = [
    rec.dayNum === '' ? 99 : parseInt(rec.dayNum, 10),
    isLunch ? 0 : 1,
    rec.order === '' ? 99 : parseInt(rec.order, 10),
    rec.name,
  ];
  return rec;
}

/**
 * Parse a `source` metadata value, which may be a plain string or a Markdown link `[text](url)`.
 * @param {string|undefined} v
 * @returns {{text: string, url: string}|null}
 */
function parseSourceLink(v) {
  if (!v) {
    return null;
  }
  const m = v.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  return m ? { text: m[1], url: m[2] } : { text: v, url: '' };
}

// ---------------------------------------------------------------- render
const DUAL_STYLE =
  '<style>.amt-alt{display:block;font-weight:400;color:var(--mut);font-size:12px;margin-top:2px}</style>';

/**
 * Render the meta chip row (serves/yield, vessel, diet) under the title.
 * @param {Recipe} rec
 * @param {'catering'|'home'} audience
 * @returns {string} HTML.
 */
function renderMetaChips(rec, audience) {
  const out = [];
  if (rec.feedsCatering) {
    if (audience === 'home') {
      const home = rec.feedsHome ? ` (<b>${escapeHtml(rec.feedsHome)}</b>)` : '';
      out.push(`<span class="chip">Serves <b>${escapeHtml(rec.feedsCatering)}</b>${home}</span>`);
    } else {
      out.push(`<span class="chip">Yield <b>${escapeHtml(rec.feedsCatering)}</b></span>`);
    }
  }
  if (rec.vessel) {
    out.push(`<span class="chip">Vessel <b>${escapeHtml(rec.vessel)}</b></span>`);
  }
  if (rec.diet) {
    out.push(`<span class="chip">Diet <b>${escapeHtml(rec.diet)}</b></span>`);
  }
  return out.join('');
}

/**
 * Render the `<tr>` markup for every ingredient in a table.
 * @param {Ingredient[]} ings
 * @param {'catering'|'home'} audience
 * @returns {string} HTML, one `<tr>` per ingredient, newline-joined.
 */
function renderIngredientRows(ings, audience) {
  return ings
    .map(g => {
      const isNote = !g.cat && !g.home && !g.prep && g.name;
      if (isNote) {
        return `    <tr>\n      <td colspan="3" class="prep">${escapeHtml(g.name)}</td>\n    </tr>`;
      }
      let amtCell;
      if (audience === 'home' && g.home) {
        amtCell = `${escapeHtml(g.home)}<span class="amt-alt">catering: ${escapeHtml(g.cat || '—')}</span>`;
      } else {
        amtCell = escapeHtml(g.cat || '—');
      }
      return (
        `    <tr>\n      <td>${escapeHtml(g.name)}</td>\n      <td class="amt">${amtCell}</td>` +
        `\n      <td class="prep">${g.prep ? escapeHtml(g.prep) : '—'}</td>\n    </tr>`
      );
    })
    .join('\n');
}

/**
 * Wrap a set of ingredient rows in a `<table>` with the standard header.
 * @param {Ingredient[]} ings
 * @param {'catering'|'home'} audience
 * @returns {string} HTML.
 */
function renderIngredientTable(ings, audience) {
  return `  <table>
    <thead>
    <tr>
      <th style="width:44%">Ingredient</th>
      <th style="width:22%">Amount</th>
      <th style="width:34%">Prep</th>
    </tr>
    </thead>
    <tbody>
${renderIngredientRows(ings, audience)}
    </tbody>
  </table>`;
}

// Ingredients section: shared table, then any "### <label>" variant sub-tables.
/**
 * Full "Ingredients & Prep" section: the shared table, then one table per "### <label>" variant.
 * @param {Recipe} rec
 * @param {'catering'|'home'} audience
 * @returns {string} HTML.
 */
function renderIngredientsSection(rec, audience) {
  let html = '  <h2>Ingredients &amp; Prep</h2>';
  if (rec.ings.length) {
    html += '\n' + renderIngredientTable(rec.ings, audience);
  }
  for (const v of rec.variants) {
    html += `\n  <h3 class="variant">${escapeHtml(v.label)}</h3>\n` + renderIngredientTable(v.ings, audience);
  }
  return html;
}

/**
 * Render the card footer: label/diet on the left, source in the middle, day/meal on the right.
 * @param {Recipe} rec
 * @returns {string} HTML.
 */
function renderFooter(rec) {
  const left = rec.label || rec.diet || '';
  const spans = [`<span>${renderInlineMarkdown(left)}</span>`];
  if (rec.source) {
    spans.push(
      rec.source.url
        ? `<span>Source: <a href="${escapeHtml(rec.source.url)}">${escapeHtml(rec.source.text)}</a></span>`
        : `<span>Source: ${escapeHtml(rec.source.text)}</span>`
    );
  }
  const right = rec.weekday
    ? `${escapeHtml(rec.weekday)}${rec.dayNum !== '' ? ' ' + escapeHtml(rec.dayNum) : ''}` +
      `${rec.meal ? ' \u00b7 ' + escapeHtml(rec.meal) : ''}`
    : '';
  spans.push(`<span>${right}</span>`);
  return `<footer>${spans.join('')}</footer>`;
}

// inner .page fragment (shared by single cards and the combined file)
/**
 * The `.page` inner content shared by single recipe cards and the combined file.
 * @param {Recipe} rec
 * @param {'catering'|'home'} audience
 * @returns {string} HTML.
 */
function renderCardBody(rec, audience) {
  const kicker = rec.theme ? `EMF Kitchen 2026 \u00b7 ${escapeHtml(rec.theme)}` : 'EMF Kitchen 2026 \u00b7 Recipe';
  const notes = rec.notes.map(n => `  <div class="note">${renderInlineMarkdown(n)}</div>`).join('\n');
  return `  <header>
    <div class="kicker">${kicker}</div>
    <h1>${escapeHtml(rec.name)}</h1>
    <div class="meta">${renderMetaChips(rec, audience)}</div>
  </header>
  <div class="overview"><b>Recipe overview</b><br>${renderInlineMarkdown(rec.overview)}</div>
${renderIngredientsSection(rec, audience)}
  <h2>Method</h2>
  <ol class="method">
${rec.method.map(s => `    <li>${renderInlineMarkdown(s)}</li>`).join('\n')}
  </ol>
${notes ? notes + '\n' : ''}  ${renderFooter(rec)}`;
}

/**
 * A complete standalone HTML document for one recipe card.
 * @param {Recipe} rec
 * @param {'catering'|'home'} audience
 * @param {string} cssHref - relative path to recipe.css from this file's location.
 * @returns {string} HTML document.
 */
function renderCardPage(rec, audience, cssHref) {
  const dual = audience === 'home' ? '\n  ' + DUAL_STYLE : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(rec.name)} \u2014 EMF Kitchen</title>
  <link rel="stylesheet" href="${cssHref}">${dual}
</head>
<body class="t-${escapeHtml(rec.type)}">
<div class="page">
${renderCardBody(rec, audience)}
</div>
</body>
</html>
`;
}

/**
 * One HTML document containing every recipe card in `recs`, each wrapped in a
 * `<section>` that force-breaks to its own printed/PDF page.
 * @param {Recipe[]} recs
 * @param {'catering'|'home'} audience
 * @param {string} cssText - recipe.css contents, inlined so the file is self-contained.
 * @returns {string} HTML document.
 */
function renderCombinedPage(recs, audience, cssText) {
  const dual = audience === 'home' ? DUAL_STYLE + '\n' : '';
  const sections = recs
    .map(
      rec =>
        `<section class="t-${escapeHtml(rec.type)}">\n<div class="page">\n${renderCardBody(rec, audience)}\n</div>\n</section>`
    )
    .join('\n');
  const title = audience === 'home' ? `${COMBINED} (Home)` : COMBINED;
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
/**
 * Look up an executable on PATH, the way a shell would.
 * @param {string} bin - executable name, without extension.
 * @returns {string|null} absolute path, or null if not found.
 */
function findExecutableOnPath(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, bin + e);
      try {
        if (fs.existsSync(p)) {
          return p;
        }
      } catch (_) {
        // inaccessible directory on PATH; keep looking
      }
    }
  }
  return null;
}

let BROWSER; // memoised
/**
 * Locate a Chromium-family browser to drive headless, or fall back to Docker.
 * Checks RECIPE_CHROME / CHROME_PATH / PUPPETEER_EXECUTABLE_PATH first, then
 * common install locations for the current OS, then `docker` on PATH.
 * @returns {{cmd: string, docker: boolean}|null} null if nothing usable was found.
 */
function findBrowser() {
  if (BROWSER !== undefined) {
    return BROWSER;
  }
  const envs = [process.env.RECIPE_CHROME, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH];
  for (const e of envs) {
    if (e && fs.existsSync(e)) {
      return (BROWSER = { cmd: e, docker: false });
    }
  }
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
    if (c.includes('/') || c.includes('\\')) {
      if (fs.existsSync(c)) {
        return (BROWSER = { cmd: c, docker: false });
      }
    } else {
      const p = findExecutableOnPath(c);
      if (p) {
        return (BROWSER = { cmd: p, docker: false });
      }
    }
  }
  if (findExecutableOnPath('docker')) {
    return (BROWSER = { cmd: 'docker', docker: true });
  }
  return (BROWSER = null);
}

/**
 * Render one HTML file to a PDF, via a local Chromium install or, failing
 * that, a disposable `zenika/alpine-chrome` Docker container.
 * @param {string} htmlAbs - absolute path to the source HTML file.
 * @param {string} pdfAbs - absolute path to write the PDF to.
 * @returns {void}
 */
function renderPdf(htmlAbs, pdfAbs) {
  const b = findBrowser();
  if (!b) {
    throw new Error(
      'No Chromium browser found for PDF. Install Microsoft Edge or Google Chrome, ' +
        'or set CHROME_PATH, or install Docker. HTML output is unaffected.'
    );
  }
  const common = [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (b.docker) {
    const root = OUT;
    /**
     * Relativize an absolute path to `root`, in forward-slash form, for the Docker container's `/work` mount.
     * @param {string} p
     * @returns {string}
     */
    const toDockerPath = p => path.relative(root, p).split(path.sep).join('/');
    cp.execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${root}:/work`,
        'zenika/alpine-chrome',
        '--no-sandbox',
        ...common,
        `--print-to-pdf=/work/${toDockerPath(pdfAbs)}`,
        `file:///work/${toDockerPath(htmlAbs)}`,
      ],
      { stdio: 'inherit' }
    );
    return;
  }
  // Each headless run needs its own profile dir; clean it up so repeated
  // builds (one per card) don't litter the OS temp folder.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emf-'));
  try {
    cp.execFileSync(
      b.cmd,
      [...common, '--user-data-dir=' + tmp, '--print-to-pdf=' + pdfAbs, pathToFileURL(htmlAbs).href],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- index pages
/**
 * Shared HTML shell for the two index pages (root + per-audience).
 * @param {string} cssHref
 * @param {string} title
 * @param {string} inner - the `.page` contents.
 * @returns {string} HTML document.
 */
function renderIndexPage(cssHref, title, inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${cssHref}">
</head>
<body>
<div class="page">
${inner}
</div>
</body>
</html>
`;
}

const AUDIENCE_LABEL = { catering: 'Catering', home: 'Home Cook' };

// dist/index.html : landing page linking to each version's own index
/**
 * dist/index.html - landing page linking to each built audience's own index.
 * @param {string[]} builtAudiences
 * @returns {string} HTML document.
 */
function renderRootIndexPage(builtAudiences) {
  let items = '';
  for (const a of builtAudiences) {
    const sub = a === 'home' ? HOME_DIR : CATERING_DIR;
    items += `    <li><a href="${escapeHtml(sub)}/index.html">${escapeHtml(AUDIENCE_LABEL[a] || a)}</a></li>\n`;
  }
  const inner = `  <header>
    <div class="kicker">EMF Kitchen 2026</div>
    <h1>Recipes</h1>
  </header>
  <p>Choose a version:</p>
  <ul>
${items}  </ul>`;
  return renderIndexPage('recipe.css', 'EMF Kitchen 2026 — Recipes', inner);
}

// dist/<version>/index.html : contents of one version, grouped by day/meal
/**
 * dist/<version>/index.html - every recipe in one audience, grouped by day/meal.
 * @param {Recipe[]} recs
 * @param {'catering'|'home'} audience
 * @param {string} cssHref
 * @param {string|null} combinedHref - link to the "everything on one page" file, if built.
 * @returns {string} HTML document.
 */
function renderAudienceIndexPage(recs, audience, cssHref, combinedHref) {
  const label = AUDIENCE_LABEL[audience] || audience;
  const nav = [];
  if (combinedHref) {
    nav.push(`<a href="${escapeHtml(combinedHref)}">Everything on one page →</a>`);
  }
  nav.push(`<a href="../index.html">← All versions</a>`);
  let inner = `  <header>
    <div class="kicker">EMF Kitchen 2026 · ${escapeHtml(label)}</div>
    <h1>All recipes</h1>
  </header>
  <p>${nav.join(' · ')}</p>\n`;
  let lastKey = null,
    open = false;
  for (const rec of recs) {
    const key =
      `${rec.weekday}${rec.dayNum !== '' ? ' ' + rec.dayNum : ''}` +
      `${rec.meal ? ' · ' + rec.meal : ''}${rec.theme ? ' · ' + rec.theme : ''}`;
    if (key !== lastKey) {
      if (open) {
        inner += '  </ul>\n';
      }
      inner += `  <h2>${escapeHtml(key)}</h2>\n  <ul>\n`;
      open = true;
      lastKey = key;
    }
    const href = sanitizeFilename(rec.outBase) + '.html';
    inner += `    <li><a href="${escapeHtml(href)}">${escapeHtml(rec.name)}</a></li>\n`;
  }
  if (open) {
    inner += '  </ul>';
  }
  return renderIndexPage(cssHref, `${label} — EMF Kitchen`, inner.replace(/\n$/, ''));
}

// ---------------------------------------------------------------- main
/**
 * Entry point: parse the source tree, build every requested output for every
 * requested audience, and print a one-line summary.
 * @returns {void}
 */
function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`No source folder at ${SRC}. Run import-html.js first?`);
    process.exit(1);
  }
  let files = findMarkdownFiles(SRC).sort();
  if (FILTER) {
    files = files.filter(f => f.toLowerCase().includes(FILTER.toLowerCase()));
  }
  if (!files.length) {
    console.error('No matching .md sources.');
    process.exit(1);
  }
  const recs = files.map(f => deriveRecipeFields(f, parseRecipeFile(f)));
  recs.sort((a, b) => {
    for (let k = 0; k < a.sortKey.length; k++) {
      if (a.sortKey[k] < b.sortKey[k]) {
        return -1;
      }
      if (a.sortKey[k] > b.sortKey[k]) {
        return 1;
      }
    }
    return 0;
  });
  // Source recipe.css lives next to this script (or already in OUT). Copy it into
  // OUT so the output tree (e.g. dist/) is self-contained.
  fs.mkdirSync(OUT, { recursive: true });
  const outCss = path.join(OUT, 'recipe.css');
  const srcCss = fs.existsSync(outCss) ? outCss : path.join(__dirname, 'recipe.css');
  const cssText = fs.existsSync(srcCss) ? fs.readFileSync(srcCss, 'utf8') : '';
  if (cssText && path.resolve(srcCss) !== path.resolve(outCss)) {
    fs.writeFileSync(outCss, cssText);
  }
  const pdfWanted = wantPdf || wantCombPdf;
  const canPdf = pdfWanted ? !!findBrowser() : false;
  if (pdfWanted && !canPdf) {
    console.warn(
      '! No Chromium browser or Docker found - writing HTML only, skipping PDF.\n' +
        '  Install Microsoft Edge or Google Chrome (or set CHROME_PATH), then re-run with --pdf.'
    );
  }
  let nHtml = 0,
    nPdf = 0;

  for (const audience of audiences) {
    const dir = path.join(OUT, audience === 'home' ? HOME_DIR : CATERING_DIR);
    const depth = path.relative(OUT, dir).split(path.sep).filter(Boolean).length;
    const cssHref = depth ? '../'.repeat(depth) + 'recipe.css' : 'recipe.css'; // back to recipe.css at OUT root
    fs.mkdirSync(dir, { recursive: true });

    if (wantHtml || wantPdf) {
      for (const rec of recs) {
        const fname = sanitizeFilename(rec.outBase);
        const htmlPath = path.join(dir, fname + '.html');
        fs.writeFileSync(htmlPath, renderCardPage(rec, audience, cssHref));
        nHtml++;
        if (wantPdf && canPdf) {
          renderPdf(htmlPath, path.join(dir, fname + '.pdf'));
          nPdf++;
        }
      }
    }
    if (wantCombHtml || wantCombPdf) {
      const label = audience === 'home' ? `${COMBINED} (Home)` : COMBINED;
      const combHtml = path.join(dir, label + '.html');
      fs.writeFileSync(combHtml, renderCombinedPage(recs, audience, cssText));
      if (wantCombPdf && canPdf) {
        renderPdf(combHtml, path.join(dir, label + '.pdf'));
        nPdf++;
      }
    }
    if (wantHtml || wantCombHtml) {
      const combinedBase = audience === 'home' ? `${COMBINED} (Home)` : COMBINED;
      const cf = path.join(dir, combinedBase + '.html');
      const combinedHref = fs.existsSync(cf) ? combinedBase + '.html' : null;
      fs.writeFileSync(path.join(dir, 'index.html'), renderAudienceIndexPage(recs, audience, cssHref, combinedHref));
    }
  }
  if (wantHtml || wantCombHtml) {
    fs.writeFileSync(path.join(OUT, 'index.html'), renderRootIndexPage(audiences));
  }
  const b = wantPdf || wantCombPdf ? findBrowser() : null;
  console.log(
    `Built ${nHtml} HTML card(s)` +
      (nPdf ? `, ${nPdf} PDF(s)` : '') +
      ` for [${audiences.join(', ')}] -> ${OUT}` +
      (b ? ` (PDF via ${b.docker ? 'Docker' : path.basename(b.cmd)})` : '')
  );
}
main();
