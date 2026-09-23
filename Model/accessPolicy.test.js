import test from 'node:test';
import assert from 'node:assert/strict';
import { canHavePlatformAccess, validateAccountRequest } from './accessPolicy.js';

test('solo un jefe de línea puede tener acceso a la plataforma', () => {
  assert.equal(canHavePlatformAccess('Jefe de linea'), true);
  assert.equal(canHavePlatformAccess('Operador'), false);
  assert.equal(validateAccountRequest('Operador', 'operador', 'Operador123').code, 'OPERATOR_ACCESS_FORBIDDEN');
  assert.equal(validateAccountRequest('Jefe de linea', 'jefe', 'corta').code, 'VALIDATION_ERROR');
  assert.equal(validateAccountRequest('Jefe de linea', 'jefe', 'JefeSeguro123'), null);
});