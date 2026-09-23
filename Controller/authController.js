import bcrypt from 'bcryptjs';
import { getDatabase } from '../Model/mongo.js';
import { signToken } from '../middleware/auth.js';

export async function login(request, response) {
  const { username, password } = request.body;
  const database = await getDatabase();
  const user = await database.collection('usuarios').findOne({ username: String(username).trim(), activo: true });
  const valid = user && await bcrypt.compare(String(password), user.passwordHash);
  if (!valid) return response.status(401).json({ success: false, error: 'INVALID_CREDENTIALS', message: 'Usuario o contraseña incorrectos.' });
  const role = await database.collection('roles').findOne({ _id: user.roleId, activo: true });
  if (!role) return response.status(403).json({ success: false, error: 'ROLE_NOT_FOUND', message: 'El rol del usuario no está configurado.' });
  const token = signToken({ ...user, role: role.nombre });
  return response.json({ success: true, data: { token, user: { id: user._id, username: user.username, role: role.nombre, permissions: role.permisos } }, message: 'Autenticación exitosa.' });
}

export async function me(request, response) {
  return response.json({ success: true, data: { id: request.user._id, username: request.user.username, role: request.user.roleName, permissions: request.user.permissions }, message: 'Sesión activa.' });
}
