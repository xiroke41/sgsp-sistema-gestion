import { ObjectId } from 'mongodb';
import { getDatabase } from '../Model/mongo.js';
import { calculateShiftPerformanceFromGiveaway } from '../services/performanceService.js';

function id(value) {
  if (!ObjectId.isValid(value)) { const error = new Error('Identificador inválido.'); error.statusCode = 400; error.code = 'INVALID_ID'; throw error; }
  return new ObjectId(value);
}

async function findCurrentShift(database, baseFilter = {}) {
  const activeShift = await database.collection('turnosProduccion').findOne({ ...baseFilter, estado: 'activo' }, { sort: { createdAt: -1 } });
  if (activeShift) return activeShift;
  return database.collection('turnosProduccion').findOne({ ...baseFilter, estado: 'planificado' }, { sort: { createdAt: -1 } });
}

function isLineManager(requestUser) {
  const role = String(requestUser?.roleName || '').trim().toLowerCase();
  return role === 'jefe de linea' || role === 'jefe de línea';
}

async function findSharedCurrentShift(database, requestUser) {
  if (!isLineManager(requestUser)) return findCurrentShift(database);
  const assignment = await database.collection('turnosProduccion').findOne({ jefeLineaId: requestUser._id }, { sort: { createdAt: -1 } });
  return assignment ? findCurrentShift(database, { lineaId: assignment.lineaId }) : null;
}

async function createFollowUpShift(database, shift, referenceDate) {
  const createdAt = new Date(referenceDate);
  const nextShift = {
    lineaId: shift.lineaId,
    fecha: createdAt,
    turno: shift.turno,
    estado: 'planificado',
    creadoPor: shift.cerradoPor || shift.creadoPor,
    jefeLineaId: shift.jefeLineaId,
    pedidos: Array.isArray(shift.pedidos) ? shift.pedidos : [],
    createdAt
  };
  const result = await database.collection('turnosProduccion').insertOne(nextShift);
  const nextShiftId = result.insertedId;

  const attendance = await database.collection('asistenciaTurno').find({ turnoId: shift._id, presente: true }).toArray();
  if (attendance.length) {
    await database.collection('asistenciaTurno').insertMany(attendance.map((record) => ({
      turnoId: nextShiftId,
      colaboradorId: record.colaboradorId,
      fecha: createdAt,
      presente: true,
      horaIngreso: null,
      horaSalida: null,
      estado: 'available',
      lineaTrabajo: 'unassigned',
      puestoId: null,
      grupoRotacion: record.grupoRotacion,
      grupoPuesto: record.grupoPuesto,
      productividad: '—',
      updatedAt: createdAt
    })));
  }

  return { ...nextShift, _id: nextShiftId };
}

async function syncAttendanceForShift(database, shift) {
  const existing = await database.collection('asistenciaTurno').find({ turnoId: shift._id }).toArray();
  const existingIds = new Set(existing.map((record) => record.colaboradorId.toString()));
  const activePersonnel = await database.collection('colaboradores').find({ activo: true }).toArray();
  let eligible = activePersonnel.filter((person) => (person.turno === 'T2' ? 'T2' : 'T1') === shift.turno);
  if (!eligible.length && !existing.length && activePersonnel.length) {
    eligible = activePersonnel;
    await database.collection('colaboradores').updateMany(
      { _id: { $in: activePersonnel.map((person) => person._id) } },
      { $set: { turno: shift.turno, updatedAt: new Date() } }
    );
  }
  const toInsert = eligible.filter((person) => !existingIds.has(person._id.toString()));
  if (toInsert.length) {
    await database.collection('asistenciaTurno').insertMany(toInsert.map((person, index) => ({
      turnoId: shift._id,
      colaboradorId: person._id,
      fecha: shift.fecha,
      presente: true,
      horaIngreso: null,
      horaSalida: null,
      estado: 'available',
      lineaTrabajo: 'unassigned',
      puestoId: null,
      grupoRotacion: (index % 2) + 1,
      grupoPuesto: ['A', 'B', 'C'][index % 3],
      productividad: '—',
      updatedAt: new Date()
    })));
  }
  // Remove leftover attendance from colaboradores that no longer belong to this shift's turno (e.g. reassigned personnel).
  const eligibleIds = new Set(eligible.map((person) => person._id.toString()));
  const staleRecords = existing.filter((record) => !eligibleIds.has(record.colaboradorId.toString()));
  for (const record of staleRecords) await database.collection('asistenciaTurno').deleteOne({ _id: record._id });
}

