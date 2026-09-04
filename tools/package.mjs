/**
 * Builds the Chrome Web Store upload artifact.
 *
 *   npm run package     ->  dist/bugpin-<version>.zip
 *
 * The store rejects an archive that carries anything it cannot account for, and
 * reviewers read whatever is in it, so the contents are an explicit allowlist
 * rather than "the repo minus some ignores": the manifest, the extension's own
 * scripts and pages, the icons, and the lib modules. Tests, tooling, docs and
 * the demo app stay out.
 *
 * Fails loudly instead of shipping something wrong — a missing file, a version
 * that disagrees with package.json, or a file the manifest never references.
 */
import { readFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const fail = (message) => {
  console.error(`package: ${message}`);
  process.exit(1);
};

if (manifest.version !== pkg.version) {
  fail(`manifest.json is ${manifest.version} but package.json is ${pkg.version}`);
}

/** Everything the extension needs at runtime, and nothing else. */
const FILES = [
  'manifest.json',
  'background.js',
  'content-annotate.js',
  'content-bridge.js',
  'content-console-inject.js',
  'popup.html',
  'popup.js',
  'options.html',
  'options.js',
  ...readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).sort().map((f) => `lib/${f}`),
  ...Object.values(manifest.icons),
];

const missing = FILES.filter((f) => !existsSync(join(ROOT, f)));
if (missing.length) fail(`missing from the working tree: ${missing.join(', ')}`);

// Anything the manifest names must actually be in the archive.
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...manifest.content_scripts.flatMap((cs) => cs.js),
  ...manifest.web_accessible_resources.flatMap((war) => war.resources),
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
const unshipped = [...new Set(referenced)].filter((f) => !FILES.includes(f));
if (unshipped.length) fail(`referenced by manifest.json but not packaged: ${unshipped.join(', ')}`);

const zipName = `bugpin-${manifest.version}.zip`;
const zipPath = join(DIST, zipName);
rmSync(zipPath, { force: true });
mkdirSync(DIST, { recursive: true });

// -X drops the extended attributes and resource forks macOS would otherwise
// bury in the archive; the store flags them as unexplained files.
execFileSync('zip', ['-q', '-r', '-X', zipPath, ...FILES], { cwd: ROOT });

const bytes = statSync(zipPath).size;
console.log(`${relative(ROOT, zipPath)} — ${FILES.length} files, ${(bytes / 1024).toFixed(1)} KB`);
console.log(`version ${manifest.version}, minimum Chrome ${manifest.minimum_chrome_version ?? 'unset'}`);
console.log('\ncontents:');
for (const f of FILES) console.log(`  ${f}`);
