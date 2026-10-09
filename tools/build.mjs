#!/usr/bin/env node
/**
 * Builds the publishable extension artifacts: one zip per browser.
 *
 * Usage: node tools/build.mjs [--target=chrome|firefox|all]   (default: all)
 *
 * Why a build is needed at all, when "load unpacked" works without one:
 *
 * 1. The manifest in the repo is dual-target — it holds Chrome keys
 *    (`background.service_worker`, `side_panel`, `minimum_chrome_version`) and
 *    Firefox keys (`background.scripts`, `browser_specific_settings`,
 *    `sidebar_action`) at the same time. Both browsers accept such a file and
 *    ignore the extra keys, which is handy during development. But Chrome Web
 *    Store review complains about foreign keys, and AMO about chrome-only
 *    ones, so the zip ships a manifest stripped of everything not relevant to
 *    the target browser.
 * 2. Internal network addresses. Not a single http(s) URL with a private or
 *    loopback host (localhost, 127.x, RFC 1918 private networks) may end up
 *    in the artifact: store users don't need them, and permissions for them in
 *    the manifest are one more reason for review rejection. If such a URL is
 *    found in any text file of the artifact, the build fails.
 * 3. Version. `manifest.json` and `package.json` once drifted apart (0.2.0 vs
 *    0.1.0). Here the version is taken from `package.json` and written into
 *    the artifact manifest, so they have nowhere left to drift.
 *
 * The script is deliberately paranoid: the file list is explicit (no globbing
 * over the whole tree — a stray file in the repo must not be able to ship to
 * the store), and the tree is also walked the other way round, so that a new
 * runtime file missing from the list fails the build. Exactly this mistake
 * has happened before: the hand-built 0.2.0 zip lacked the `panel/` and
 * `shared/` folders entirely.
 *
 * No dependencies: the zip is written by hand via `node:zlib`.
 */

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(ROOT, 'build');
const DIST_DIR = path.join(ROOT, 'dist');

/**
 * The complete list of artifact files. This is the source of truth: exactly
 * these files are copied.
 *
 * `welcome/*` is not referenced in the manifest — the page is opened from the
 * worker via `chrome.tabs.create` (`WELCOME_URL` in `background/service-worker.js`). A naive
 * "follow the manifest references" walk would miss it, which is why the list
 * is maintained by hand.
 */
const FILES = [
  'manifest.json',

  'background/service-worker.js',
  'background/bookmark-sync.js',

  'lib/environments.js',
  'lib/api.js',
  'lib/widgets.js',
  'lib/tasks.js',
  'lib/oauth.js',
  'lib/storage.js',
  'lib/mirror.js',
  'lib/browser.js',
  'lib/errors.js',
  'lib/url.js',
  'lib/calendar.js',
  'lib/memo.js',

  'content/token-bridge.js',

  'shared/send.js',

  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',

  'panel/panel.html',
  'panel/panel.css',
  'panel/panel.js',
  'panel/panel-common.js',
  'panel/panel-tasks.js',
  'panel/panel-memo.js',
  'panel/panel-calendar.js',

  'options/options.html',
  'options/options.js',

  'welcome/welcome.html',
  'welcome/welcome.css',
  'welcome/welcome.js',

  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

/**
 * Folders that belong entirely to the runtime: every .js/.css/.html file in
 * them must be listed in FILES. This guards against the opposite mistake — a
 * new file was added but not listed. Better to fail the build than to ship
 * the extension with half of its code missing.
 */
const RUNTIME_DIRS = ['background', 'lib', 'content', 'shared', 'popup', 'panel', 'options', 'welcome'];
const RUNTIME_EXTENSIONS = new Set(['.js', '.css', '.html']);

/**
 * An http(s) URL with a private or loopback host. Must never appear in the
 * artifact. The host must not be followed by a letter, digit, dot or hyphen —
 * otherwise, e.g., `localhost.example.com` would count as internal.
 */
const PRIVATE_URL_PATTERN = new RegExp(
  String.raw`\bhttps?://(?:localhost|\[::1\]|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}` +
    String.raw`|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?![\w.-])`,
  'i'
);

/**
 * What each browser understands and what is junk to it.
 *
 * Chrome: a service worker and `side_panel`. `background.scripts` is a
 * Firefox key; Chrome ignores it but shows a yellow warning on the extension
 * card, and store review nitpicks about foreign keys.
 *
 * Firefox: an event background page (`background.scripts`), because it does
 * not support background service workers (bug 1573659), and `sidebar_action`
 * instead of `side_panel`. `minimum_chrome_version` is meaningless there; the
 * minimum version is set by `browser_specific_settings.gecko.strict_min_version`.
 */
const TARGETS = {
  chrome: {
    dropManifestKeys: [['background', 'scripts'], ['browser_specific_settings'], ['sidebar_action']],
    // Keys that must never be present in the final manifest.
    forbiddenManifestKeys: [['background', 'scripts'], ['browser_specific_settings'], ['sidebar_action']],
  },
  firefox: {
    dropManifestKeys: [['background', 'service_worker'], ['side_panel'], ['minimum_chrome_version']],
    forbiddenManifestKeys: [['background', 'service_worker'], ['side_panel'], ['minimum_chrome_version']],
  },
};

class BuildError extends Error {}

/**
 * Reads JSON from the project root. A separate wrapper so that a typo in
 * `manifest.json` or `package.json` produces a clear message rather than a
 * JSON.parse stack trace that doesn't even show the file name.
 */
function readJson(relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
  } catch (error) {
    return fail(`${relative}: failed to parse as JSON — ${error.message}`);
  }
}

