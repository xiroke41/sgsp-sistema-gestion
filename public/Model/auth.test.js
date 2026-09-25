import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, can } from './auth.js';

test('autentica un usuario valido sin exponer su contraseña', () => {
  const user = authenticate('supervisor', 'super123');
  assert.equal(user.role, 'supervisor');
  assert.equal(user.password, undefined);
});

test('rechaza credenciales invalidas', () => {
  assert.equal(authenticate('supervisor', 'incorrecta'), null);
});

test('aplica permisos de supervisor', () => {
  const user = authenticate('supervisor', 'super123');
  assert.equal(can(user, 'register_break'), true);
  assert.equal(can(user, 'manage_shift'), true);
  assert.equal(can(user, 'assign_shift'), true);
  assert.equal(can(user, 'close_shift'), true);
});

test('administrador, jefe y supervisor pueden asignar turnos', () => {
  const admin = authenticate('admin', 'Admin12345');
  const manager = authenticate('jefe', 'Jefe123456');
  assert.equal(can(admin, 'assign_shift'), true);
  assert.equal(can(manager, 'assign_shift'), true);
});
