import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const packageJson = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8')
);

assert.equal(manifest.manifest_version, 3, 'manifest_version must be 3');
assert.equal(
  packageJson.version,
  manifest.version,
  'package.json and manifest.json versions must match'
);

const referencedFiles = new Set([
  manifest.background?.service_worker,
  ...(manifest.background?.scripts || []),
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {})
]);

for (const contentScript of manifest.content_scripts || []) {
  for (const file of [...(contentScript.js || []), ...(contentScript.css || [])]) {
    referencedFiles.add(file);
  }
}

for (const relativePath of referencedFiles) {
  if (!relativePath) continue;
  await access(path.join(root, relativePath));
}

// Firefox runs the background as an event page without importScripts(), so
// background.scripts must list every file the service worker imports, in
// order, followed by the worker itself.
const backgroundSource = await readFile(
  path.join(root, manifest.background.service_worker),
  'utf8'
);
const importList = backgroundSource.match(/importScripts\((\s*'[^)]*)\)/);
assert.ok(importList, 'background service worker must call importScripts()');
const workerDir = path.dirname(manifest.background.service_worker);
const importedFiles = [...importList[1].matchAll(/'([^']+)'/g)]
  .map(match => path.posix.normalize(path.posix.join(workerDir, match[1])));
assert.deepEqual(
  manifest.background.scripts,
  [...importedFiles, manifest.background.service_worker],
  'background.scripts must match the service worker importScripts() list'
);

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }

  return files;
}

const javaScriptFiles = await collectJavaScriptFiles(path.join(root, 'src'));
for (const file of javaScriptFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8'
  });
  assert.equal(
    result.status,
    0,
    `Syntax check failed for ${path.relative(root, file)}:\n${result.stderr}`
  );
}

console.log(
  `Validated ${referencedFiles.size} manifest paths and ` +
  `${javaScriptFiles.length} JavaScript files.`
);
