import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = await Promise.all([
  'src/shared/constants.js',
  'src/shared/countries.js',
  'src/content/badge-injector.js'
].map(file => readFile(path.join(root, file), 'utf8')));

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  contains(className) {
    return this.element.className.split(/\s+/).includes(className);
  }

  add(className) {
    const classes = new Set(this.element.className.split(/\s+/).filter(Boolean));
    classes.add(className);
    this.element.className = [...classes].join(' ');
  }
}

class FakeElement {
  constructor() {
    this.children = [];
    this.className = '';
    this.classList = new FakeClassList(this);
    this.isConnected = true;
    this.attributes = new Map();
    this.textContent = '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  querySelectorAll() {
    return [];
  }

  addEventListener() {}
}

function loadBadgeInjector() {
  const context = vm.createContext({
    console,
    document: {
      createElement() {
        return new FakeElement();
      }
    },
    self: {},
    window: {}
  });

  for (const source of sources) {
    vm.runInContext(source, context);
  }

  return context.window.BadgeInjector;
}

test('suspended profiles use the suspended-account badge', () => {
  const badgeInjector = loadBadgeInjector();
  badgeInjector.init({});

  const badge = badgeInjector.createBadge({ isSuspended: true });

  assert.equal(badge.children.length, 1);
  assert.equal(badge.children[0].textContent, '🚫');
  assert.equal(
    badge.children[0].attributes.get('data-tooltip'),
    'Account suspended'
  );
});

function tooltips(badge) {
  return badge.children.map(child => child.attributes.get('data-tooltip'));
}

function hasMismatch(badge) {
  return badge.children.some(child => child.className.includes('x-flag-mismatch'));
}

test('same country written two ways is not a mismatch', () => {
  const badgeInjector = loadBadgeInjector();
  badgeInjector.init({});

  const badge = badgeInjector.createBadge({
    basedIn: { country: 'United States', raw: 'United States' },
    connectedVia: { country: 'US', raw: 'US App Store' }
  });

  assert.equal(hasMismatch(badge), false);
  assert.deepEqual(tooltips(badge), [
    'Account based in: United States',
    'Connected via: US App Store'
  ]);
});

test('different countries are highlighted, regions are not', () => {
  const badgeInjector = loadBadgeInjector();
  badgeInjector.init({});

  assert.equal(hasMismatch(badgeInjector.createBadge({
    basedIn: { country: 'Germany' },
    connectedVia: { country: 'Nigeria', raw: 'Nigeria App Store' }
  })), true);

  assert.equal(hasMismatch(badgeInjector.createBadge({
    basedIn: { country: 'Germany' },
    connectedVia: { country: 'Europe', raw: 'Europe Android App' }
  })), false);
});

test('join year tooltip includes month and username changes', () => {
  const badgeInjector = loadBadgeInjector();
  badgeInjector.init({});

  const badge = badgeInjector.createBadge({
    joinedYear: 2014,
    joinedMonth: 'Mar',
    usernameChanges: 2
  });

  assert.equal(badge.children[0].textContent, "'14");
  assert.equal(tooltips(badge)[0], 'Joined Mar 2014 · username changed 2 times');
});

test('hidden settings produce no badge', () => {
  const badgeInjector = loadBadgeInjector();
  badgeInjector.init({ showBasedIn: false, showConnectedVia: false, showYear: false });

  assert.equal(badgeInjector.createBadge({
    basedIn: { country: 'France' },
    joinedYear: 2020
  }), null);
});
