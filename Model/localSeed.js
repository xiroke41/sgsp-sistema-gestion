import bcrypt from 'bcryptjs';
import { Decimal128 } from 'mongodb';
import { getDatabase } from './mongo.js';
import { INCENTIVE_BANDS } from './giveaway.js';

const POSITION_CODES = [
  ['unassigned', 'Disponibles / En espera'],
  ['mesa', 'Mesa Prolijado'],
  ['maquinas', 'Máquinas'],
  ['embalaje', 'Embalaje / Embutidora'],
  ['rayos', 'Rayos X (Cert.)'],
  ['romana', 'Romana (Especial)'],
  ['bano', 'Baño'],
  ['colacion', 'Colación']
];

const ROLE_PERMISSIONS = {
  Administrador: { all: true },
  'Jefe de linea': { view_dashboard: true, manage_shift: true, assign_shift: true, manage_people: true, register_break: true, register_downtime: true, close_shift: true },
  Supervisor: { view_dashboard: true, manage_people: true, register_break: true, register_downtime: true },
  Operador: { view_dashboard: true }
};

const DEFAULT_ACCOUNTS = [
  { username: 'admin', password: 'Admin12345', roleName: 'Administrador' },
  { username: 'jefe', password: 'Jefe123456', roleName: 'Jefe de linea' }
];

const DEFAULT_COLLABORATORS = [
  { rut: '11.111.111-1', nombreCompleto: 'Camila Rojas', fechaIngreso: '2024-01-08', cargo: 'Operadora Envasado', certificaciones: [] },
  { rut: '12.222.222-2', nombreCompleto: 'Diego Muñoz', fechaIngreso: '2024-02-12', cargo: 'Operador Pesaje', certificaciones: [] },
  { rut: '13.333.333-3', nombreCompleto: 'Marcelo Soto', fechaIngreso: '2024-03-18', cargo: 'Operador Línea', certificaciones: [] },
  { rut: '14.444.444-4', nombreCompleto: 'Valentina Pérez', fechaIngreso: '2024-04-22', cargo: 'Operadora Rayos X', certificaciones: ['rayos'] }
];

async function upsertRole(database, nombre) {
  const now = new Date();
  await database.collection('roles').updateOne(
    { nombre },
    { $set: { permisos: ROLE_PERMISSIONS[nombre], activo: true }, $setOnInsert: { nombre, createdAt: now } },
    { upsert: true }
  );
  return database.collection('roles').findOne({ nombre });
}

async function upsertUser(database, { username, password, roleId }) {
  const existing = await database.collection('usuarios').findOne({ username });
  if (existing) return existing;
  const passwordHash = await bcrypt.hash(password, 12);
  const document = { username, passwordHash, roleId, activo: true, createdAt: new Date(), updatedAt: new Date() };
  const result = await database.collection('usuarios').insertOne(document);
  return { ...document, _id: result.insertedId };
}

async function upsertLine(database, nombre) {
  await database.collection('lineasProduccion').updateOne({ nombre }, { $setOnInsert: { nombre, activo: true } }, { upsert: true });
  return database.collection('lineasProduccion').findOne({ nombre });
}

async function upsertPositions(database) {
  await Promise.all(POSITION_CODES.map(([codigo, descripcion]) => database.collection('puestos').updateOne(
    { codigo },
    { $setOnInsert: { codigo, descripcion, activo: true } },
    { upsert: true }
  )));
}

