import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { getDatabase } from '../Model/mongo.js';

function jwtSecret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET no está configurado.');
  return process.env.JWT_SECRET;
}

export function signToken(user) {
  return jwt.sign({ sub: user._id.toString(), username: user.username, role: user.role }, jwtSecret(), { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
}

export async function authenticateRequest(request, response, next) {
  try {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return response.status(401).json({ success: false, error: 'AUTH_REQUIRED', message: 'Se requiere un token Bearer.' });
    const payload = jwt.verify(header.slice(7), jwtSecret());
    if (!ObjectId.isValid(payload.sub)) return response.status(401).json({ success: false, error: 'INVALID_TOKEN', message: 'El token no es válido.' });
    const database = await getDatabase();
    const user = await database.collection('usuarios').findOne({ _id: new ObjectId(payload.sub), activo: true });
    if (!user) return response.status(401).json({ success: false, error: 'USER_INACTIVE', message: 'El usuario no está activo.' });
    const role = await database.collection('roles').findOne({ _id: user.roleId, activo: true });
    if (!role) return response.status(403).json({ success: false, error: 'ROLE_NOT_FOUND', message: 'El rol del usuario no está configurado.' });
    request.user = { ...user, roleName: role.nombre, permissions: role.permisos };
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') return response.status(401).json({ success: false, error: 'INVALID_TOKEN', message: 'El token no es válido o expiró.' });
    next(error);
  }
}

export function requirePermission(permission) {
  return (request, response, next) => {
    if (request.user?.permissions?.all || request.user?.permissions?.[permission]) return next();
    return response.status(403).json({ success: false, error: 'FORBIDDEN', message: 'No tienes permisos para realizar esta acción.' });
  };
}
