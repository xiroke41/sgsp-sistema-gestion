export function canHavePlatformAccess(cargo) {
  return String(cargo || '').trim().toLowerCase().includes('jefe');
}

export function validateAccountRequest(cargo, username, password) {
  const accountRequested = Boolean(username || password);
  if (!accountRequested) return null;
  if (!canHavePlatformAccess(cargo)) return { code: 'OPERATOR_ACCESS_FORBIDDEN', message: 'Los colaboradores no tienen acceso a la plataforma.' };
  if (!String(username || '').trim() || String(password || '').length < 8) return { code: 'VALIDATION_ERROR', message: 'Usuario y contraseña de al menos 8 caracteres son obligatorios para un Jefe de línea.' };
  return null;
}
