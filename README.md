# EMF Kitchen — Recipes

Recipes are written as plain **Markdown** in `src/`. Running one command regenerates
the styled HTML cards (and, optionally, PDFs). You never hand-edit the HTML.

## TL;DR

```
node build.js                 rebuild every HTML card (kitchen + home versions)
node build.js --pdf           ...and a PDF for each card
node build.js --combined-pdf  one "All Recipes" PDF
node build.js "Tarka Dal"     just the recipes whose path matches "Tarka Dal"
```

Everything is pure Node — nothing to `npm install`. PDF uses a Chromium already on
your machine (Microsoft Edge ships with Windows, so it just works).

## Folder layout

```
Recipes/
├── recipe.css        the single styling knob — tweak colours/fonts here, every card updates
├── src/              >>> YOU EDIT HERE <<<  one .md per recipe
│   └── <Day N>/<Meal - Cuisine>/<order Name>.md
│       e.g.  src/Sunday 4/Dinner - Indian/1 Tarka Dal.md
├── build.js          the generator: Markdown -> HTML / PDF
├── import-html.js    one-time HTML -> Markdown importer (already run; keep for reference)
├── catering/         GENERATED kitchen cards — do not hand-edit
└── home/             GENERATED home-cook cards
```

The numeric prefix on a filename (`1 Tarka Dal.md`) sets the order within a menu and
the `— 1` in the output filename. Rename a `.md` file to rename its output card.

## Writing a recipe

A recipe file is ordinary Markdown: an `# H1` title, a one-line overview, a metadata
table, then Ingredients / Method / Notes.

````markdown
# Tarka Dal
Chickpea-and-red-lentil dal finished with a bloomed-spice tarka.

| Field  | Value    |
|--------|----------|
| Type   | vegmain  |
| Feeds  | 150 (4)  |
| Vessel | Kipper   |
| Diet   | Vegan    |
| Day    | Sunday 4 |
| Meal   | Dinner   |
| Theme  | Indian   |

## Ingredients

| Ingredient      | Catering | Home  | Prep            |
|-----------------|----------|-------|-----------------|
| Dried Chickpeas | 18 kg    | 120 g | wash before use |
| Onions          | 24 kg    | 1 kg  | medium cubes    |
| Oil             | 1.5 l    | 15 ml |                 |

## Method

1. Wash the lentils and chickpeas until the water runs clear.
2. Simmer lentils with turmeric and chillies until soft.

## Notes

**Optional.** Omit this whole section if there is no note.
````

### Metadata fields

| Field    | Purpose                                                                 |
|----------|-------------------------------------------------------------------------|
| `Type`   | Colour theme: `vegmain`, `meat`, `side`, `cold`, or `dessert`           |
| `Feeds`  | Yield chip. Optionally add the home serving count in parens, `150 (4)`. Kitchen card shows `Yield 150`; home card shows `Serves 150 (4)`. Omit the row to hide the chip. |
| `Vessel` | "Vessel" chip (optional)                                                |
| `Diet`   | "Diet" chip; also the default footer label                              |
| `Day`    | e.g. `Sunday 4` — drives the footer and the `Sun 4D` filename           |
| `Meal`   | `Lunch` or `Dinner` — drives the footer and the `…D` / `…L` filename    |
| `Theme`  | Cuisine, e.g. `Indian` — shown in the kicker and the folder name        |
| `Label`  | Optional footer text if you want more than the plain diet (e.g. `Vegan (oat milk)`) |
| `Source` | Optional credit link, written as `[text](url)` — shown in the footer    |

Only fields you include appear. `**bold**` works in the overview, notes, and method.
An ingredient row with a name but no amounts renders as a full-width note row
(used by the "Leftovers" card).

## Vegan / meat variants (optional)

Some dishes are the same base with a swapped protein. Add `###` sub-headings inside
the `## Ingredients` block — the rows above them are shared, each sub-table is a variant:

```markdown
## Ingredients

| Ingredient | Catering | Home  | Prep  |
|------------|----------|-------|-------|
| Rice       | 12 kg    | 300 g |       |
| Onions     | 8 kg     | 200 g | diced |

### Vegan

| Ingredient | Catering | Home  | Prep  |
|------------|----------|-------|-------|
| Tofu       | 8 kg     | 200 g | cubed |

### Meat

| Ingredient    | Catering | Home  | Prep  |
|---------------|----------|-------|-------|
| Chicken thigh | 10 kg    | 250 g | diced |
```

The card shows the shared table once, then each variant as its own labelled table.
Everything else (method, overview, chips) is shared. Labels are free text, so
`### Vegetarian`, `### Gluten-free`, etc. work too. A recipe with no `###` sub-headings
behaves exactly as before.

## Two versions: kitchen vs home

Each recipe can carry two quantities. The **Catering** column is the 150-scale figure;
the **Home** column is for someone cooking it at home. From the same source file:

- **Kitchen version** (`Recipes/catering/*.html`) — Catering amounts only. This is the default.
- **Home version** (`Recipes/home/*.html`) — the Home amount is shown first, with the
  catering figure beneath it in grey (`catering: 18 kg`). Rows with no Home amount fall
  back to the catering figure, so a recipe still renders before you have filled in Home.

```
node build.js              build both versions
node build.js --catering   only the kitchen version -> Recipes/catering/
node build.js --home       only the home version    -> Recipes/home/
```

## All options

```
Outputs (combine freely; default = individual HTML, both versions)
  --html            individual HTML cards (default)
  --pdf             a PDF per card
  --combined-html   one scrollable HTML with every card
  --combined-pdf    one PDF with every card
  --all             = --html --pdf --combined-html --combined-pdf

Version
  --catering        kitchen copy only
  --home            home copy only
  (omit both -> build both)

Paths
  --src <dir>       sources    (default ./src, or SOURCE_DIR)
  --out <dir>       output root (default .,     or OUTPUT_DIR)

Filter
  <text>            only recipes whose path contains <text>
```

The combined files are self-contained (styles inlined), so you can open
`EMF Kitchen - All Recipes.html` in any browser and print to PDF with Ctrl-P even
without running `--combined-pdf`.

### Changing the output layout

The folder and file names live in a `CONFIG` block at the top of `build.js` — edit the
defaults there:

```
const OUTPUT_DIR    = '.';                          // base output dir (--out overrides)
const SOURCE_DIR    = 'src';                        // sources        (--src overrides)
const CATERING_DIR  = 'catering';                   // kitchen cards -> OUTPUT_DIR/catering/
const HOME_DIR      = 'home';                        // home cards    -> OUTPUT_DIR/home/
const COMBINED_NAME = 'EMF Kitchen - All Recipes';  // combined file base name
```

The base output directory is also settable per-run without editing the file:
`node build.js --out ../build`.

## PDF details

`build.js` looks for a Chromium browser in this order: `CHROME_PATH` (if you set it),
then Microsoft Edge, then Google Chrome, then Chromium. If none is found it falls back
to a Docker container (`zenika/alpine-chrome`). If neither is available it writes the
HTML and skips the PDF with a note — the HTML is never affected.

To force a specific browser:

```
# Windows (PowerShell)
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"; node build.js --pdf
```

## Re-importing from HTML

`import-html.js` was used once to convert the original HTML cards into `src/`. You
shouldn't need it again, but if you ever have loose HTML cards to fold back in:

```
node import-html.js <folderWithHtml> src
```
