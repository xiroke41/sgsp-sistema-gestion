import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { calculateShiftPerformance, calculateShiftPerformanceFromGiveaway } from '../services/performanceService.js';

test('calcula el tramo desde la tarifa persistida', async () => {
  const bandId = new ObjectId();
  const database = { collection: () => ({ findOne: async () => ({ _id: bandId, tramo: 6, tarifa: { toString: () => '3729.000' }, tono: 'alert' }) }) };
  const result = await calculateShiftPerformance(database, 10042, 10000);
  assert.equal(result.tramo, 6);
  assert.equal(result.giveawayNumber, 0.42);
  assert.equal(result.tono, 'alert');
  assert.equal(result.tramoId.toString(), bandId.toString());
});

test('rechaza un peso objetivo cero', async () => {
  const database = { collection: () => ({ findOne: async () => null }) };
  await assert.rejects(() => calculateShiftPerformance(database, 100, 0), { code: 'INVALID_TARGET_WEIGHT' });
});

test('calcula la renta desde el porcentaje Giveaway ingresado al cierre', async () => {
  const bandId = new ObjectId();
  const database = { collection: () => ({ findOne: async () => ({ _id: bandId, tramo: 6, tarifa: { toString: () => '3729.000' }, tono: 'alert' }) }) };
  const result = await calculateShiftPerformanceFromGiveaway(database, 10042, 0.42);
  assert.equal(result.giveawayNumber, 0.42);
  assert.equal(Number(result.kilogramosObjetivo.toString()), 10000);
  assert.equal(result.tramo, 6);
});

test('el tramo visual corresponde al porcentaje manual ingresado', async () => {
  const bandId = new ObjectId();
  const database = { collection: () => ({ findOne: async () => ({ _id: bandId, tramo: 8, tarifa: { toString: () => '5172.000' }, tono: 'acceptable' }) }) };
  const result = await calculateShiftPerformanceFromGiveaway(database, 10028, 0.2);
  assert.equal(result.tramo, 8);
  assert.equal(result.giveawayNumber, 0.2);
});