function fail(message) {
  throw new BuildError(message);
}

const log = (message) => process.stdout.write(`${message}\n`);

// ──────────────────────────────── syntax check ─────────────────────────────────

/**
 * Checks that the file parses as an ES module at all.
 *
 * This is caught with a real parser: `node --input-type=module --check` reads
 * the source from stdin without executing it. `content/token-bridge.js` is a
 * classic script, not a module, but it is wrapped in an IIFE and parses as a
 * module too: module parsing is stricter, so a file that passes this check is
 * guaranteed to be valid as a script as well.
 */
function assertParses(source, label) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: source,
    encoding: 'utf8',
  });
  if (result.error) fail(`${label}: failed to run the syntax check: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label}: file does not parse as an ES module:\n${(result.stderr || '').trim()}`);
  }
}

// ──────────────────────────────────── manifest ─────────────────────────────────

function deleteKeyPath(object, keyPath) {
  let node = object;
  for (const key of keyPath.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return false;
    node = node[key];
  }
  const last = keyPath.at(-1);
  if (node === null || typeof node !== 'object' || !(last in node)) return false;
  delete node[last];
  return true;
}

function hasKeyPath(object, keyPath) {
  let node = object;
  for (const key of keyPath) {
    if (node === null || typeof node !== 'object' || !(key in node)) return false;
    node = node[key];
  }
  return true;
}

function buildManifest(sourceManifest, target, version) {
  const manifest = structuredClone(sourceManifest);
  const { dropManifestKeys } = TARGETS[target];

  for (const keyPath of dropManifestKeys) {
    if (!deleteKeyPath(manifest, keyPath)) {
      fail(
        `manifest.json: target ${target} must drop key ${keyPath.join('.')}, but it is not there. ` +
          'The source manifest has changed — update TARGETS in tools/build.mjs.'
      );
    }
  }

  // The version always comes from package.json: two places holding a version
  // number drift apart sooner or later, and this has already happened once.
  manifest.version = version;

  return manifest;
}

/**
 * All paths referenced by the manifest. If even one is missing from the
 * artifact, the extension breaks right at install time, not some time later.
 */
function manifestReferencedPaths(manifest) {
  const paths = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) paths.push(value);
  };

  push(manifest.background?.service_worker);
  for (const script of manifest.background?.scripts || []) push(script);
  for (const entry of manifest.content_scripts || []) {
    for (const file of entry.js || []) push(file);
    for (const file of entry.css || []) push(file);
  }
  for (const value of Object.values(manifest.icons || {})) push(value);
  for (const value of Object.values(manifest.action?.default_icon || {})) push(value);
  for (const value of Object.values(manifest.sidebar_action?.default_icon || {})) push(value);
  push(manifest.side_panel?.default_path);
  push(manifest.sidebar_action?.default_panel);
  push(manifest.options_page);
  push(manifest.action?.default_popup);

  return [...new Set(paths)];
}

