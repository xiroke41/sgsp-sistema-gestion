import { ObjectId } from 'mongodb';
import { getDatabase } from '../Model/mongo.js';

function id(value) {
  if (!ObjectId.isValid(value)) { const error = new Error('Identificador inválido.'); error.statusCode = 400; error.code = 'INVALID_ID'; throw error; }
  return new ObjectId(value);
}

export async function createBreak(request, response) {
  const { turnoId, colaboradorId, tipo } = request.body;
  if (!['bano', 'colacion', 'permiso'].includes(tipo)) return response.status(400).json({ success: false, error: 'INVALID_BREAK_TYPE', message: 'Tipo de pausa inválido.' });
  const database = await getDatabase();
  const turnoObjectId = id(turnoId);
  const colaboradorObjectId = id(colaboradorId);
  const attendance = await database.collection('asistenciaTurno').findOne({ turnoId: turnoObjectId, colaboradorId: colaboradorObjectId, presente: true });
  if (!attendance) return response.status(404).json({ success: false, error: 'OPERATOR_NOT_FOUND', message: 'La asistencia del colaborador no existe en el turno.' });
  const document = { turnoId: turnoObjectId, colaboradorId: colaboradorObjectId, tipo, lineaAnterior: attendance.lineaTrabajo || 'unassigned', inicio: new Date(), fin: null };
  try {
    const result = await database.collection('pausasSala').insertOne(document);
    await database.collection('asistenciaTurno').updateOne({ turnoId: document.turnoId, colaboradorId: document.colaboradorId, presente: true }, { $set: { estado: 'break', lineaTrabajo: tipo === 'bano' ? 'bano' : 'colacion', updatedAt: document.inicio } });
    await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'pausasSala', entidadId: result.insertedId, accion: 'START', datos: { turnoId: document.turnoId, colaboradorId: document.colaboradorId, tipo }, createdAt: document.inicio });
    return response.status(201).json({ success: true, data: { ...document, _id: result.insertedId }, message: 'Pausa iniciada.' });
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ success: false, error: 'BREAK_ALREADY_ACTIVE', message: 'El colaborador ya tiene una pausa activa en este turno.' });
    throw error;
  }
}

export async function endBreak(request, response) {
  const database = await getDatabase();
  const breakId = id(request.params.id);
  const activeBreak = await database.collection('pausasSala').findOne({ _id: breakId, fin: null });
  if (!activeBreak) return response.status(404).json({ success: false, error: 'BREAK_NOT_FOUND', message: 'Pausa activa no encontrada.' });
  const result = await database.collection('pausasSala').findOneAndUpdate({ _id: id(request.params.id), fin: null }, { $set: { fin: new Date() } }, { returnDocument: 'after' });
  const returnLine = activeBreak.lineaAnterior || 'unassigned';
  await database.collection('asistenciaTurno').updateOne({ turnoId: activeBreak.turnoId, colaboradorId: activeBreak.colaboradorId }, { $set: { estado: returnLine === 'unassigned' ? 'available' : 'assigned', lineaTrabajo: returnLine, updatedAt: result.fin } });
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'pausasSala', entidadId: result._id, accion: 'END', datos: { fin: result.fin }, createdAt: result.fin });
  return response.json({ success: true, data: result, message: 'Pausa finalizada.' });
}

export async function createDowntime(request, response) {
  const { turnoId, categoria, motivo } = request.body;
  const categories = ['mecanica', 'calidad', 'abastecimiento', 'seguridad', 'otra'];
  if (!categories.includes(categoria) || !String(motivo).trim()) return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Categoría o motivo inválido.' });
  const document = { turnoId: id(turnoId), categoria, motivo: String(motivo).trim(), inicio: new Date(), fin: null, duracionMinutos: null, registradoPor: request.user._id };
  const database = await getDatabase();
  const result = await database.collection('detencionesLinea').insertOne(document);
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'detencionesLinea', entidadId: result.insertedId, accion: 'CREATE', datos: { turnoId: document.turnoId, categoria, motivo: document.motivo }, createdAt: document.inicio });
  return response.status(201).json({ success: true, data: { ...document, _id: result.insertedId }, message: 'Detención registrada.' });
}