async function findLatestMonthlyClosure(database, lineaId, turno = null) {
  return database.collection('cierresIncentivoMensual').findOne({ lineaId, ...(turno ? { turno } : {}) }, { sort: { cerradoAt: -1 } });
}

async function ensureManagedLine(database, requestUser, lineaId) {
  if (!isLineManager(requestUser)) return;
  const managedShift = await database.collection('turnosProduccion').findOne({ lineaId, jefeLineaId: requestUser._id }, { sort: { createdAt: -1 } });
  if (!managedShift) {
    const error = new Error('El jefe de línea no tiene acceso a esta línea para cerrar el incentivo mensual.');
    error.statusCode = 403;
    error.code = 'FORBIDDEN_LINE';
    throw error;
  }
}

async function loadGiveawayHistory(database, shift, requestUser) {
  if (!shift?.lineaId) return { rows: [], total: 0 };

  const shifts = await database.collection('turnosProduccion').find({ lineaId: shift.lineaId }).sort({ fecha: -1, createdAt: -1 }).limit(50).toArray();
  const shiftIds = shifts.map((item) => item._id);
  if (!shiftIds.length) return { rows: [], total: 0 };

  const monthlyClosures = await database.collection('cierresIncentivoMensual').find({ lineaId: shift.lineaId }).sort({ cerradoAt: -1 }).toArray();
  const latestMonthlyClosureByShift = new Map();
  for (const closure of monthlyClosures) {
    if (!latestMonthlyClosureByShift.has(closure.turno)) latestMonthlyClosureByShift.set(closure.turno, closure);
  }
  const shiftById = new Map(shifts.map((item) => [item._id.toString(), item]));
  const rentRows = (await database.collection('rentaVariable').find({}).sort({ calculadoAt: -1 }).toArray())
    .filter((row) => shiftById.has(row.turnoId?.toString()))
    .slice(0, 20);
  const missingTramoIds = rentRows.filter((row) => row.tramo === undefined && row.tramoId).map((row) => row.tramoId);
  const tramoById = missingTramoIds.length
    ? new Map((await database.collection('tramosGiveawayTarifa').find({ _id: { $in: missingTramoIds } }).toArray()).map((band) => [band._id.toString(), band.tramo]))
    : new Map();
  const rows = rentRows.map((row) => {
    const relatedShift = shiftById.get(row.turnoId?.toString());
    if (!relatedShift) return null;
    const latestMonthlyClosure = latestMonthlyClosureByShift.get(relatedShift.turno);
    if (latestMonthlyClosure?.cerradoAt && new Date(row.calculadoAt) <= new Date(latestMonthlyClosure.cerradoAt)) return null;
    const tramo = row.tramo !== undefined ? Number(row.tramo?.toString?.() || 0) : Number(tramoById.get(row.tramoId?.toString()) || 0);
    return {
      _id: row._id,
      fecha: row.calculadoAt || relatedShift.horaFin || relatedShift.fecha,
      turno: relatedShift.turno,
      tramo,
      giveaway: Number(row.giveaway?.toString?.() || row.porcentajeGiveaway?.toString?.() || 0),
      amount: Number(row.total?.toString?.() || row.tarifa?.toString?.() || 0)
    };
  }).filter(Boolean);

  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return { rows, total: Number(total.toFixed(0)), closedAt: latestMonthlyClosureByShift.get(shift.turno)?.cerradoAt || null };
}