// ───────────────────────────────────── zip ─────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

// Fixed timestamp 2020-01-01 12:00:00 in MS-DOS format. Real file dates would
// make the zip non-reproducible: two builds of the same commit must produce
// byte-identical archives. Some unzippers dislike zero (1980-01-01), so an
// "ordinary" date is used.
const DOS_TIME = 12 << 11;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;
const VERSION_NEEDED = 20;
// High byte is "made on UNIX", low byte is the spec version. Needed so that
// the external attributes (0644 permissions) are read as unix permissions.
const VERSION_MADE_BY = (3 << 8) | 20;
// `>>> 0` is required: JS shifts are 32-bit signed, so 0o100644 << 16 goes
// negative, and writeUInt32LE does not accept that.
const EXTERNAL_ATTRS_FILE = (0o100644 << 16) >>> 0;

/**
 * Writes a plain zip: local headers, central directory, EOCD.
 *
 * A custom implementation instead of `/usr/bin/zip`, so the build does not
 * depend on what is installed on the system, and file order and timestamps
 * stay fixed. Zip64 and encryption are not needed: the extension is a few
 * dozen small files.
 */
function createZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(EXTERNAL_ATTRS_FILE, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

/**
 * Reads the built archive the way an unzipper would: from EOCD to the central
 * directory, from there via offsets to the local headers — and compares the
 * contents with what was put in. This covers exactly the case where the zip
 * was "written" but cannot be opened: a broken archive in the store is the
 * worst possible outcome, because we learn about it from a reviewer a week
 * later.
 */
function verifyZip(buffer, entries) {
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset < 0) fail('zip: EOCD not found');
  const total = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (total !== entries.length) fail(`zip: directory has ${total} entries instead of ${entries.length}`);
  if (centralOffset + centralSize !== eocdOffset) fail('zip: central directory does not match EOCD');

  const expected = new Map(entries.map((entry) => [entry.name, entry.data]));
  let cursor = centralOffset;
  for (let i = 0; i < total; i += 1) {
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) fail(`zip: broken directory entry #${i + 1}`);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) fail(`zip: broken local header ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const compressedSize = buffer.readUInt32LE(localOffset + 18);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize));

    const want = expected.get(name);
    if (!want) fail(`zip: unexpected file in archive: ${name}`);
    if (!data.equals(want)) fail(`zip: contents of ${name} do not match the source`);
    if (crc32(data) !== buffer.readUInt32LE(cursor + 16)) fail(`zip: CRC mismatch for ${name}`);
    expected.delete(name);

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (expected.size > 0) fail(`zip: files missing from archive: ${[...expected.keys()].join(', ')}`);
}

// ──────────────────────────────────── build ────────────────────────────────────

function walk(dir, base = dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, base));
    else if (entry.isFile()) found.push(path.relative(base, full));
  }
  return found;
}

/** A new runtime file not listed in FILES must fail the build, not get silently lost. */
function assertNoUnlistedRuntimeFiles() {
  const listed = new Set(FILES.map((file) => file.split(path.sep).join('/')));
  const unlisted = [];
  for (const dir of RUNTIME_DIRS) {
    const absolute = path.join(ROOT, dir);
    if (!fs.existsSync(absolute)) fail(`folder ${dir}/ does not exist, but it is listed as a runtime folder`);
    for (const relative of walk(absolute)) {
      if (!RUNTIME_EXTENSIONS.has(path.extname(relative))) continue;
      const key = `${dir}/${relative.split(path.sep).join('/')}`;
      if (!listed.has(key)) unlisted.push(key);
    }
  }
  if (unlisted.length > 0) {
    fail(
      `these files are in runtime folders but not listed in FILES (tools/build.mjs):\n` +
        unlisted.map((file) => `  ${file}`).join('\n') +
        '\nIf the extension needs the file, add it to the list; if not, move it out of the runtime folder.'
    );
  }
}

const TEXT_EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.md', '.txt', '.svg']);

function buildTarget(target, sourceManifest, version) {
  const stageDir = path.join(BUILD_DIR, target);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const manifest = buildManifest(sourceManifest, target, version);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  // 1. Lay out the files in staging.
  for (const relative of FILES) {
    const source = path.join(ROOT, relative);
    if (!fs.existsSync(source)) fail(`file listed in FILES is missing on disk: ${relative}`);

    const destination = path.join(stageDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    if (relative === 'manifest.json') {
      fs.writeFileSync(destination, manifestText);
      continue;
    }
    fs.copyFileSync(source, destination);
  }

  // 2. Checks against what actually ended up in staging.
  const staged = walk(stageDir).map((file) => file.split(path.sep).join('/')).sort();

  const emittedManifest = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(stageDir, 'manifest.json'), 'utf8'));
    } catch (error) {
      return fail(`artifact manifest does not parse as JSON: ${error.message}`);
    }
  })();

  if (emittedManifest.version !== version) {
    fail(`manifest version (${emittedManifest.version}) does not match package.json (${version})`);
  }

  for (const keyPath of TARGETS[target].forbiddenManifestKeys) {
    if (hasKeyPath(emittedManifest, keyPath)) {
      fail(`manifest for target ${target} still contains foreign key ${keyPath.join('.')}`);
    }
  }

  for (const referenced of manifestReferencedPaths(emittedManifest)) {
    if (!fs.existsSync(path.join(stageDir, referenced))) {
      fail(`manifest references ${referenced}, but the artifact has no such file`);
    }
  }

  for (const relative of staged) {
    const absolute = path.join(stageDir, relative);
    const extension = path.extname(relative);
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    const lines = text.split('\n');
    const lineIndex = lines.findIndex((value) => PRIVATE_URL_PATTERN.test(value));
    if (lineIndex >= 0) {
      const found = lines[lineIndex].match(PRIVATE_URL_PATTERN)[0];
      fail(`artifact still contains an internal network URL "${found}": ${relative}:${lineIndex + 1}`);
    }
    if (extension === '.js') assertParses(text, `${relative} (in artifact)`);
  }

  // 3. Archive. Manifest first, the rest alphabetically — the order is fixed.
  const order = ['manifest.json', ...staged.filter((file) => file !== 'manifest.json')];
  const entries = order.map((name) => ({ name, data: fs.readFileSync(path.join(stageDir, name)) }));
  const zipBuffer = createZip(entries);
  verifyZip(zipBuffer, entries);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  for (const stale of fs.readdirSync(DIST_DIR)) {
    if (stale.startsWith(`memo-bookmarks-${target}-`) && stale.endsWith('.zip')) {
      fs.rmSync(path.join(DIST_DIR, stale));
    }
  }
  const zipPath = path.join(DIST_DIR, `memo-bookmarks-${target}-${version}.zip`);
  fs.writeFileSync(zipPath, zipBuffer);

  log(`  files: ${entries.length}, staging: ${path.relative(ROOT, stageDir)}/`);
  log(`  archive: ${path.relative(ROOT, zipPath)} (${zipBuffer.length} bytes)`);

  return { target, zipPath, files: entries.length };
}

function main() {
  const argument = process.argv.slice(2).find((value) => value.startsWith('--target='));
  const requested = argument ? argument.slice('--target='.length) : 'all';
  const targets = requested === 'all' ? Object.keys(TARGETS) : [requested];
  for (const target of targets) {
    if (!(target in TARGETS)) {
      fail(`unknown target "${target}". Available: ${Object.keys(TARGETS).join(', ')}, all`);
    }
  }

  const version = readJson('package.json').version;
  if (typeof version !== 'string' || version.length === 0) {
    fail('package.json: the version field is missing, and the artifact version is taken from it');
  }
  const sourceManifest = readJson('manifest.json');

  assertNoUnlistedRuntimeFiles();
  log(`Memo Bookmarks ${version} → ${targets.join(', ')}`);

  const results = targets.map((target) => {
    log(`\n[${target}]`);
    return buildTarget(target, sourceManifest, version);
  });

  log('\nDone:');
  for (const result of results) log(`  ${path.relative(ROOT, result.zipPath)} — ${result.files} files`);
}

try {
  main();
} catch (error) {
  if (error instanceof BuildError) {
    process.stderr.write(`\nBuild stopped: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
