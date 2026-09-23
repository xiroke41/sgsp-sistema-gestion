const API_OVERRIDE_KEY = 'sgsp-api-url';
const localHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const storedApiUrl = localStorage.getItem(API_OVERRIDE_KEY);
const configuredApiUrl = window.SGSP_API_URL || (localHost ? storedApiUrl : null);
const API_BASE_URL = configuredApiUrl || (localHost ? 'http://localhost:3000/api' : '/api');

function buildApiCandidates() {
  const candidates = [API_BASE_URL];
  if (localHost && !window.SGSP_API_URL && API_BASE_URL === 'http://localhost:3000/api') candidates.push('http://localhost:3002/api');
  return [...new Set(candidates)];
}

function persistApiBaseUrl(baseUrl) {
  if (!window.SGSP_API_URL) localStorage.setItem(API_OVERRIDE_KEY, baseUrl);
}

async function request(path, options = {}) {
  const session = JSON.parse(localStorage.getItem('sgsp-operacion-session') || 'null');
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  let response;
  let networkError;
  for (const baseUrl of buildApiCandidates()) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    try {
      response = await fetch(`${baseUrl}${path}`, { ...options, headers, signal: controller.signal });
      persistApiBaseUrl(baseUrl);
      break;
    } catch (error) {
      networkError = error;
      if (error.name !== 'AbortError' && error.name !== 'TypeError') throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }
  if (!response) throw networkError || new Error('La API no está disponible.');
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || 'La API no pudo procesar la solicitud.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function loginApi(username, password) {
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export function getDashboardApi() {
  return request('/operation/dashboard');
}

export function getCatalogsApi() {
  return request('/operation/catalogs');
}

export function getLineManagersApi() {
  return request('/admin/line-managers');
}

export function getPersonnelApi(activeOnly = false) {
  return request(`/admin/personnel?activo=${activeOnly}`);
}

export function createPersonnelApi(data) {
  return request('/admin/personnel', { method: 'POST', body: JSON.stringify(data) });
}

export function updatePersonnelStatusApi(id, activo) {
  return request(`/admin/personnel/${id}/status`, { method: 'PATCH', body: JSON.stringify({ activo }) });
}
export function updatePersonnelApi(id, data) { return request(`/admin/personnel/${id}`, { method: 'PUT', body: JSON.stringify(data) }); }
export function deletePersonnelApi(id) { return request(`/admin/personnel/${id}`, { method: 'DELETE' }); }

export function getOrdersApi() { return request('/pedidos'); }
export function createOrderApi(nombre) { return request('/pedidos', { method: 'POST', body: JSON.stringify({ nombre }) });
}
export function updateOrderApi(id, nombre, activo) { return request(`/pedidos/${id}`, { method: 'PUT', body: JSON.stringify({ nombre, ...(typeof activo === 'boolean' ? { activo } : {}) }) }); }
export function deleteOrderApi(id) { return request(`/pedidos/${id}`, { method: 'DELETE' }); }
export function getMachineCertificatesApi() { return request('/certificados'); }
export function updateMachineCertificateApi(id, data) { return request(`/certificados/${id}`, { method: 'PUT', body: JSON.stringify(data) }); }

export function getAdminSummaryApi() {
  return request('/admin/summary');
}

export function createShiftApi(data) {
  return request('/shifts', { method: 'POST', body: JSON.stringify(data) });
}

export function startShiftApi(shiftId) {
  return request(`/shifts/${shiftId}/start`, { method: 'POST' });
}

export function createBreakApi(data) {
  return request('/breaks', { method: 'POST', body: JSON.stringify(data) });
}

export function endBreakApi(id) {
  return request(`/breaks/${id}/end`, { method: 'PATCH' });
}

export function createDowntimeApi(data) {
  return request('/downtimes', { method: 'POST', body: JSON.stringify(data) });
}

export function endDowntimeApi(id) {
  return request(`/downtimes/${id}/end`, { method: 'PATCH' });
}

export function deleteDowntimeApi(id) {
  return request(`/downtimes/${id}`, { method: 'DELETE' });
}

export function updateOperatorStatusApi(data) {
  return request('/operators/status', { method: 'PATCH', body: JSON.stringify(data) });
}

export function getRotationsApi(shiftId) {
  return request(`/rotations/${shiftId}`);
}

export function updateRotationGroupsApi(data) {
  return request('/operators/rotation-groups', { method: 'PATCH', body: JSON.stringify(data) });
}

export function closeShiftApi(shiftId, data) {
  return request(`/shifts/${shiftId}/close`, { method: 'POST', body: JSON.stringify(data) });
}

export function closeMonthlyIncentiveApi(lineaId, turno) {
  return request('/incentives/monthly-close', { method: 'POST', body: JSON.stringify({ lineaId, turno }) });
}

export function logoutApi() {
  return Promise.resolve();
}

export { API_BASE_URL };
