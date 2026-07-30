import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(
  path.join(root, 'src/shared/countries.js'),
  'utf8'
);
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);

const { getFlag, normalizeCountryName } = context.window;

test('country names and ISO codes resolve case-insensitively', () => {
  assert.equal(getFlag('United States'), '🇺🇸');
  assert.equal(getFlag('gb'), '🇬🇧');
  assert.equal(getFlag('brasil'), '🇧🇷');
});

test('store suffixes are normalized before flag lookup', () => {
  assert.equal(getFlag('Canada App Store'), '🇨🇦');
  assert.equal(getFlag('Japan Play Store'), '🇯🇵');
  assert.equal(normalizeCountryName('France Google Store'), 'France');
});

test('unknown and empty values do not create a flag', () => {
  assert.equal(getFlag('Atlantis'), null);
  assert.equal(getFlag(''), null);
  assert.equal(getFlag(null), null);
});
