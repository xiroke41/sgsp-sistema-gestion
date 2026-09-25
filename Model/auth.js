const USERS = Object.freeze([
  { id: 'admin-01', name: 'Sofía Herrera', role: 'admin', roleLabel: 'Administrador', username: 'admin', password: 'Admin12345' },
  { id: 'jefe-01', name: 'Daniela Fuentes', role: 'line_manager', roleLabel: 'Jefe de línea', username: 'jefe', password: 'Jefe123456' },
  { id: 'supervisor-01', name: 'Tomás Vidal', role: 'supervisor', roleLabel: 'Supervisor', username: 'supervisor', password: 'super123' },
  { id: 'operator-01', name: 'Camila Rojas', role: 'operator', roleLabel: 'Operador', username: 'operador', password: 'operador123' }
]);

const ROLE_PERMISSIONS = Object.freeze({
  admin: ['view_dashboard', 'manage_shift', 'assign_shift', 'manage_people', 'register_break', 'register_downtime', 'close_shift'],
  line_manager: ['view_dashboard', 'manage_shift', 'assign_shift', 'manage_people', 'register_break', 'register_downtime', 'close_shift'],
  supervisor: ['view_dashboard', 'manage_shift', 'assign_shift', 'manage_people', 'register_break', 'register_downtime', 'close_shift'],
  operator: []
});

export function authenticate(username, password) {
  const user = USERS.find((candidate) => candidate.username === username && candidate.password === password);
  if (!user) return null;
  const { password: _password, ...session } = user;
  return session;
}

export function can(user, permission) {
  return Boolean(user && ROLE_PERMISSIONS[user.role]?.includes(permission));
}

export { USERS, ROLE_PERMISSIONS };
