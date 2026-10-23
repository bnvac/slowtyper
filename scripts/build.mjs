// Builds browser packages into dist/:
//   dist/chrome/   + dist/slowtyper-chrome-<ver>.zip
//   dist/firefox/  + dist/slowtyper-firefox-<ver>.zip (zip = .xpi for AMO)
// The Firefox manifest is derived from manifest.json so versions never drift.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const FILES = ['src', 'popup', 'icons'];
const base = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

export function firefoxManifest(m) {
  const out = structuredClone(m);
  // Firefox MV3 has no service workers: load the engine, then the background script.
  out.background = { scripts: ['src/engine.js', 'src/background.js'] };
  // No chrome.debugger in Firefox, so trusted mode is unavailable.
  out.permissions = out.permissions.filter((p) => p !== 'debugger');
  out.host_permissions = ['<all_urls>'];
  out.browser_specific_settings = {
    gecko: {
      id: 'slowtyper@bnvac.github.io',
      strict_min_version: '142.0',
      data_collection_permissions: { required: ['none'] },
    },
  };
  return out;
}

function build(name, manifest) {
  const dir = path.join(dist, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) fs.cpSync(path.join(root, f), path.join(dir, f), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const zip = path.join(dist, `slowtyper-${name}-${manifest.version}.zip`);
  fs.rmSync(zip, { force: true });
  try {
    execFileSync('zip', ['-qr', zip, '.'], { cwd: dir });
    console.log(`built ${path.relative(root, dir)}/ and ${path.relative(root, zip)}`);
  } catch {
    console.log(`built ${path.relative(root, dir)}/ (no "zip" command found; skipped the archive)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const which = process.argv[2];
  if (!which || which === 'chrome') build('chrome', base);
  if (!which || which === 'firefox') build('firefox', firefoxManifest(base));
}