export async function dashboard(request, response) {
  const database = await getDatabase();
  const shift = await findSharedCurrentShift(database, request.user);
  const ownsShift = Boolean(shift && (!isLineManager(request.user) || shift.jefeLineaId?.toString() === request.user._id.toString()));
  const line = shift ? await database.collection('lineasProduccion').findOne({ _id: shift.lineaId }) : null;
  if (shift?.estado === 'activo' && ownsShift) await syncAttendanceForShift(database, shift);
  const operators = shift?.estado === 'activo' && ownsShift ? await database.collection('asistenciaTurno').aggregate([{ $match: { turnoId: shift._id, presente: true } }, { $lookup: { from: 'colaboradores', localField: 'colaboradorId', foreignField: '_id', as: 'colaborador' } }, { $unwind: { path: '$colaborador', preserveNullAndEmptyArrays: true } }, { $project: { _id: 1, colaboradorId: 1, estado: 1, puestoId: 1, lineaTrabajo: 1, grupoRotacion: 1, grupoPuesto: 1, nombre: '$colaborador.nombreCompleto', cargo: '$colaborador.cargo', productividad: 1 } }]).toArray() : [];
  const downtime = shift && ownsShift ? await database.collection('detencionesLinea').find({ turnoId: shift._id }).sort({ inicio: -1 }).limit(20).toArray() : [];
  const giveawayHistory = shift ? await loadGiveawayHistory(database, shift, request.user) : { rows: [], total: 0 };
  return response.json({ success: true, data: { shift: shift ? { ...shift, linea: line?.nombre, canOperate: ownsShift } : null, operators, downtime, giveawayHistory }, message: 'Dashboard operativo obtenido.' });
}

export async function listShifts(request, response) {
  const database = await getDatabase();
  const shifts = await database.collection('turnosProduccion').find({}).sort({ fecha: -1, createdAt: -1 }).limit(100).toArray();
  return response.json({ success: true, data: shifts, message: 'Turnos obtenidos.' });
}

export async function catalogs(request, response) {
  const database = await getDatabase();
  const [lines, products, adminOrders, legacyOrders, collaborators, tariffBands] = await Promise.all([
    database.collection('lineasProduccion').find({ activo: true }).sort({ nombre: 1 }).toArray(),
    database.collection('productos').find({ activo: true }).sort({ nombre: 1 }).toArray(),
    database.collection('pedidos').find({ activo: { $ne: false } }).sort({ createdAt: -1 }).limit(100).toArray(),
    database.collection('pedidosProduccion').find({ estado: { $in: ['pendiente', 'en_proceso'] } }).sort({ createdAt: -1 }).limit(100).toArray(),
    database.collection('colaboradores').find({ activo: true }).sort({ nombreCompleto: 1 }).toArray(),
    database.collection('tramosGiveawayTarifa').find({}).sort({ tramo: -1 }).toArray()
  ]);
  const stringifyId = (document) => ({ ...document, _id: document._id.toString() });
  const orders = [...adminOrders.map((order) => ({ ...stringifyId(order), codigoPedido: order.nombre, nombre: order.nombre })), ...legacyOrders.map((order) => ({ ...stringifyId(order), nombre: order.codigoPedido || order.nombre }))];
  return response.json({ success: true, data: { lines: lines.map(stringifyId), products: products.map(stringifyId), orders, collaborators: collaborators.map(stringifyId), tariffBands: tariffBands.map(stringifyId) }, message: 'Catálogos operativos obtenidos.' });
}