export async function endDowntime(request, response) {
  const database = await getDatabase();
  const finishedAt = new Date();
  const downtime = await database.collection('detencionesLinea').findOne({ _id: id(request.params.id), fin: null });
  if (!downtime) return response.status(404).json({ success: false, error: 'DOWNTIME_NOT_FOUND', message: 'Detención activa no encontrada.' });
  const durationMinutes = Math.max(0, (finishedAt.getTime() - downtime.inicio.getTime()) / 60000);
  const result = await database.collection('detencionesLinea').findOneAndUpdate(
    { _id: downtime._id, fin: null },
    { $set: { fin: finishedAt, duracionMinutos: Number(durationMinutes.toFixed(2)) } },
    { returnDocument: 'after' }
  );
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'detencionesLinea', entidadId: result._id, accion: 'END', datos: { fin: finishedAt, duracionMinutos: result.duracionMinutos }, createdAt: finishedAt });
  return response.json({ success: true, data: result, message: 'Detención finalizada.' });
}

export async function deleteDowntime(request, response) {
  const database = await getDatabase();
  const downtimeId = id(request.params.id);
  const downtime = await database.collection('detencionesLinea').findOne({ _id: downtimeId });
  if (!downtime) return response.status(404).json({ success: false, error: 'DOWNTIME_NOT_FOUND', message: 'Detención no encontrada.' });
  const result = await database.collection('detencionesLinea').deleteOne({ _id: downtimeId });
  if (!result.deletedCount) return response.status(404).json({ success: false, error: 'DOWNTIME_NOT_FOUND', message: 'Detención no encontrada.' });
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'detencionesLinea', entidadId: downtimeId, accion: 'DELETE', datos: { turnoId: downtime.turnoId, motivo: downtime.motivo }, createdAt: new Date() });
  return response.json({ success: true, data: null, message: 'Detención eliminada.' });
}

export async function updateOperatorStatus(request, response) {
  const { turnoId, colaboradorId, estado, puestoId, lineaTrabajo } = request.body;
  const allowed = ['available', 'assigned', 'break', 'inactive'];
  if (!allowed.includes(estado)) return response.status(400).json({ success: false, error: 'INVALID_STATUS', message: 'Estado de operador inválido.' });
  const database = await getDatabase();
  const turnoObjectId = id(turnoId);
  const colaboradorObjectId = id(colaboradorId);
  const attendance = await database.collection('asistenciaTurno').findOne({ turnoId: turnoObjectId, colaboradorId: colaboradorObjectId, presente: true });
  if (!attendance) return response.status(404).json({ success: false, error: 'OPERATOR_NOT_FOUND', message: 'La asistencia del colaborador no existe en el turno.' });

  const lineRules = {
    mesa: { capacity: 5, label: 'Mesa Prolijado' },
    maquinas: { capacity: 4, label: 'Máquinas' },
    embalaje: { capacity: 6, label: 'Embalaje / Embutidora' },
    rayos: { capacity: 2, label: 'Rayos X (Cert.)', certification: 'rayos' },
    romana: { capacity: 1, label: 'Romana (Especial)', certification: 'romana' },
    bano: { capacity: null, label: 'Baño' },
    colacion: { capacity: null, label: 'Colación' },
    unassigned: { capacity: null, label: 'Disponibles / En espera' }
  };
  const targetLine = lineaTrabajo ? String(lineaTrabajo).trim() : attendance.lineaTrabajo || 'unassigned';
  const rule = lineRules[targetLine];
  if (!rule) return response.status(400).json({ success: false, error: 'INVALID_WORK_LINE', message: 'Línea de trabajo inválida.' });
  if (rule.capacity !== null && targetLine !== attendance.lineaTrabajo) {
    const assignedCount = await database.collection('asistenciaTurno').countDocuments({ turnoId: turnoObjectId, presente: true, lineaTrabajo: targetLine, colaboradorId: { $ne: colaboradorObjectId }, estado: { $nin: ['inactive', 'break'] } });
    if (assignedCount >= rule.capacity) return response.status(409).json({ success: false, error: 'WORK_LINE_FULL', message: `La línea ${rule.label} alcanzó su capacidad máxima.` });
  }
  if (rule.certification) {
    const certificate = await database.collection('certificadosMaquina').findOne({ colaboradorId: colaboradorObjectId });
    const certified = rule.certification === 'rayos' ? Boolean(certificate?.rayosX) : Boolean(certificate?.romana);
    if (!certified) return response.status(403).json({ success: false, error: 'CERTIFICATION_REQUIRED', message: `Se requiere certificación para ${rule.label}.` });
  }

  const now = new Date();
  const currentRotation = await database.collection('rotacionesPuesto').findOne({ turnoId: turnoObjectId, colaboradorId: colaboradorObjectId, fin: null });
  const position = await database.collection('puestos').findOne({ codigo: targetLine, activo: true });
  if (!position) return response.status(422).json({ success: false, error: 'WORK_LINE_NOT_CONFIGURED', message: `La línea ${rule.label} no está configurada en puestos.` });
  if (currentRotation && currentRotation.puestoNuevoId.equals(position._id) && attendance.estado === estado) return response.json({ success: true, data: attendance, message: 'Sin cambios.' });
  if (currentRotation) await database.collection('rotacionesPuesto').updateOne({ _id: currentRotation._id, fin: null }, { $set: { fin: now } });
  await database.collection('rotacionesPuesto').insertOne({ turnoId: turnoObjectId, colaboradorId: colaboradorObjectId, puestoAnteriorId: currentRotation?.puestoNuevoId || null, puestoNuevoId: position._id, inicio: now, fin: null });
  const update = { estado, updatedAt: new Date() };
  if (puestoId) update.puestoId = id(puestoId);
  update.lineaTrabajo = targetLine;
  const result = await database.collection('asistenciaTurno').findOneAndUpdate({ _id: attendance._id }, { $set: update }, { returnDocument: 'after' });
  if (!result) return response.status(404).json({ success: false, error: 'OPERATOR_NOT_FOUND', message: 'La asistencia del colaborador no existe en el turno.' });
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'rotacionesPuesto', entidadId: result._id, accion: 'ROTATE', datos: { turnoId: result.turnoId, colaboradorId: result.colaboradorId, lineaTrabajo: targetLine, estado }, createdAt: now });
  return response.json({ success: true, data: result, message: 'Estado de operador actualizado.' });
}

