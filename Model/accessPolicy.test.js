import test from 'node:test';
import assert from 'node:assert/strict';
import { canHavePlatformAccess, validateAccountRequest } from './accessPolicy.js';

test('solo jefes de línea y supervisores pueden tener acceso a la plataforma', () => {
  assert.equal(canHavePlatformAccess('Jefe de linea'), true);
  assert.equal(canHavePlatformAccess('Supervisor'), true);
  assert.equal(canHavePlatformAccess('Operador'), false);
  assert.equal(validateAccountRequest('Operador', 'operador', 'Operador123').code, 'OPERATOR_ACCESS_FORBIDDEN');
  assert.equal(validateAccountRequest('Jefe de linea', 'jefe', 'corta').code, 'VALIDATION_ERROR');
  assert.equal(validateAccountRequest('Jefe de linea', 'jefe', 'JefeSeguro123!'), null);
  assert.equal(validateAccountRequest('Supervisor', 'supervisor', 'Supervisor123!'), null);
});