export async function createShift(request, response) {
  const { lineaId, fecha, turno, jefeLineaId, pedidos = [], colaboradores = [] } = request.body;
  if (!['T1', 'T2'].includes(turno)) return response.status(400).json({ success: false, error: 'INVALID_SHIFT', message: 'El turno debe ser T1 o T2.' });
  const database = await getDatabase();
  const assignedManager = jefeLineaId ? id(jefeLineaId) : null;
  const [line, manager] = await Promise.all([
    database.collection('lineasProduccion').findOne({ _id: id(lineaId), activo: true }),
    database.collection('usuarios').aggregate([{ $match: { _id: assignedManager, activo: true } }, { $lookup: { from: 'roles', localField: 'roleId', foreignField: '_id', as: 'role' } }, { $unwind: '$role' }, { $match: { 'role.nombre': { $in: ['Jefe de linea', 'Jefe de línea', 'Supervisor'] } } }]).next()
  ]);
  if (!line) return response.status(404).json({ success: false, error: 'LINE_NOT_FOUND', message: 'La línea de producción no existe o está inactiva.' });
  if (!manager) return response.status(400).json({ success: false, error: 'INVALID_LINE_MANAGER', message: 'El jefe de línea no existe, está inactivo o no tiene el rol requerido.' });
  const document = { lineaId: id(lineaId), fecha: new Date(fecha), turno, estado: 'planificado', creadoPor: request.user._id, jefeLineaId: assignedManager, pedidos: pedidos.slice(0, 100).map((pedido, index) => ({ pedidoId: id(pedido.pedidoId), prioridad: Number(pedido.prioridad || index + 1) })), createdAt: new Date() };
  const result = await database.collection('turnosProduccion').insertOne(document);
  if (colaboradores.length) {
    await database.collection('asistenciaTurno').insertMany(colaboradores.map((colaboradorId) => ({ turnoId: result.insertedId, colaboradorId: id(colaboradorId), fecha: document.fecha, presente: true, horaIngreso: null, horaSalida: null, estado: 'available' })));
  }
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'turnosProduccion', entidadId: result.insertedId, accion: 'CREATE', datos: { lineaId: document.lineaId, fecha: document.fecha }, createdAt: document.createdAt });
  return response.status(201).json({ success: true, data: { ...document, _id: result.insertedId }, message: 'Turno creado.' });
}

export async function startShift(request, response) {
  const database = await getDatabase();
  const filter = { _id: id(request.params.id), estado: 'planificado' };
  if (isLineManager(request.user)) filter.jefeLineaId = request.user._id;
  const plannedShift = await database.collection('turnosProduccion').findOne(filter);
  if (!plannedShift) return response.status(404).json({ success: false, error: 'SHIFT_NOT_FOUND', message: 'Turno planificado no encontrado.' });
  const activeShift = await database.collection('turnosProduccion').findOne({ lineaId: plannedShift.lineaId, estado: 'activo', _id: { $ne: plannedShift._id } });
  if (activeShift) return response.status(409).json({ success: false, error: 'ACTIVE_SHIFT_EXISTS', message: 'Ya existe un proceso abierto en esta sala.' });
  const result = await database.collection('turnosProduccion').findOneAndUpdate({ _id: plannedShift._id, estado: 'planificado' }, { $set: { estado: 'activo', horaInicio: new Date() } }, { returnDocument: 'after' });
  if (!result) return response.status(404).json({ success: false, error: 'SHIFT_NOT_FOUND', message: 'Turno planificado no encontrado.' });
  await syncAttendanceForShift(database, result);
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'turnosProduccion', entidadId: result._id, accion: 'START', datos: { horaInicio: result.horaInicio }, createdAt: new Date() });
  return response.json({ success: true, data: result, message: 'Turno iniciado.' });
}

