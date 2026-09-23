import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBody } from './http.js';

function runValidation(body, fields) {
  const result = { statusCode: null, payload: null, nextCalled: false };
  const request = { body };
  const response = { status(code) { result.statusCode = code; return response; }, json(payload) { result.payload = payload; return payload; } };
  validateBody(fields)(request, response, () => { result.nextCalled = true; });
  return result;
}

test('rechaza campos obligatorios compuestos solo por espacios', () => {
  const result = runValidation({ username: '   ' }, ['username', 'password']);
  assert.equal(result.statusCode, 400);
  assert.deepEqual(result.payload, { success: false, error: 'VALIDATION_ERROR', message: 'Faltan campos: username, password.' });
  assert.equal(result.nextCalled, false);
});

test('permite valores numéricos cero y cadenas no vacías', () => {
  const result = runValidation({ count: 0, name: ' Operador ' }, ['count', 'name']);
  assert.equal(result.statusCode, null);
  assert.equal(result.nextCalled, true);
});
