import { ObjectId } from 'mongodb';
import { getDatabase } from './mongo.js';

function toObjectId(value) {
  if (!ObjectId.isValid(value)) {
    const error = new Error('Identificador inválido.');
    error.statusCode = 400;
    error.code = 'INVALID_ID';
    throw error;
  }
  return new ObjectId(value);
}

export async function listPersonnel({ activeOnly = false, cargo } = {}) {
  const database = await getDatabase();
  const filter = {};
  if (activeOnly) filter.activo = true;
  if (cargo) filter.cargo = cargo;
  return database.collection('colaboradores').find(filter).sort({ nombreCompleto: 1 }).toArray();
}

export async function createPersonnel(data) {
  const database = await getDatabase();
  const document = {
    nombreCompleto: String(data.nombreCompleto).trim(),
    fechaIngreso: new Date(data.fechaIngreso),
    cargo: String(data.cargo).trim(),
    turno: data.turno === 'T2' ? 'T2' : 'T1',
    certificaciones: Array.isArray(data.certificaciones) ? data.certificaciones.map((item) => String(item).trim()).filter(Boolean) : [],
    activo: true,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  if (data.rut && String(data.rut).trim()) document.rut = String(data.rut).trim();
  const result = await database.collection('colaboradores').insertOne(document);
  return { ...document, _id: result.insertedId };
}

export async function setPersonnelStatus(personnelId, active) {
  const database = await getDatabase();
  const result = await database.collection('colaboradores').findOneAndUpdate(
    { _id: toObjectId(personnelId) },
    { $set: { activo: Boolean(active), updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!result) {
    const error = new Error('El colaborador no existe.');
    error.statusCode = 404;
    error.code = 'PERSONNEL_NOT_FOUND';
    throw error;
  }
  return result;
}

export async function updatePersonnel(personnelId, data) {
  const database = await getDatabase();
  const result = await database.collection('colaboradores').findOneAndUpdate(
    { _id: toObjectId(personnelId) },
    { $set: { nombreCompleto: String(data.nombreCompleto).trim(), fechaIngreso: new Date(data.fechaIngreso), cargo: String(data.cargo).trim(), turno: data.turno === 'T2' ? 'T2' : 'T1', rut: String(data.rut || '').trim(), updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!result) {
    const error = new Error('El colaborador no existe.');
    error.statusCode = 404;
    error.code = 'PERSONNEL_NOT_FOUND';
    throw error;
  }
  return result;
}

export async function deletePersonnel(personnelId) {
  const database = await getDatabase();
  const personnel = await database.collection('colaboradores').findOne({ _id: toObjectId(personnelId) });
  if (!personnel) {
    const error = new Error('El colaborador no existe.');
    error.statusCode = 404;
    error.code = 'PERSONNEL_NOT_FOUND';
    throw error;
  }
  await database.collection('colaboradores').deleteOne({ _id: personnel._id });
  if (personnel.usuarioId) await database.collection('usuarios').deleteOne({ _id: personnel.usuarioId });
  return personnel;
}

export { toObjectId };
