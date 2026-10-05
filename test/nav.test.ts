// The phone menu reuses the laptop <nav>: one link list, a real button wired to it, and nav.js loaded deferred.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../public/nav.js', import.meta.url), 'utf8');

test('menu button controls the nav and starts closed', () => {
  const btn = html.match(/<button class="burger"[^>]*>/)?.[0] ?? '';
  assert.match(btn, /type="button"/);
  assert.match(btn, /aria-label="Menu"/);
  assert.match(btn, /aria-expanded="false"/);
  const id = btn.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(id && new RegExp(`<nav [^>]*id="${id}"`).test(html), 'aria-controls points at the nav');
});

test('one link list: every page is linked once, from the nav', () => {
  const nav = html.match(/<nav [\s\S]*?<\/nav>/)?.[0] ?? '';
  const hrefs = [...nav.matchAll(/href="(#[a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(hrefs, ['#dashboard', '#assistant', '#orders', '#inventory', '#forecast', '#suppliers', '#workflows', '#activity', '#health']);
  for (const h of hrefs.slice(1)) assert.equal(html.split(`href="${h}"`).length - 1, 1, `${h} appears once`);
  assert.doesNotMatch(html, /popover/);
});

test('nav.js is deferred and handles every way to close', () => {
  assert.match(html, /<script src="nav.js" defer><\/script>/);
  for (const s of ['Escape', 'hashchange', "'Tab'", 'inert', 'aria-expanded', 'phone.addEventListener(\'change\'']) assert.ok(js.includes(s), s);
});
