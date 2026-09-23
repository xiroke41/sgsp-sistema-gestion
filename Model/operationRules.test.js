import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPositionGroup, nextWorkLine, returnLineAfterBreak, statusForWorkLine } from './operationRules.js';

test('rota los grupos de puestos A, B y C en ciclo', () => {
  assert.equal(nextPositionGroup('A'), 'B');
  assert.equal(nextPositionGroup('B'), 'C');
  assert.equal(nextPositionGroup('C'), 'A');
  assert.equal(nextPositionGroup('G1'), null);
});

test('rota solo las líneas productivas configuradas', () => {
  assert.equal(nextWorkLine('mesa'), 'maquinas');
  assert.equal(nextWorkLine('maquinas'), 'embalaje');
  assert.equal(nextWorkLine('embalaje'), 'mesa');
  assert.equal(nextWorkLine('bano'), null);
});

test('retorna a la línea anterior después de una pausa', () => {
  assert.equal(returnLineAfterBreak('mesa'), 'mesa');
  assert.equal(returnLineAfterBreak('maquinas'), 'maquinas');
  assert.equal(returnLineAfterBreak('bano'), 'unassigned');
  assert.equal(returnLineAfterBreak('colacion'), 'unassigned');
  assert.equal(returnLineAfterBreak(undefined), 'unassigned');
});

test('determina el estado operacional según la zona', () => {
  assert.equal(statusForWorkLine('mesa'), 'assigned');
  assert.equal(statusForWorkLine('bano'), 'break');
  assert.equal(statusForWorkLine('colacion'), 'break');
  assert.equal(statusForWorkLine('unassigned'), 'available');
});