export async function closeShift(request, response) {
  const { kilosProcesados, porcentajeGiveaway, lineaId } = request.body;
  const database = await getDatabase();
  const shiftId = id(request.params.id);
  const lineId = id(lineaId);
  const shift = await database.collection('turnosProduccion').findOne({ _id: shiftId, estado: 'activo' });
  if (!shift) return response.status(404).json({ success: false, error: 'SHIFT_NOT_FOUND', message: 'Turno activo no encontrado.' });
  if (isLineManager(request.user) && shift.jefeLineaId?.toString() !== request.user._id.toString()) return response.status(403).json({ success: false, error: 'SHIFT_OWNER_REQUIRED', message: 'Solo el jefe responsable del proceso puede cerrarlo.' });
  if (!shift.lineaId.equals(lineId)) return response.status(400).json({ success: false, error: 'LINE_MISMATCH', message: 'La línea no corresponde al turno.' });

  const performance = await calculateShiftPerformanceFromGiveaway(database, kilosProcesados, porcentajeGiveaway);
  const calculatedAt = new Date();
  const rentResult = await database.collection('rentaVariable').insertOne({
    turnoId: shiftId,
    lineaId: lineId,
    porcentajeGiveaway: performance.giveaway,
    kilogramosProcesados: performance.kilogramosProcesados,
    kilogramosObjetivo: performance.kilogramosObjetivo,
    giveaway: performance.giveaway,
    tramoId: performance.tramoId,
    tramo: performance.tramo,
    tarifa: performance.tarifa,
    total: performance.total,
    calculadoAt: calculatedAt
  });

  const result = await database.collection('turnosProduccion').findOneAndUpdate(
    { _id: shiftId, estado: 'activo' },
    { $set: { estado: 'cerrado', horaFin: calculatedAt, cerradoPor: request.user._id, rentaVariableId: rentResult.insertedId } },
    { returnDocument: 'after' }
  );
  if (!result) return response.status(409).json({ success: false, error: 'SHIFT_CLOSE_CONFLICT', message: 'El turno cambió de estado antes de cerrarse.' });

  await database.collection('auditoria').insertOne({
    usuarioId: request.user._id,
    entidad: 'turnosProduccion',
    entidadId: shiftId,
    accion: 'CLOSE',
    datos: { rentaVariableId: rentResult.insertedId, tramo: performance.tramo, giveaway: performance.giveawayNumber },
    createdAt: calculatedAt
  });

  const nextShift = await createFollowUpShift(database, { ...result, cerradoPor: request.user._id }, calculatedAt);

  return response.json({ success: true, data: { shift: result, rentaVariable: { ...performance, _id: rentResult.insertedId }, nextShift, nextWorkflowStage: 'assigned' }, message: 'Día guardado y turno reiniciado para una nueva asignación.' });
}

export async function closeMonthlyIncentive(request, response) {
  const { lineaId } = request.body;
  const database = await getDatabase();
  const lineObjectId = id(lineaId);
  const line = await database.collection('lineasProduccion').findOne({ _id: lineObjectId, activo: true });
  if (!line) return response.status(404).json({ success: false, error: 'LINE_NOT_FOUND', message: 'La línea de producción no existe o está inactiva.' });

  await ensureManagedLine(database, request.user, lineObjectId);

  const shift = await findCurrentShift(database, { lineaId: lineObjectId });
  const turno = request.body.turno || shift?.turno || 'T1';
  if (!['T1', 'T2'].includes(turno)) return response.status(400).json({ success: false, error: 'INVALID_SHIFT', message: 'El turno debe ser T1 o T2.' });
  const allHistory = shift ? await loadGiveawayHistory(database, { ...shift, lineaId: lineObjectId }, request.user) : { rows: [], total: 0 };
  const history = { ...allHistory, rows: allHistory.rows.filter((row) => row.turno === turno) };
  history.total = history.rows.reduce((sum, row) => sum + row.amount, 0);
  if (!history.rows.length) return response.status(409).json({ success: false, error: 'NOTHING_TO_CLOSE', message: 'No hay incentivo acumulado para cerrar en este período.' });

  const closedAt = new Date();
  const document = {
    lineaId: lineObjectId,
    turno,
    cerradoPor: request.user._id,
    totalCerrado: history.total,
    registros: history.rows.length,
    cerradoAt: closedAt,
    ultimoRegistroId: history.rows[0]?._id || null,
    createdAt: closedAt
  };
  const result = await database.collection('cierresIncentivoMensual').insertOne(document);
  await database.collection('auditoria').insertOne({
    usuarioId: request.user._id,
    entidad: 'cierresIncentivoMensual',
    entidadId: result.insertedId,
    accion: 'CLOSE_MONTHLY_INCENTIVE',
    datos: { lineaId: lineObjectId, turno, totalCerrado: history.total, registros: history.rows.length },
    createdAt: closedAt
  });

  return response.json({ success: true, data: { ...document, _id: result.insertedId }, message: 'El incentivo mensual quedó cerrado y el acumulado se reinició.' });
}
