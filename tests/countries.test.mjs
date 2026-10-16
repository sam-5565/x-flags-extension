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

const { getFlag, getCountryCode, normalizeCountryName } = context.window;

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

test('diacritics, punctuation and alternative names resolve', () => {
  assert.equal(getFlag('Türkiye'), '🇹🇷');
  assert.equal(getFlag("Côte d'Ivoire"), '🇨🇮');
  assert.equal(getFlag('São Tomé and Príncipe'), '🇸🇹');
  assert.equal(getFlag('The Netherlands'), '🇳🇱');
  assert.equal(getFlag('United States of America'), '🇺🇸');
  assert.equal(getFlag('St. Lucia'), '🇱🇨');
  assert.equal(getFlag('Bosnia & Herzegovina'), '🇧🇦');
});

test('previously missing countries and territories resolve', () => {
  assert.equal(getFlag('Kosovo'), '🇽🇰');
  assert.equal(getFlag('Democratic Republic of the Congo'), '🇨🇩');
  assert.equal(getFlag('Greenland'), '🇬🇱');
  assert.equal(getFlag('Puerto Rico'), '🇵🇷');
  assert.equal(getFlag('CD'), '🇨🇩');
});

test('connected-via sources are reduced to their region', () => {
  assert.equal(normalizeCountryName('Europe Android App'), 'Europe');
  assert.equal(normalizeCountryName('United States App Store'), 'United States');
  assert.equal(normalizeCountryName('Web'), 'Web');
  assert.equal(getFlag('India Android App'), '🇮🇳');
});

test('country codes identify countries but not regions', () => {
  assert.equal(getCountryCode('United States'), 'US');
  assert.equal(getCountryCode('US App Store'), 'US');
  assert.equal(getCountryCode('England'), 'GB');
  assert.equal(getCountryCode('Europe'), null);
  assert.equal(getCountryCode('South Asia'), null);
  assert.equal(getCountryCode('Atlantis'), null);
});

test('object prototype names never resolve to a flag', () => {
  for (const name of ['constructor', 'Constructor', '__proto__', 'hasOwnProperty', 'toString']) {
    assert.equal(getFlag(name), null, name);
    assert.equal(getCountryCode(name), null, name);
  }
});

test('punctuated and reordered country names resolve', () => {
  assert.equal(getFlag('Congo - Kinshasa'), '🇨🇩');
  assert.equal(getFlag('Myanmar (Burma)'), '🇲🇲');
  assert.equal(getFlag('St. Helena'), '🇸🇭');
  assert.equal(getFlag('Bahamas, The'), '🇧🇸');
  assert.equal(getFlag('Guinea Bissau'), '🇬🇼');
  assert.equal(getFlag('Micronesia, Federated States of'), '🇫🇲');
});
