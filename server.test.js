import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { app } from './server.js';
import { closeMongo, getDatabase, initializeDatabase } from './Model/mongo.js';
import { seedLocalDatabase } from './Model/localSeed.js';

let testDatabasePath = resolve(tmpdir(), 'sgsp-tests', 'sgsp.test.local.json');
process.env.SGSP_LOCAL_DB_PATH = testDatabasePath;

async function resetTestDatabase(fileName = 'sgsp.test.local.json') {
  await closeMongo();
  testDatabasePath = resolve(tmpdir(), 'sgsp-tests', fileName);
  process.env.SGSP_LOCAL_DB_PATH = testDatabasePath;
  await rm(testDatabasePath, { force: true });
}

test('expone health y reporta readiness antes de inicializar la base local', { concurrency: false }, async () => {
  await resetTestDatabase('sgsp.test.ready.local.json');
  const server = app.listen(0);
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).data.status, 'ok');

    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).error, 'DATABASE_UNAVAILABLE');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('inicializa la base local y permite autenticar el flujo demo', { concurrency: false }, async () => {
  await resetTestDatabase('sgsp.test.auth.local.json');
  await initializeDatabase();
  await seedLocalDatabase();

  const server = app.listen(0);
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).data.database, 'SGSP Local');

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin12345' })
    });
    assert.equal(login.status, 200);
    const loginPayload = await login.json();
    assert.equal(loginPayload.data.user.username, 'admin');
    assert.equal(loginPayload.data.user.role, 'Administrador');
    assert.ok(loginPayload.data.token);

    const summary = await fetch(`${baseUrl}/api/admin/summary`, {
      headers: { authorization: `Bearer ${loginPayload.data.token}` }
    });
    assert.equal(summary.status, 200);
    const summaryPayload = await summary.json();
    const lineState = new Map(summaryPayload.data.lines.map((line) => [line.name, line.status]));
    assert.equal(lineState.get('Andes Asia'), 'Atención');
    assert.equal(lineState.get('Nippon'), 'Pendiente');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('al cerrar un turno activo crea el siguiente turno planificado para el jefe y permite reiniciar el ciclo', { concurrency: false }, async () => {
  await resetTestDatabase('sgsp.test.restart.local.json');
  await initializeDatabase();
  await seedLocalDatabase();

  const server = app.listen(0);
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'jefe', password: 'Jefe123456' })
    });
    assert.equal(login.status, 200);
    const loginPayload = await login.json();
    const headers = { authorization: `Bearer ${loginPayload.data.token}` };

    const beforeCloseDashboard = await fetch(`${baseUrl}/api/operation/dashboard`, { headers });
    assert.equal(beforeCloseDashboard.status, 200);
    const beforeClosePayload = await beforeCloseDashboard.json();
    assert.equal(beforeClosePayload.data.shift.estado, 'activo');

    const close = await fetch(`${baseUrl}/api/shifts/${beforeClosePayload.data.shift._id}/close`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ kilosProcesados: 10042, porcentajeGiveaway: 0.42, lineaId: beforeClosePayload.data.shift.lineaId })
    });
    assert.equal(close.status, 200);
    const closePayload = await close.json();
    assert.equal(closePayload.data.shift.estado, 'cerrado');
    assert.equal(closePayload.data.nextShift.estado, 'planificado');

    const afterCloseDashboard = await fetch(`${baseUrl}/api/operation/dashboard`, { headers });
    assert.equal(afterCloseDashboard.status, 200);
    const afterClosePayload = await afterCloseDashboard.json();
    assert.equal(afterClosePayload.data.shift.estado, 'planificado');
    assert.equal(afterClosePayload.data.operators.length, 4);

    const restart = await fetch(`${baseUrl}/api/shifts/${afterClosePayload.data.shift._id}/start`, {
      method: 'POST',
      headers
    });
    assert.equal(restart.status, 200);
    const restartPayload = await restart.json();
    assert.equal(restartPayload.data.estado, 'activo');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('permite iniciar un proceso T2 y cerrar el turno con 2500 kg y 0.03 de giveaway', { concurrency: false }, async () => {
  await resetTestDatabase('sgsp.test.t2-close.local.json');
  await initializeDatabase();
  await seedLocalDatabase();

  const server = app.listen(0);
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin12345' })
    });
    assert.equal(adminLogin.status, 200);
    const adminPayload = await adminLogin.json();
    const adminHeaders = { authorization: `Bearer ${adminPayload.data.token}` };

    const [catalogsResponse, managersResponse] = await Promise.all([
      fetch(`${baseUrl}/api/operation/catalogs`, { headers: adminHeaders }),
      fetch(`${baseUrl}/api/admin/line-managers`, { headers: adminHeaders })
    ]);
    assert.equal(catalogsResponse.status, 200);
    assert.equal(managersResponse.status, 200);

    const catalogsPayload = await catalogsResponse.json();
    const managersPayload = await managersResponse.json();
    const jefe = managersPayload.data.find((manager) => manager.username === 'jefe');
    const line = catalogsPayload.data.lines.find((item) => item.nombre === 'Andes Asia');
    const order = catalogsPayload.data.orders[0];
    const collaborators = catalogsPayload.data.collaborators.slice(0, 4).map((collaborator) => collaborator._id);

    assert.ok(jefe?._id);
    assert.ok(line?._id);
    assert.ok(order?._id);
    assert.equal(collaborators.length, 4);

    const createShift = await fetch(`${baseUrl}/api/shifts`, {
      method: 'POST',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        lineaId: line._id,
        fecha: '2026-09-21T18:00:00.000Z',
        turno: 'T2',
        jefeLineaId: jefe._id,
        pedidos: [{ pedidoId: order._id, prioridad: 1 }],
        colaboradores: collaborators
      })
    });
    assert.equal(createShift.status, 201);
    const createShiftPayload = await createShift.json();
    assert.equal(createShiftPayload.data.turno, 'T2');
    assert.equal(createShiftPayload.data.estado, 'planificado');

    const jefeLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'jefe', password: 'Jefe123456' })
    });
    assert.equal(jefeLogin.status, 200);
    const jefePayload = await jefeLogin.json();
    const jefeHeaders = { authorization: `Bearer ${jefePayload.data.token}` };

    const startShift = await fetch(`${baseUrl}/api/shifts/${createShiftPayload.data._id}/start`, {
      method: 'POST',
      headers: jefeHeaders
    });
    assert.equal(startShift.status, 200);
    const startShiftPayload = await startShift.json();
    assert.equal(startShiftPayload.data.turno, 'T2');
    assert.equal(startShiftPayload.data.estado, 'activo');

    const closeShift = await fetch(`${baseUrl}/api/shifts/${createShiftPayload.data._id}/close`, {
      method: 'POST',
      headers: { ...jefeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ kilosProcesados: 2500, porcentajeGiveaway: 0.03, lineaId: line._id })
    });
    assert.equal(closeShift.status, 200);
    const closeShiftPayload = await closeShift.json();
    assert.equal(closeShiftPayload.data.shift.turno, 'T2');
    assert.equal(closeShiftPayload.data.shift.estado, 'cerrado');
    assert.equal(closeShiftPayload.data.nextShift.turno, 'T2');
    assert.equal(closeShiftPayload.data.nextShift.estado, 'planificado');
    assert.equal(closeShiftPayload.data.rentaVariable.giveawayNumber, 0.03);

    const database = await getDatabase();
    const savedRent = await database.collection('rentaVariable').findOne({}, { sort: { calculadoAt: -1 } });
    assert.ok(savedRent);
    assert.equal(Number(savedRent.kilogramosProcesados.toString()), 2500);
    assert.equal(Number(savedRent.kilogramosObjetivo.toString()), 2499.25);
    assert.equal(Number(savedRent.porcentajeGiveaway.toString()), 0.03);

    const dashboard = await fetch(`${baseUrl}/api/operation/dashboard`, { headers: jefeHeaders });
    assert.equal(dashboard.status, 200);
    const dashboardPayload = await dashboard.json();
    assert.equal(dashboardPayload.data.giveawayHistory.rows.length, 1);
    assert.equal(dashboardPayload.data.giveawayHistory.rows[0].turno, 'T2');
    assert.equal(dashboardPayload.data.giveawayHistory.rows[0].giveaway, 0.03);
    assert.equal(dashboardPayload.data.giveawayHistory.rows[0].amount, 7337);
    assert.equal(dashboardPayload.data.giveawayHistory.total, 7337);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('guarda los dias trabajados y acumula el valor total de giveaway registrado', { concurrency: false }, async () => {
  await resetTestDatabase('sgsp.test.giveaway-total.local.json');
  await initializeDatabase();
  await seedLocalDatabase();

  const server = app.listen(0);
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'jefe', password: 'Jefe123456' })
    });
    assert.equal(login.status, 200);
    const loginPayload = await login.json();
    const headers = { authorization: `Bearer ${loginPayload.data.token}` };

    const expectedGiveaways = [0.42, 0.03];
    let currentShiftId = null;
    let currentLineId = null;

    for (let index = 0; index < expectedGiveaways.length; index += 1) {
      const dashboard = await fetch(`${baseUrl}/api/operation/dashboard`, { headers });
      assert.equal(dashboard.status, 200);
      const dashboardPayload = await dashboard.json();
      const currentShift = dashboardPayload.data.shift;
      assert.ok(currentShift?._id);

      currentShiftId = currentShift._id;
      currentLineId = currentShift.lineaId;

      if (currentShift.estado === 'planificado') {
        const start = await fetch(`${baseUrl}/api/shifts/${currentShiftId}/start`, {
          method: 'POST',
          headers
        });
        assert.equal(start.status, 200);
      }

      const close = await fetch(`${baseUrl}/api/shifts/${currentShiftId}/close`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          kilosProcesados: index === 0 ? 10042 : 2500,
          porcentajeGiveaway: expectedGiveaways[index],
          lineaId: currentLineId
        })
      });
      assert.equal(close.status, 200);
      const closePayload = await close.json();
      assert.equal(closePayload.data.shift.estado, 'cerrado');
      assert.equal(closePayload.data.nextShift.estado, 'planificado');
    }

    const finalDashboard = await fetch(`${baseUrl}/api/operation/dashboard`, { headers });
    assert.equal(finalDashboard.status, 200);
    const finalDashboardPayload = await finalDashboard.json();
    assert.equal(finalDashboardPayload.data.giveawayHistory.rows.length, 2);
    assert.deepEqual(finalDashboardPayload.data.giveawayHistory.rows.map((row) => row.giveaway), [0.03, 0.42]);
    assert.deepEqual(finalDashboardPayload.data.giveawayHistory.rows.map((row) => row.amount), [7337, 3729]);
    assert.equal(finalDashboardPayload.data.giveawayHistory.total, 11066);

    const database = await getDatabase();
    const savedRents = await database.collection('rentaVariable').find({}).sort({ calculadoAt: -1 }).toArray();
    assert.equal(savedRents.length, 2);
    const storedTotal = savedRents.reduce((sum, item) => sum + Number(item.total.toString()), 0);
    assert.equal(Number(storedTotal.toFixed(0)), 11066);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('el jefe puede cerrar el incentivo mensual y reiniciar el acumulado del periodo', { concurrency: false }, async () => {
  await resetTestDatabase('sgsp.test.monthly-incentive-close.local.json');
  await initializeDatabase();
  await seedLocalDatabase();

  const server = app.listen(0);
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'jefe', password: 'Jefe123456' })
    });
    assert.equal(login.status, 200);
    const loginPayload = await login.json();
    const headers = { authorization: `Bearer ${loginPayload.data.token}` };

    const initialDashboard = await fetch(`${baseUrl}/api/operation/dashboard`, { headers });
    assert.equal(initialDashboard.status, 200);
    const initialDashboardPayload = await initialDashboard.json();
    const closeDay = await fetch(`${baseUrl}/api/shifts/${initialDashboardPayload.data.shift._id}/close`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ kilosProcesados: 10042, porcentajeGiveaway: 0.42, lineaId: initialDashboardPayload.data.shift.lineaId })
    });
    assert.equal(closeDay.status, 200);

    const beforeClose = await fetch(`${baseUrl}/api/operation/dashboard`, { headers });
    assert.equal(beforeClose.status, 200);
    const beforeClosePayload = await beforeClose.json();
    assert.equal(beforeClosePayload.data.giveawayHistory.rows.length, 1);
    assert.equal(beforeClosePayload.data.giveawayHistory.total, 3729);

    const monthlyClose = await fetch(`${baseUrl}/api/incentives/monthly-close`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ lineaId: beforeClosePayload.data.shift.lineaId })
    });
    assert.equal(monthlyClose.status, 200);
    const monthlyClosePayload = await monthlyClose.json();
    assert.equal(monthlyClosePayload.data.totalCerrado, 3729);
    assert.equal(monthlyClosePayload.data.registros, 1);

    const afterClose = await fetch(`${baseUrl}/api/operation/dashboard`, { headers });
    assert.equal(afterClose.status, 200);
    const afterClosePayload = await afterClose.json();
    assert.equal(afterClosePayload.data.giveawayHistory.rows.length, 0);
    assert.equal(afterClosePayload.data.giveawayHistory.total, 0);
    assert.ok(afterClosePayload.data.giveawayHistory.closedAt);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