export async function listRotations(request, response) {
  const database = await getDatabase();
  const rotations = await database.collection('rotacionesPuesto').aggregate([
    { $match: { turnoId: id(request.params.turnoId) } },
    { $lookup: { from: 'colaboradores', localField: 'colaboradorId', foreignField: '_id', as: 'colaborador' } },
    { $unwind: { path: '$colaborador', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'puestos', localField: 'puestoNuevoId', foreignField: '_id', as: 'puestoNuevo' } },
    { $unwind: { path: '$puestoNuevo', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'puestos', localField: 'puestoAnteriorId', foreignField: '_id', as: 'puestoAnterior' } },
    { $unwind: { path: '$puestoAnterior', preserveNullAndEmptyArrays: true } },
    { $project: { _id: 1, colaboradorId: 1, colaborador: '$colaborador.nombreCompleto', anterior: '$puestoAnterior.descripcion', nuevo: '$puestoNuevo.descripcion', inicio: 1, fin: 1 } },
    { $sort: { inicio: -1 } },
    { $limit: 200 }
  ]).toArray();
  return response.json({ success: true, data: rotations, message: 'Historial de rotaciones obtenido.' });
}

export async function updateRotationGroups(request, response) {
  const { turnoId, colaboradorId, grupoRotacion, grupoPuesto } = request.body;
  const group = Number(grupoRotacion);
  if (![1, 2].includes(group)) return response.status(400).json({ success: false, error: 'INVALID_ROTATION_GROUP', message: 'El grupo de rotación debe ser G1 o G2.' });
  if (grupoPuesto && !['A', 'B', 'C'].includes(grupoPuesto)) return response.status(400).json({ success: false, error: 'INVALID_POSITION_GROUP', message: 'El grupo de puesto debe ser A, B o C.' });
  const database = await getDatabase();
  const result = await database.collection('asistenciaTurno').findOneAndUpdate(
    { turnoId: id(turnoId), colaboradorId: id(colaboradorId), presente: true },
    { $set: { grupoRotacion: group, ...(grupoPuesto ? { grupoPuesto } : {}), updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!result) return response.status(404).json({ success: false, error: 'OPERATOR_NOT_FOUND', message: 'La asistencia del colaborador no existe en el turno.' });
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'asistenciaTurno', entidadId: result._id, accion: 'ROTATION_GROUP_CHANGE', datos: { colaboradorId: result.colaboradorId, grupoRotacion: group, grupoPuesto }, createdAt: result.updatedAt });
  return response.json({ success: true, data: result, message: `Colaborador asignado a G${group}.` });
}
