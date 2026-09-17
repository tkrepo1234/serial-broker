/**
 * Makes `dist/` run from a folder opened as a file, and makes it small.
 *
 * `ui5 build self-contained` puts the framework's modules, the application and its views into one
 * script, `resources/sap-ui-custom.js`. What it leaves outside are the files OpenUI5 fetches with
 * an `XMLHttpRequest` at run time: its text bundles, the locale data and the version file. A page
 * opened from a file may not make such a request - the browser blocks it as cross-origin - and the
 * page would come up with keys in place of texts.
 *
 * The module loader answers for a resource it has been handed before it asks the network, so this
 * script hands those files over: it embeds them into the bundle as one more
 * `sap.ui.require.preload()`, placed before the statement that boots the framework. The page fixes
 * its language to English (index.html), so one language is enough.
 *
 * Then it removes what the built page never loads; `isNeeded()` below says what that is.
 */

import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
const RESOURCES = path.join(DIST, 'resources');
const BUNDLE = path.join(RESOURCES, 'sap-ui-custom.js');

/** The libraries the page loads, as ui5.yaml names them. */
const LIBRARIES = ['sap/ui/core', 'sap/m', 'sap/ui/unified'];
/** The themes the page can show: light and dark. */
const THEMES = ['sap_horizon', 'sap_horizon_dark'];
/** The statement the self-contained bundle ends with; the embedded files go in front of it. */
const BOOT = 'sap.ui.require(["sap/ui/core/Core"]';

/** Everything OpenUI5 would fetch at run time, by the name its loader knows it under. */
const embedded = [
  ...LIBRARIES.flatMap((library) => [
    `${library}/messagebundle.properties`,
    `${library}/messagebundle_en.properties`,
  ]),
  'sap/ui/core/cldr/en.json',
];

// An application build writes no version file, and the framework asks for one all the same.
const preload = {
  'sap-ui-version.json': JSON.stringify({
    name: 'serial-broker.terminal',
    version: '0.0.0',
    libraries: [],
  }),
};
for (const name of embedded) {
  preload[name] = await readFile(path.join(RESOURCES, name), 'utf8');
}

const bundle = await readFile(BUNDLE, 'utf8');

// The application's own texts, unless the bundler has put them in already.
const APP_TEXTS = 'serialbroker/terminal/i18n/i18n.properties';
if (!bundle.includes(`"${APP_TEXTS}"`)) {
  preload[APP_TEXTS] = await readFile(path.join(DIST, 'i18n', 'i18n.properties'), 'utf8');
}
const at = bundle.lastIndexOf(BOOT);
if (at === -1) {
  process.stderr.write(`${BUNDLE} does not end with the boot statement this script looks for.\n`);
  process.exit(1);
}
await writeFile(
  BUNDLE,
  `${bundle.slice(0, at)}sap.ui.require.preload(${JSON.stringify(preload)}, "serialbroker/terminal/run-from-a-file");\n${bundle.slice(at)}`,
);

/**
 * Whether a file under `resources/` can still be asked for by the built page.
 *
 * The bundle holds what the application requires statically. The framework requires more on its
 * own at run time - a calendar, a lazy part of a library - and loads those with a script element,
 * which a page opened from a file may do. So every module stays; what goes is what no page loads:
 * debug sources, source maps, theme sources, right-to-left style sheets, and the texts and locale
 * data of languages the page never shows.
 */
function isNeeded(relative) {
  const name = relative.split(path.sep).join('/');
  if (name === 'sap-ui-custom.js.map') {
    return true;
  }
  if (name.includes('/themes/')) {
    const shown =
      THEMES.some((theme) => name.includes(`/themes/${theme}/`)) || name.includes('/themes/base/');
    return shown && !name.endsWith('.less') && !name.includes('-RTL') && !name.endsWith('.json');
  }
  return name.endsWith('.js') && !name.endsWith('-dbg.js');
}

async function prune(directory) {
  let kept = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const inside = await prune(full);
      if (inside === 0) {
        await rm(full, { recursive: true, force: true });
      }
      kept += inside;
    } else if (isNeeded(path.relative(RESOURCES, full))) {
      kept += 1;
    } else {
      await rm(full);
    }
  }
  return kept;
}

const kept = await prune(RESOURCES);
await rm(path.join(DIST, 'test-resources'), { recursive: true, force: true });
// `?stand-in` is for trying the terminal without hardware, and has no business on a station.
for (const file of ['stand-in.js', 'stand-in.js.map']) {
  await rm(path.join(DIST, 'serial-broker', file), { force: true });
}
// Types for `npm run typecheck`, which no browser asks for.
await rm(path.join(DIST, 'types.d.ts'), { force: true });
for (const entry of await readdir(DIST, { recursive: true })) {
  if (entry.endsWith('-dbg.js') || entry.endsWith('-dbg.js.map')) {
    await rm(path.join(DIST, entry), { force: true });
  }
}

const size = (await stat(BUNDLE)).size;
process.stdout.write(
  `Embedded ${String(Object.keys(preload).length)} run-time files into sap-ui-custom.js (${String(Math.round(size / 1024))} KB); ` +
    `${String(kept)} framework files kept.\n`,
);
process.stdout.write('Open dist/index.html in Chrome or Edge, or copy the folder anywhere.\n');
