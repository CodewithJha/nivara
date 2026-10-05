// "Cheapest online" only counts a listing that is plausibly the same product and pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparableOffer } from '../src/logic.ts';

const o = (price: number, title: string) => ({ price, title });
test('comparableOffer skips sachets and other brands', () => {
  const offers = [o(819, 'MuscleBlaze Biozyme Performance Whey Protein Sachets'), o(1549, 'MuscleBlaze Biozyme Clear Whey Isolate'), o(1443, 'GetmyMettle Alpha Whey Protein'), o(16199, 'MuscleBlaze Biozyme Performance Whey Protein 4kg')];
  assert.equal(comparableOffer('MB biozyme whey', 2599, offers)?.price, 1549);
  assert.equal(comparableOffer('MYPROTEIN Impact Whey Protein Strawberry Cream', 7449, [o(1443, 'GetmyMettle Alpha Whey Protein'), o(9900, 'Impact (, 1kg)')])?.price, 9900);
});
test('comparableOffer: generic names use the price band only; nothing close gives null', () => {
  assert.equal(comparableOffer('Whey', 6949, [o(197, 'GNC Pro-performance 100% Whey'), o(4599, 'MyProtein Impact Whey')])?.price, 4599);
  assert.equal(comparableOffer('Chyawanprash Awaleha', 399, [o(114, 'Dabur Chyawanprash 250G')]), null);
});
