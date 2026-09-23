import { ObjectId } from 'mongodb';
import { getDatabase } from '../Model/mongo.js';

function serialize(document) {
  if (!document) return null;
  return { ...document, _id: document._id.toString() };
}

function parseId(value) {
  if (!ObjectId.isValid(value)) {
    const error = new Error('El identificador no es válido.');
    error.statusCode = 400;
    throw error;
  }
  return new ObjectId(value);
}

function normalizePersonnelRole(cargo) {
  const normalized = String(cargo || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (normalized.includes('jefe')) return 'Jefe de Línea';
  if (normalized.includes('supervisor')) return 'Supervisor';
  return 'Operador';
}

export async function listOrders(request, response) {
  const database = await getDatabase();
  const orders = await database.collection('pedidos').find({}).sort({ nombre: 1 }).toArray();
  return response.json({ success: true, data: orders.map(serialize), message: 'Pedidos obtenidos.' });
}

export async function createOrder(request, response) {
  const nombre = String(request.body.nombre || '').trim();
  if (!nombre) return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'El nombre del pedido es obligatorio.' });
  const database = await getDatabase();
  if (await database.collection('pedidos').findOne({ nombre })) return response.status(409).json({ success: false, error: 'ORDER_EXISTS', message: 'Ya existe un pedido con ese nombre.' });
  const now = new Date();
  const result = await database.collection('pedidos').insertOne({ nombre, activo: true, createdAt: now, updatedAt: now });
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'pedidos', entidadId: result.insertedId, accion: 'CREATE', datos: { nombre }, createdAt: now });
  return response.status(201).json({ success: true, data: serialize({ _id: result.insertedId, nombre, activo: true, createdAt: now, updatedAt: now }), message: 'Pedido creado.' });
}

export async function updateOrder(request, response) {
  const orderId = parseId(request.params.id);
  const nombre = String(request.body.nombre || '').trim();
  if (!nombre) return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'El nombre del pedido es obligatorio.' });
  const database = await getDatabase();
  if (await database.collection('pedidos').findOne({ nombre, _id: { $ne: orderId } })) return response.status(409).json({ success: false, error: 'ORDER_EXISTS', message: 'Ya existe un pedido con ese nombre.' });
  const updatedAt = new Date();
  const changes = { nombre, updatedAt };
  if (typeof request.body.activo === 'boolean') changes.activo = request.body.activo;
  const result = await database.collection('pedidos').findOneAndUpdate({ _id: orderId }, { $set: changes }, { returnDocument: 'after' });
  if (!result) return response.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'El pedido no existe.' });
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'pedidos', entidadId: orderId, accion: 'UPDATE', datos: { nombre }, createdAt: updatedAt });
  return response.json({ success: true, data: serialize(result), message: 'Pedido actualizado.' });
}

export async function deleteOrder(request, response) {
  const orderId = parseId(request.params.id);
  const database = await getDatabase();
  const result = await database.collection('pedidos').deleteOne({ _id: orderId });
  if (!result.deletedCount) return response.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'El pedido no existe.' });
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'pedidos', entidadId: orderId, accion: 'DELETE', createdAt: new Date() });
  return response.json({ success: true, data: null, message: 'Pedido eliminado.' });
}

export async function listMachineCertificates(request, response) {
  const database = await getDatabase();
  const personnel = await database.collection('colaboradores').find({}).sort({ nombreCompleto: 1 }).toArray();
  const certificates = await database.collection('certificadosMaquina').find({}).toArray();
  const certificateByPerson = new Map(certificates.map((item) => [item.colaboradorId.toString(), item]));
  const data = personnel.map((person) => {
    const certificate = certificateByPerson.get(person._id.toString());
    return { _id: person._id.toString(), rut: person.rut || '', nombreCompleto: person.nombreCompleto, rol: normalizePersonnelRole(person.cargo), romana: Boolean(certificate?.romana), rayosX: Boolean(certificate?.rayosX), activo: person.activo !== false };
  });
  return response.json({ success: true, data, message: 'Certificados obtenidos.' });
}

export async function updateMachineCertificate(request, response) {
  const colaboradorId = parseId(request.params.id);
  if (typeof request.body.romana !== 'boolean' || typeof request.body.rayosX !== 'boolean') return response.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'romana y rayosX deben ser booleanos.' });
  const database = await getDatabase();
  const person = await database.collection('colaboradores').findOne({ _id: colaboradorId });
  if (!person) return response.status(404).json({ success: false, error: 'PERSON_NOT_FOUND', message: 'El trabajador no existe.' });
  const updatedAt = new Date();
  await database.collection('certificadosMaquina').updateOne({ colaboradorId }, { $set: { colaboradorId, romana: request.body.romana, rayosX: request.body.rayosX, actualizadoPor: request.user._id, updatedAt }, $setOnInsert: { createdAt: updatedAt } }, { upsert: true });
  await database.collection('auditoria').insertOne({ usuarioId: request.user._id, entidad: 'certificadosMaquina', entidadId: colaboradorId, accion: 'UPDATE', datos: { romana: request.body.romana, rayosX: request.body.rayosX }, createdAt: updatedAt });
  return response.json({ success: true, data: { _id: colaboradorId.toString(), romana: request.body.romana, rayosX: request.body.rayosX }, message: 'Certificados actualizados.' });
}