async function upsertCollaborator(database, collaborator) {
  const existing = await database.collection('colaboradores').findOne({ rut: collaborator.rut });
  if (existing) return existing;
  const document = {
    ...collaborator,
    fechaIngreso: new Date(collaborator.fechaIngreso),
    activo: true,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const result = await database.collection('colaboradores').insertOne(document);
  return { ...document, _id: result.insertedId };
}

async function upsertTariffBands(database) {
  const seedMarker = await database.collection('_meta').findOne({ key: 'tariffBandsSeeded' });
  const existingBands = await database.collection('tramosGiveawayTarifa').countDocuments({});
  if (seedMarker && existingBands > 0) return;
  await Promise.all(INCENTIVE_BANDS.map((band) => database.collection('tramosGiveawayTarifa').updateOne(
    { tramo: band.tier },
    {
      $setOnInsert: {
        tramo: band.tier,
        giveawayMin: Decimal128.fromString(band.min.toFixed(4)),
        giveawayMax: band.max === Number.POSITIVE_INFINITY ? null : Decimal128.fromString(band.max.toFixed(4)),
        tarifa: Decimal128.fromString(band.factor.toFixed(3)),
        tono: band.tone
      }
    },
    { upsert: true }
  )));
  await database.collection('_meta').insertOne({ key: 'tariffBandsSeeded', createdAt: new Date() });
}

async function ensureDefaultCatalog(database) {
  const producto = await database.collection('productos').findOneAndUpdate(
    { codigoMercado: 'FIL-500' },
    { $setOnInsert: { codigoMercado: 'FIL-500', nombre: 'Filete congelado 500 g', empaqueTipo: 'Caja', pesoObjetivoKg: Decimal128.fromString('10000.000'), activo: true } },
    { upsert: true, returnDocument: 'after' }
  );
  const pedido = await database.collection('pedidosProduccion').findOne({ estado: 'en_proceso' });
  return { producto, pedido };
}

async function ensureActiveShift(database, line, jefe, pedido) {
  const existing = await database.collection('turnosProduccion').findOne({ lineaId: line._id, estado: 'activo' });
  if (existing) return existing;
  const now = new Date();
  const pedidos = pedido ? [{ pedidoId: pedido._id, prioridad: 1 }] : [];
  const document = {
    lineaId: line._id,
    fecha: now,
    turno: 'T1',
    estado: 'activo',
    creadoPor: jefe._id,
    jefeLineaId: jefe._id,
    horaInicio: now,
    pedidos,
    createdAt: now
  };
  const result = await database.collection('turnosProduccion').insertOne(document);
  return { ...document, _id: result.insertedId };
}

async function ensurePendingShift(database, line, jefe, pedido) {
  const existing = await database.collection('turnosProduccion').findOne({ lineaId: line._id, estado: 'planificado' });
  if (existing) return existing;
  const now = new Date();
  const pedidos = pedido ? [{ pedidoId: pedido._id, prioridad: 1 }] : [];
  const document = {
    lineaId: line._id,
    fecha: now,
    turno: 'T2',
    estado: 'planificado',
    creadoPor: jefe._id,
    jefeLineaId: jefe._id,
    pedidos,
    createdAt: now
  };
  const result = await database.collection('turnosProduccion').insertOne(document);
  return { ...document, _id: result.insertedId };
}

async function ensureAttendance(database, turnoId, collaborators) {
  const existing = await database.collection('asistenciaTurno').countDocuments({ turnoId, presente: true });
  if (existing > 0) return;
  const now = new Date();
  await database.collection('asistenciaTurno').insertMany([
    { turnoId, colaboradorId: collaborators[0]._id, fecha: now, presente: true, horaIngreso: now, horaSalida: null, estado: 'assigned', lineaTrabajo: 'mesa', grupoRotacion: 1, grupoPuesto: 'A', productividad: '98%', updatedAt: now },
    { turnoId, colaboradorId: collaborators[1]._id, fecha: now, presente: true, horaIngreso: now, horaSalida: null, estado: 'assigned', lineaTrabajo: 'maquinas', grupoRotacion: 2, grupoPuesto: 'B', productividad: '96%', updatedAt: now },
    { turnoId, colaboradorId: collaborators[2]._id, fecha: now, presente: true, horaIngreso: now, horaSalida: null, estado: 'available', lineaTrabajo: 'unassigned', grupoRotacion: 1, grupoPuesto: 'C', productividad: '—', updatedAt: now },
    { turnoId, colaboradorId: collaborators[3]._id, fecha: now, presente: true, horaIngreso: now, horaSalida: null, estado: 'break', lineaTrabajo: 'colacion', grupoRotacion: 2, grupoPuesto: 'A', productividad: '94%', updatedAt: now }
  ]);
}

async function ensureInitialDowntime(database, turnoId) {
  const existing = await database.collection('detencionesLinea').findOne({ turnoId });
  if (existing) return existing;
  const start = new Date();
  start.setHours(8, 42, 0, 0);
  const end = new Date(start.getTime() + 6 * 60 * 1000);
  const document = {
    turnoId,
    categoria: 'mecanica',
    motivo: 'Ajuste de selladora',
    inicio: start,
    fin: end,
    duracionMinutos: 6,
    registradoPor: null
  };
  const result = await database.collection('detencionesLinea').insertOne(document);
  return { ...document, _id: result.insertedId };
}

// Runs on every API start; every step is idempotent so re-running never duplicates or resets data.
export async function seedLocalDatabase() {
  const database = await getDatabase();
  const [adminRole, jefeRole, supervisorRole, operatorRole] = await Promise.all([
    upsertRole(database, 'Administrador'),
    upsertRole(database, 'Jefe de linea'),
    upsertRole(database, 'Supervisor'),
    upsertRole(database, 'Operador')
  ]);
  const roleByName = { Administrador: adminRole, 'Jefe de linea': jefeRole, Supervisor: supervisorRole, Operador: operatorRole };
  const [admin, jefe] = await Promise.all(
    DEFAULT_ACCOUNTS.map((account) => upsertUser(database, { ...account, roleId: roleByName[account.roleName]._id }))
  );
  const [andesAsia, nippon] = await Promise.all([
    upsertLine(database, 'Andes Asia'),
    upsertLine(database, 'Nippon')
  ]);
  await Promise.all([upsertPositions(database), upsertTariffBands(database)]);
  const collaborators = await Promise.all(DEFAULT_COLLABORATORS.map((collaborator) => upsertCollaborator(database, collaborator)));
  const { pedido } = await ensureDefaultCatalog(database);
  const activeShift = await ensureActiveShift(database, andesAsia, jefe, pedido);
  await ensurePendingShift(database, nippon, jefe, pedido);
  await ensureAttendance(database, activeShift._id, collaborators);
  await ensureInitialDowntime(database, activeShift._id);
  return { admin, jefe, lines: { andesAsia, nippon } };
}
