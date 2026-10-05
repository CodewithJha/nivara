// Hinglish voice notes: "Rahul bhai ko do MB biozyme whey bhej dena kal tak" often comes back half in Devanagari.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCustomer, resolveDate } from '../src/logic.ts';

const customers = [{ _id: 'C01', name: 'Rahul Verma' }, { _id: 'C02', name: 'Priya Singh' }];

test('a form of address after the name does not make a new customer', () => {
  assert.equal(matchCustomer('Rahul bhai', customers)?._id, 'C01');
  assert.equal(matchCustomer('Priya ji', customers)?._id, 'C02');
  assert.equal(matchCustomer('Rahul Verma', customers)?._id, 'C01');
  assert.equal(matchCustomer('Rohit bhai', customers), null);
});

test('delivery words in Devanagari and Roman Hinglish resolve like English', () => {
  const today = '2026-10-05';
  assert.equal(resolveDate('कल', today), '2026-10-06');
  assert.equal(resolveDate('कल तक', today), '2026-10-06');
  assert.equal(resolveDate('kal tak', today), '2026-10-06');
  assert.equal(resolveDate('आज शाम', today), today);
  assert.equal(resolveDate('परसों', today), '2026-10-07');
  assert.equal(resolveDate('parson', today), '2026-10-07');
  assert.equal(resolveDate('निकल', today), null); // "kal" inside another word is not tomorrow
});
