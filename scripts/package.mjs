// Build store-ready zips in dist/:
//   x-flags-chrome-<version>.zip   (Chrome Web Store)
//   x-flags-firefox-<version>.zip  (addons.mozilla.org)
//
// Each zip gets a manifest trimmed for its browser: Chrome only uses
// background.service_worker; Firefox only uses background.scripts.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const INCLUDE = ['src', 'icons'];

function chromeManifest() {
  const result = structuredClone(manifest);
  delete result.browser_specific_settings;
  delete result.background.scripts;
  return result;
}

function firefoxManifest() {
  const result = structuredClone(manifest);
  delete result.background.service_worker;
  return result;
}

async function build(target, targetManifest) {
  const stageDir = path.join(dist, target);
  const zipPath = path.join(dist, `x-flags-${target}-${manifest.version}.zip`);

  await rm(stageDir, { recursive: true, force: true });
  await rm(zipPath, { force: true });
  await mkdir(stageDir, { recursive: true });

  for (const entry of INCLUDE) {
    await cp(path.join(root, entry), path.join(stageDir, entry), {
      recursive: true,
      filter: source => !path.basename(source).startsWith('.')
    });
  }
  await writeFile(
    path.join(stageDir, 'manifest.json'),
    JSON.stringify(targetManifest, null, 2) + '\n'
  );

  const result = spawnSync('zip', ['-r', '-X', '-q', zipPath, '.'], {
    cwd: stageDir,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`zip failed for ${target}`);
  }

  console.log(`Built ${path.relative(root, zipPath)}`);
}

await build('chrome', chromeManifest());
await build('firefox', firefoxManifest());
