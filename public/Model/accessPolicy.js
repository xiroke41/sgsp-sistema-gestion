export function canHavePlatformAccess(cargo) {
  const normalized = String(cargo || '').trim().toLowerCase();
  return normalized.includes('jefe') || normalized.includes('supervisor');
}

export function validateAccountRequest(cargo, username, password) {
  const accountRequested = Boolean(username || password);
  if (!accountRequested) return null;
  if (!canHavePlatformAccess(cargo)) return { code: 'OPERATOR_ACCESS_FORBIDDEN', message: 'Los colaboradores no tienen acceso a la plataforma.' };
  if (!String(username || '').trim() || !isStrongPassword(password)) return { code: 'VALIDATION_ERROR', message: 'El usuario es obligatorio y la contraseña debe tener al menos 12 caracteres, mayúscula, minúscula, número y símbolo.' };
  return null;
}

export function isStrongPassword(password) {
  const value = String(password || '');
  return value.length >= 12 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9\s]/.test(value);
}
