import { getDatabase } from '../Model/mongo.js';

export async function listLineManagers(request, response) {
  const database = await getDatabase();
  const managers = await database.collection('usuarios').aggregate([
    { $match: { activo: true } },
    { $lookup: { from: 'roles', localField: 'roleId', foreignField: '_id', as: 'role' } },
    { $unwind: '$role' },
    { $match: { 'role.nombre': { $in: ['Jefe de linea', 'Jefe de línea', 'Supervisor'] } } },
    { $project: { _id: 1, username: 1 } },
    { $sort: { username: 1 } }
  ]).toArray();
  return response.json({ success: true, data: managers, message: 'Jefes de línea disponibles.' });
}

export async function summary(request, response) {
  const database = await getDatabase();
  const productionLines = await database.collection('lineasProduccion').find({ activo: true }).sort({ nombre: 1 }).toArray();
  const activeShifts = await database.collection('turnosProduccion').aggregate([
    { $match: { estado: 'activo' } },
    { $lookup: { from: 'lineasProduccion', localField: 'lineaId', foreignField: '_id', as: 'line' } },
    { $unwind: { path: '$line', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'usuarios', localField: 'jefeLineaId', foreignField: '_id', as: 'manager' } },
    { $unwind: { path: '$manager', preserveNullAndEmptyArrays: true } },
    { $project: { _id: 1, lineaId: 1, linea: '$line.nombre', fecha: 1, manager: '$manager.username' } }
  ]).toArray();
  const activeByLine = new Map(activeShifts.map((shift) => [String(shift.lineaId), shift]));
  const lines = await Promise.all(productionLines.map(async (line) => {
    const shift = activeByLine.get(String(line._id));
    return {
      id: line._id,
      name: line.nombre,
      status: shift ? 'Atención' : 'Pendiente',
      operators: shift ? await database.collection('asistenciaTurno').countDocuments({ turnoId: shift._id, presente: true, estado: { $ne: 'inactive' } }) : 0,
      manager: shift?.manager || null,
      product: shift ? null : null
    };
  }));
  const auditEvents = await database.collection('auditoria').countDocuments({});
  return response.json({ success: true, data: { activeRooms: new Set(lines.map((line) => String(line.id))).size, activePeople: lines.reduce((total, line) => total + line.operators, 0), auditEvents, lines }, message: 'Resumen administrativo obtenido.' });
}

