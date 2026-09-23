import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateGiveaway, evaluateIncentive } from './giveaway.js';

test('calcula el Giveaway como exceso porcentual sobre el objetivo', () => {
  assert.ok(Math.abs(calculateGiveaway(100.06, 100) - 0.06) < 1e-12);
});

test('asigna el limite inferior al tramo optimo correcto', () => {
  assert.equal(evaluateIncentive(0.06).tier, 9);
  assert.equal(evaluateIncentive(0.16).tier, 8);
});

test('penaliza valores sobre 0.94%', () => {
  const result = evaluateIncentive(1.2);
  assert.equal(result.tier, 1);
  assert.equal(result.factor, 0);
  assert.equal(result.tone, 'penalized');
});

test('rechaza un peso objetivo invalido', () => {
  assert.throws(() => calculateGiveaway(10, 0), RangeError);
});
