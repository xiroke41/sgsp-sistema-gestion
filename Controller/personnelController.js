import bcrypt from 'bcryptjs';
import { createPersonnel, deletePersonnel, listPersonnel, setPersonnelStatus, updatePersonnel } from '../Model/personnel.js';
import { getDatabase } from '../Model/mongo.js';
import { isStrongPassword, validateAccountRequest } from '../Model/accessPolicy.js';

function serialize(personnel) {
  return personnel.map((item) => ({ ...item, _id: item._id.toString(), activo: item.activo !== false, rol: item.rol || (String(item.cargo).toLowerCase().includes('jefe') ? 'Jefe de linea' : 'Operador'), turno: item.turno === 'T2' ? 'T2' : 'T1', fechaIngreso: item.fechaIngreso?.toISOString?.() || item.fechaIngreso }));
}

export async function list(request, response) {
  const activeOnly = request.query.activo === undefined ? false : request.query.activo === 'true';
  const personnel = await listPersonnel({ activeOnly, cargo: request.query.cargo });
  return response.json({ success: true, data: serialize(personnel), message: 'Personal obtenido.' });
}

export async function create(request, response) {
  const { nombreCompleto, fechaIngreso, cargo } = request.body;
  if (!String(nombreCompleto || '').trim() || !fechaIngreso || !String(cargo || '').trim()) {
    return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Nombre, fecha de ingreso y cargo son obligatorios.' });
  }
  const parsedDate = new Date(fechaIngreso);
  if (Number.isNaN(parsedDate.getTime())) return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'La fecha de ingreso no es válida.' });
  if (request.body.turno && !['T1', 'T2'].includes(request.body.turno)) return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'El turno debe ser T1 o T2.' });
  const accountError = validateAccountRequest(cargo, request.body.username, request.body.password);
  if (accountError) return response.status(400).json({ success: false, error: accountError.code, message: accountError.message });
  let personnel;
  try {
    personnel = await createPersonnel({ ...request.body, fechaIngreso: parsedDate });
  } catch (error) {
    if (error.code === 11000) return response.status(409).json({ success: false, error: 'PERSONNEL_EXISTS', message: 'El RUT ya está registrado.' });
    throw error;
  }
  const database = await getDatabase();
  let userId = null;
  if (request.body.username) {
    const normalizedCargo = String(cargo).toLowerCase();
    const roleName = normalizedCargo.includes('jefe') ? 'Jefe de linea' : (normalizedCargo.includes('supervisor') ? 'Supervisor' : 'Operador');
    const role = await database.collection('roles').findOne({ nombre: roleName, activo: true });
    if (!role) return response.status(422).json({ success: false, error: 'ROLE_NOT_FOUND', message: `No existe el rol ${roleName}.` });
    try {
      const user = await database.collection('usuarios').insertOne({ username: String(request.body.username).trim(), passwordHash: await bcrypt.hash(String(request.body.password), 12), roleId: role._id, activo: true, createdAt: new Date(), updatedAt: new Date() });
      userId = user.insertedId;
      await database.collection('colaboradores').updateOne({ _id: personnel._id }, { $set: { usuarioId: userId, updatedAt: new Date() } });
    } catch (error) {
      if (error.code === 11000) return response.status(409).json({ success: false, error: 'USERNAME_EXISTS', message: 'El usuario ya existe.' });
      await database.collection('colaboradores').deleteOne({ _id: personnel._id });
      throw error;
    }
  }
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'colaboradores', entidadId: personnel._id, accion: 'CREATE', datos: { nombreCompleto: personnel.nombreCompleto, cargo: personnel.cargo }, createdAt: new Date() });
  return response.status(201).json({ success: true, data: { ...personnel, _id: personnel._id.toString(), activo: personnel.activo !== false, rol: personnel.rol || (String(personnel.cargo).toLowerCase().includes('jefe') ? 'Jefe de linea' : 'Operador'), usuarioId: userId?.toString() || null, fechaIngreso: personnel.fechaIngreso.toISOString() }, message: 'Personal creado.' });
}

export async function updateStatus(request, response) {
  if (typeof request.body.activo !== 'boolean') return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'activo debe ser booleano.' });
  const personnel = await setPersonnelStatus(request.params.id, request.body.activo);
  const database = await getDatabase();
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'colaboradores', entidadId: personnel._id, accion: 'STATUS_CHANGE', datos: { activo: personnel.activo }, createdAt: new Date() });
  return response.json({ success: true, data: { ...personnel, _id: personnel._id.toString(), turno: personnel.turno === 'T2' ? 'T2' : 'T1' }, message: 'Estado del personal actualizado.' });
}

export async function update(request, response) {
  const { nombreCompleto, fechaIngreso, cargo } = request.body;
  if (!String(nombreCompleto || '').trim() || !fechaIngreso || !String(cargo || '').trim()) return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'Nombre, fecha de ingreso y cargo son obligatorios.' });
  const parsedDate = new Date(fechaIngreso);
  if (Number.isNaN(parsedDate.getTime())) return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'La fecha de ingreso no es válida.' });
  if (request.body.turno && !['T1', 'T2'].includes(request.body.turno)) return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'El turno debe ser T1 o T2.' });
  if (request.body.password !== undefined && request.body.password !== '' && !isStrongPassword(request.body.password)) return response.status(400).json({ success: false, error: 'WEAK_PASSWORD', message: 'La nueva contraseña debe tener al menos 12 caracteres, mayúscula, minúscula, número y símbolo.' });
  const existingPersonnel = request.body.password ? await listPersonnel({ activeOnly: false }).then((items) => items.find((item) => item._id.toString() === request.params.id)) : null;
  if (request.body.password && !existingPersonnel?.usuarioId) return response.status(409).json({ success: false, error: 'ACCOUNT_NOT_FOUND', message: 'El colaborador no tiene una cuenta de acceso.' });
  const personnel = await updatePersonnel(request.params.id, { ...request.body, fechaIngreso: parsedDate });
  if (request.body.password) {
    const database = await getDatabase();
    await database.collection('usuarios').updateOne({ _id: personnel.usuarioId }, { $set: { passwordHash: await bcrypt.hash(String(request.body.password), 12), updatedAt: new Date() } });
  }
  const database = await getDatabase();
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'colaboradores', entidadId: personnel._id, accion: 'UPDATE', datos: { nombreCompleto: personnel.nombreCompleto, cargo: personnel.cargo }, createdAt: new Date() });
  return response.json({ success: true, data: { ...personnel, _id: personnel._id.toString(), turno: personnel.turno === 'T2' ? 'T2' : 'T1', fechaIngreso: personnel.fechaIngreso.toISOString() }, message: 'Información del personal actualizada.' });
}

export async function remove(request, response) {
  const personnel = await deletePersonnel(request.params.id);
  const database = await getDatabase();
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'colaboradores', entidadId: personnel._id, accion: 'DELETE', datos: { nombreCompleto: personnel.nombreCompleto }, createdAt: new Date() });
  return response.json({ success: true, data: null, message: 'Personal eliminado.' });
}
