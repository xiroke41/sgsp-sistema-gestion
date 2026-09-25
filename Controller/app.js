import { calculatePerformance, evaluateIncentive } from '../Model/giveaway.js';
import { authenticate, can } from '../Model/auth.js';
import { nextPositionGroup, nextWorkLine, returnLineAfterBreak } from '../Model/operationRules.js';
import { closeMonthlyIncentiveApi, closeShiftApi, createBreakApi, createDowntimeApi, createOrderApi, createPersonnelApi, createShiftApi, deleteDowntimeApi, deleteOrderApi, deletePersonnelApi, endBreakApi, endDowntimeApi, getCatalogsApi, getDashboardApi, getLineManagersApi, getMachineCertificatesApi, getOrdersApi, getPersonnelApi, getRotationsApi, loginApi, logoutApi, startShiftApi, updateMachineCertificateApi, updateOrderApi, updatePersonnelApi, updatePersonnelStatusApi, updateRotationGroupsApi, updateOperatorStatusApi } from './apiClient.js';

const STORAGE_KEY = 'sgsp-operacion-state';
const SESSION_KEY = 'sgsp-operacion-session';
const initialState = {
  shift: { active: true, workflowStage: 'in_process', line: 'Andes Asia', product: 'Filete congelado 500 g', order: 'OP-2409', targetWeight: 10000, actualWeight: 10042, startedAt: '06:00' },
  parameters: { pauseTolerance: 10, optimalGiveaway: 0.16 },
  operators: [
    { id: 'OP-014', name: 'Camila Rojas', role: 'Envasado', status: 'assigned', station: 'Puesto 04', productivity: '98%', grupoRotacion: 1, grupoPuesto: 'A' },
    { id: 'OP-021', name: 'Diego Muñoz', role: 'Pesaje', status: 'assigned', station: 'Puesto 02', productivity: '96%', grupoRotacion: 2, grupoPuesto: 'B' },
    { id: 'OP-008', name: 'Marcelo Soto', role: 'Operador', status: 'available', station: 'Sin puesto', productivity: '—', grupoRotacion: 1, grupoPuesto: 'C' },
    { id: 'OP-032', name: 'Valentina Pérez', role: 'Envasado', status: 'break', station: 'Colación', productivity: '94%', grupoRotacion: 2, grupoPuesto: 'A', breakStarted: Date.now() - 11 * 60 * 1000 }
  ],
  downtime: [{ id: 'demo-downtime-1', time: '08:42', duration: '06 min', reason: 'Ajuste de selladora', category: 'Mecánica', inicio: '2026-09-20T08:42:00.000Z', fin: '2026-09-20T08:48:00.000Z' }],
  activeDowntimes: [],
  giveawayHistory: [],
  giveawayHistoryTotal: 0
};

let state = loadState();
let session = loadSession();
let selectedOperatorId = null;
let draggedOperatorId = null;
let activeView = 'dashboard';
let selectedGroupEditorId = null;
let selectedColacionEditorId = null;
let shiftTimerInterval = null;
let catalogs = { lines: [], products: [], orders: [], collaborators: [] };
let lineManagers = [];
const viewTemplateCache = new Map();
const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
document.addEventListener('invalid', (event) => {
  const field = event.target;
  if (!field || !field.willValidate) return;
  if (field.validity.valueMissing) field.setCustomValidity('Completa este campo.');
  else if (field.validity.typeMismatch) field.setCustomValidity('Ingresa un valor válido.');
  else if (field.validity.patternMismatch) field.setCustomValidity('Usa el formato indicado.');
}, true);
document.addEventListener('input', (event) => event.target?.setCustomValidity?.(''));
const statusLabels = { available: 'Disponibles', assigned: 'Asignados', break: 'En pausa', inactive: 'Inactivos' };
const statusOrder = ['available', 'assigned', 'break', 'inactive'];
const workLines = [
  { id: 'unassigned', label: 'Disponibles / En espera', capacity: null },
  { id: 'mesa', label: 'Mesa Prolijado', capacity: 5 },
  { id: 'maquinas', label: 'Máquinas', capacity: 4 },
  { id: 'embalaje', label: 'Embalaje / Embutidora', capacity: 6 },
  { id: 'rayos', label: 'Rayos X (Cert.)', capacity: 2 },
  { id: 'romana', label: 'Romana (Especial)', capacity: 1 },
  { id: 'bano', label: 'Baño', capacity: null },
  { id: 'colacion', label: 'Colación', capacity: null }
];

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored) return structuredClone(initialState);
    return { ...structuredClone(initialState), ...stored, shift: { ...structuredClone(initialState.shift), ...(stored.shift || {}) }, parameters: { ...structuredClone(initialState.parameters), ...(stored.parameters || {}) } };
  }
  catch { return structuredClone(initialState); }
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); }
  catch { return null; }
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
async function loadViewTemplate(path) {
  if (viewTemplateCache.has(path)) return viewTemplateCache.get(path);
  const response = await fetch(path);
  if (!response.ok) throw new Error(`No se pudo cargar la vista ${path}`);
  const template = await response.text();
  viewTemplateCache.set(path, template);
  return template;
}
async function hydratePhysicalViews() {
  const sections = document.querySelectorAll('.dashboard-section');
        const templates = [
          { section: sections[0], path: 'Views/operacion/inicio-proceso.html', name: 'inicio-proceso' },
          { section: sections[1], path: 'Views/operacion/en-proceso.html', name: 'en-proceso' },
          { section: sections[2], path: 'Views/operacion/gestion-personal.html', name: 'gestion-personal' },
          { section: sections[3], path: 'Views/operacion/cierre-turno.html', name: 'cierre-turno' }
  ];
  for (const item of templates) {
    if (!item.section) continue;
    try {
      const template = await loadViewTemplate(item.path);
      const documentFragment = new DOMParser().parseFromString(template, 'text/html');
      const physicalView = documentFragment.body.firstElementChild;
      if (!physicalView) continue;
      item.section.innerHTML = physicalView.innerHTML;
      item.section.dataset.physicalView = item.name;
      if (item.name === 'inicio-proceso') {
        const line = item.section.querySelector('#line');
        const shiftType = item.section.querySelector('#shiftType');
        const order = item.section.querySelector('#order');
        const date = item.section.querySelector('#shiftDate');
        if (line) line.value = state.shift.lineaId || catalogs.lines[0]?._id || '';
        if (shiftType) shiftType.value = state.shift.turno || 'T1';
        if (order) order.innerHTML = catalogs.orders.length ? catalogs.orders.map((item) => `<option value="${item._id}">${item.nombre || item.codigoPedido}</option>`).join('') : '<option value="" disabled selected>No hay pedidos activos</option>';
        if (date) { const today = new Date(); date.value = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`; }
        const alreadyInProcess = workflowStage() === 'in_process';
        item.section.querySelector('[data-shift-status]')?.replaceChildren(document.createTextNode(alreadyInProcess ? 'Turno en proceso' : 'Asignado'));
        const submitButton = item.section.querySelector('#startProcessForm button[type="submit"]');
        if (submitButton) { submitButton.disabled = alreadyInProcess; submitButton.textContent = alreadyInProcess ? 'Ya hay un turno en proceso' : 'Confirmar e iniciar proceso'; }
        item.section.querySelectorAll('#startProcessForm select, #startProcessForm input').forEach((field) => { field.disabled = alreadyInProcess; });
      }
      if (item.name === 'en-proceso') {
        const tableBody = item.section.querySelector('#downtimeTable tbody');
        if (tableBody) tableBody.innerHTML = renderDowntimeRows();
      }
      if (item.name === 'gestion-personal') {
        const board = item.section.querySelector('#workLinesBoard');
        if (board) board.innerHTML = workLines.map(renderWorkLine).join('');
      }
      if (item.name === 'cierre-turno') {
        const actualWeight = item.section.querySelector('#actualWeight');
        if (actualWeight) actualWeight.value = state.shift.actualWeight;
        const tramoT1Table = item.section.querySelector('[data-tramo-t1-body]');
        if (tramoT1Table) tramoT1Table.innerHTML = renderTramoRowsByShift('T1');
        const tramoT2Table = item.section.querySelector('[data-tramo-t2-body]');
        if (tramoT2Table) tramoT2Table.innerHTML = renderTramoRowsByShift('T2');
        const totals = state.giveawayHistoryTotalsByShift || { T1: 0, T2: 0 };
        item.section.querySelector('[data-giveaway-total-t1]')?.replaceChildren(document.createTextNode(formatCurrencyCLP(totals.T1)));
        item.section.querySelector('[data-giveaway-total-t2]')?.replaceChildren(document.createTextNode(formatCurrencyCLP(totals.T2)));
        if (session.token && !state.shift._id) {
          item.section.querySelector('[data-close-status]').textContent = 'Sin turno activo';
          item.section.querySelector('.lede').textContent = 'Asigna e inicia un turno desde Apertura de turno para habilitar el cierre.';
        }
      }
    } catch (error) {
      console.warn(error.message);
    }
  }
}
function normalizeRole(role) {
  return { Administrador: 'admin', 'Jefe de linea': 'line_manager', 'Jefe de línea': 'line_manager', Supervisor: 'supervisor', Operador: 'operator' }[role] || role;
}
function deriveWorkflowStageFromShift(shift) {
  if (shift?.estado === 'planificado') return 'assigned';
  if (shift?.estado === 'cerrado') return 'completed';
  if (shift?.estado === 'activo') return 'in_process';
  if (shift?.workflowStage === 'assigned' || shift?.workflowStage === 'in_process' || shift?.workflowStage === 'completed') return shift.workflowStage;
  return 'in_process';
}
async function hydrateFromApi() {
  if (!session?.token) return;
  try {
    const response = await getDashboardApi();
    if (response.data?.shift) {
      const nextShift = response.data.shift;
      state.shift = {
        ...state.shift,
        ...nextShift,
        horaInicio: nextShift.horaInicio || null,
        line: nextShift.linea || state.shift.line,
        workflowStage: deriveWorkflowStageFromShift(nextShift),
        active: nextShift.estado === 'activo',
        startedAt: nextShift.horaInicio ? new Date(nextShift.horaInicio).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : 'Pendiente'
      };
      state.operators = response.data.operators.map((operator) => ({ id: operator.colaboradorId || operator._id, name: operator.nombre || 'Colaborador', role: operator.cargo || 'Operador', status: operator.estado || 'available', station: operator.puestoId || 'Sin puesto', workLine: operator.lineaTrabajo || 'unassigned', productivity: operator.productividad || '—', grupoRotacion: operator.grupoRotacion, grupoPuesto: operator.grupoPuesto }));
      state.downtime = response.data.downtime.map((event) => ({ id: event._id, time: new Date(event.inicio).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }), duration: event.duracionMinutos !== null ? `${event.duracionMinutos} min` : 'En curso', reason: event.motivo, category: event.categoria, inicio: event.inicio, fin: event.fin }));
      state.activeDowntimes = state.downtime.filter((event) => !event.fin);
      state.giveawayHistory = (response.data.giveawayHistory?.rows || []).map((entry) => { const date = new Date(entry.fecha); return { id: entry._id, date: date.toLocaleDateString('es-CL'), day: date.getDate(), month: date.getMonth(), year: date.getFullYear(), shift: entry.turno || 'T1', tramo: Number(entry.tramo || 0), giveaway: Number(entry.giveaway || 0), amount: Number(entry.amount || 0) }; });
      state.giveawayHistoryTotal = Number(response.data.giveawayHistory?.total || 0);
      state.giveawayHistoryTotalsByShift = state.giveawayHistory.reduce((totals, entry) => { const shift = entry.shift === 'T2' ? 'T2' : 'T1'; totals[shift] += entry.amount; return totals; }, { T1: 0, T2: 0 });
      state.giveawayHistoryClosedAt = response.data.giveawayHistory?.closedAt || null;
    } else {
      state.shift = { ...structuredClone(initialState.shift), workflowStage: 'assigned', active: false, actualWeight: structuredClone(initialState.shift.targetWeight), startedAt: 'Pendiente' };
      state.operators = [];
      state.downtime = [];
      state.activeDowntimes = [];
      state.giveawayHistory = [];
      state.giveawayHistoryTotal = 0;
      state.giveawayHistoryTotalsByShift = { T1: 0, T2: 0 };
      state.giveawayHistoryClosedAt = null;
    }
    state.apiConnected = true;
    saveState();
  } catch (error) {
    state.apiConnected = false;
    if (error.status === 401) logout();
  }
}
async function hydrateCatalogs() {
  if (!session?.token || !can(session, 'manage_shift')) return;
  try {
    catalogs = (await getCatalogsApi()).data;
    if (session.role === 'admin') lineManagers = (await getLineManagersApi()).data;
  } catch (error) { showToast(error.message); }
}
function formatNumber(value) { return new Intl.NumberFormat('es-CL').format(value); }
function formatDecimal(value, digits = 2) { return new Intl.NumberFormat('es-CL', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value || 0)); }
function formatCurrencyCLP(value) { return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(Number(value || 0)); }
function formatElapsedTime(startedAt) { if (!startedAt) return '00:00:00'; const elapsed = Math.max(0, Date.now() - new Date(startedAt).getTime()); const seconds = Math.floor(elapsed / 1000); return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((value) => String(value).padStart(2, '0')).join(':'); }
function renderTariffChart(shiftName) { const now = new Date(); const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(); const entries = (state.giveawayHistory || []).filter((entry) => entry.shift === shiftName && entry.month === now.getMonth() && entry.year === now.getFullYear() && entry.tramo > 0).sort((a, b) => a.day - b.day); const width = 560; const height = 220; const left = 34; const right = 16; const top = 18; const bottom = 30; const chartWidth = width - left - right; const chartHeight = height - top - bottom; const xForDay = (day) => left + ((day - 1) * chartWidth) / Math.max(daysInMonth - 1, 1); const yForTramo = (tramo) => top + ((10 - Math.min(10, Math.max(1, tramo))) * chartHeight) / 9; const lines = Array.from({ length: 10 }, (_, index) => { const tramo = 10 - index; const y = yForTramo(tramo); return `<line class="chart-gridline" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="chart-y-label" x="${left - 8}" y="${y + 4}" text-anchor="end">${tramo}</text>`; }).join(''); const dayLabels = Array.from({ length: daysInMonth }, (_, index) => index + 1).filter((day) => day === 1 || day % 5 === 0 || day === daysInMonth).map((day) => `<text class="chart-x-label" x="${xForDay(day)}" y="${height - 8}" text-anchor="middle">${day}</text>`).join(''); const points = entries.map((entry) => `${xForDay(entry.day)},${yForTramo(entry.tramo)}`).join(' '); const dots = entries.map((entry) => `<circle class="chart-point chart-point-${shiftName.toLowerCase()}" cx="${xForDay(entry.day)}" cy="${yForTramo(entry.tramo)}" r="4"><title>Día ${entry.day}: Tramo ${entry.tramo}</title></circle>`).join(''); return `<div class="line-chart-wrap"><svg class="tariff-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Tramos ${shiftName} por día del mes"><line class="chart-axis" x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}"/><line class="chart-axis" x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}"/>${lines}<polyline class="chart-line chart-line-${shiftName.toLowerCase()}" points="${points}"/>${dots}${dayLabels}</svg><div class="line-chart-caption"><span>Días del mes</span><strong>${entries.length ? `${entries.length} registro(s)` : 'Sin registros este mes'}</strong></div></div>`; }
function startShiftTimer() {
  window.clearInterval(shiftTimerInterval);
  const timer = document.querySelector('[data-shift-timer]');
  if (!timer) return;
  if (workflowStage() !== 'in_process' || !state.shift.horaInicio) { timer.textContent = '00:00:00'; return; }
  const update = () => { timer.textContent = formatElapsedTime(state.shift.horaInicio); };
  update();
  shiftTimerInterval = window.setInterval(update, 1000);
}
function decimalText(value, fallback = '') { const extended = value?.$numberDecimal; const raw = value?.value; const nested = raw?.value; return extended ?? nested ?? raw ?? value ?? fallback; }
function renderTariffRows() { const bands = catalogs.tariffBands || []; const targetWeight = Number(state.shift.targetWeight || 0); return bands.length ? bands.map((band) => { const minGiveaway = Number(decimalText(band.giveawayMin, 0)); const maxValue = band.giveawayMax ? Number(decimalText(band.giveawayMax, 0)) : null; const minKg = targetWeight * (1 + minGiveaway / 100); const maxKg = maxValue === null ? null : targetWeight * (1 + maxValue / 100); const kilos = maxKg === null ? `Desde ${formatNumber(Math.ceil(minKg))} kg` : `${formatNumber(Math.ceil(minKg))}–${formatNumber(Math.ceil(maxKg))} kg`; return `<tr><td>${band.tramo}</td><td>${kilos}</td><td>${formatCurrencyCLP(decimalText(band.tarifa, 0))}</td></tr>`; }).join('') : '<tr><td colspan="3" class="muted">No hay tramos configurados.</td></tr>'; }
function normalizeApiValue(value) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace('ñ', 'n'); }
function isMongoObjectId(value) { return /^[a-f\d]{24}$/i.test(String(value || '')); }
function formatOperatorCardId(value) {
  const text = String(value || '');
  if (isMongoObjectId(text)) return `ID-${text.slice(-6).toUpperCase()}`;
  return text;
}
function operatorLine(operator) {
  if (operator.status === 'break' || operator.status === 'inactive') return operator.station === 'Baño' ? 'bano' : 'colacion';
  if (operator.workLine === 'permissions') return 'colacion';
  if (operator.workLine) return operator.workLine;
  return { 'OP-014': 'mesa', 'OP-021': 'maquinas' }[operator.id] || 'unassigned';
}
function workflowStage() {
  return deriveWorkflowStageFromShift(state.shift);
}
function workflowLabel(stage) {
  return { assigned: 'Turno asignado', in_process: 'En proceso', completed: 'Proceso terminado' }[stage];
}
function performance() { return calculatePerformance(state.shift.actualWeight, state.shift.targetWeight); }
function performanceMessage(result) {
  if (result.tone === 'optimal') return 'El turno está dentro de los parámetros operativos';
  if (result.tone === 'acceptable') return 'El turno presenta una desviación moderada';
  return 'El turno requiere atención operativa';
}
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.setTimeout(() => toast.classList.remove('show'), 2800);
}
function icon(name) { return { chart: '↗', pause: '◷', stop: '◼', people: '◎' }[name] ?? '•'; }
function footerMarkup() { return '<footer class="app-footer"><span>SGSP Industrial</span><span>Sistema de Gestión de Planta · 2026</span></footer>'; }
async function renderLogin() {
  try {
    const template = await loadViewTemplate('Views/login.html');
    app.innerHTML = `<main class="login-page">${template}${footerMarkup()}</main>`;
  } catch (error) {
    console.warn(error.message);
    app.innerHTML = `<main class="login-page"><section class="login-panel"><h1>Iniciar sesión</h1><form id="loginForm"><label for="username">Usuario</label><input id="username" required><label for="password">Contraseña</label><input id="password" type="password" required><button type="submit">Iniciar sesión</button><div id="loginError" role="alert"></div></form></section>${footerMarkup()}</main>`;
  }
  document.querySelector('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.querySelector('#username').value.trim();
    const password = document.querySelector('#password').value;
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const response = await loginApi(username, password);
      const user = response.data.user;
      session = { ...user, name: user.username, roleLabel: user.role, role: normalizeRole(user.role), token: response.data.token };
      saveSession();
      render();
      await hydrateFromApi();
      await hydrateCatalogs();
    } catch (error) {
      if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) {
        document.querySelector('#loginError').textContent = error.message || 'El servicio no está disponible.';
        button.disabled = false;
        return;
      }
      const demoUser = authenticate(username, password);
      if (!demoUser && error.status) { document.querySelector('#loginError').textContent = error.message; button.disabled = false; return; }
      if (!demoUser) { document.querySelector('#loginError').textContent = 'No fue posible iniciar sesión con esas credenciales.'; button.disabled = false; return; }
      session = demoUser;
      saveSession();
      showToast('Sesión local iniciada.');
    }
    render();
    button.disabled = false;
  });
}
async function renderAdminDashboard() {
  try {
    const template = await loadViewTemplate('Views/admin/dashboard.html');
    app.innerHTML = template;
    app.querySelector('.admin-shell')?.insertAdjacentHTML('beforeend', footerMarkup());
    app.querySelectorAll('.admin-module-card:nth-child(n+4)').forEach((card) => card.remove());
    app.querySelector('[data-admin-user]').textContent = `${session.name} · Administrador`;
    app.insertAdjacentHTML('beforeend', modalMarkup());
    bindNativeModal();
    app.querySelector('[data-action="logout"]').addEventListener('click', logout);
    app.querySelectorAll('[data-admin]').forEach((button) => button.addEventListener('click', () => openModal(button.dataset.admin)));
    app.querySelector('#actionForm').addEventListener('submit', handleSubmit);
    return;
  } catch (error) {
    console.warn(error.message);
    app.innerHTML = '<main class="page-container"><section class="panel panel-padded"><h1>Administración no disponible</h1><p class="muted">No se pudo cargar la vista administrativa.</p></section></main>';
    return;
  }
  app.innerHTML = `<div class="app-shell"><header class="topbar"><div class="container-fluid px-3 px-lg-5"><div class="d-flex align-items-center justify-content-between gap-3"><div class="brand"><span class="brand-mark">S</span>SGSP <span class="d-none d-sm-inline header-meta">/ Administración</span></div><div class="header-meta"><span class="pulse"></span>${session.name} · Administrador <button class="logout-button" data-action="logout">Salir</button></div></div></div></header><main class="container-fluid px-3 px-lg-5"><section class="mb-4"><div class="eyebrow">Centro de control global</div><h1>Vista ejecutiva.</h1><p class="lede">Supervisa la operación, parametriza el sistema y conserva la trazabilidad de cada turno.</p></section><section class="row g-3 mb-4"><div class="col-6 col-xl-3"><div class="panel metric"><span class="metric-label">Salas activas</span><strong class="metric-value">02</strong><span class="text-muted small">Andes Asia · Nippon</span></div></div><div class="col-6 col-xl-3"><div class="panel metric"><span class="metric-label">Personas en turno</span><strong class="metric-value">${activeOperators}<small> activas</small></strong><span class="text-muted small">Dotación sincronizada</span></div></div><div class="col-6 col-xl-3"><div class="panel metric"><span class="metric-label">Giveaway global</span><strong class="metric-value">${result.giveaway.toFixed(2)}<small>%</small></strong><span class="status-pill status-${result.tone}">Tramo ${result.tier}</span></div></div><div class="col-6 col-xl-3"><div class="panel metric"><span class="metric-label">Auditoría</span><strong class="metric-value">100<small>%</small></strong><span class="text-muted small">Registros íntegros hoy</span></div></div></section><section class="row g-4 mb-4"><div class="col-xl-7"><div class="section-heading"><h2>Rendimiento por línea</h2><span class="text-muted small">Turno actual</span></div><div class="panel table-wrap"><table class="table align-middle"><thead><tr><th>Línea</th><th>Producto</th><th>Avance</th><th>Estado</th></tr></thead><tbody><tr><td><strong>Andes Asia</strong></td><td>${state.shift.product}</td><td>72%</td><td><span class="status-pill status-critical">Atención</span></td></tr><tr><td><strong>Nippon</strong></td><td>Por programar</td><td>—</td><td><span class="status-pill status-acceptable">Pendiente</span></td></tr></tbody></table></div></div><div class="col-xl-5"><div class="section-heading"><h2>Accesos rápidos</h2><span class="text-muted small">Configuración global</span></div><div class="admin-action-grid"><button class="admin-action" data-admin="users"><strong>Usuarios y roles</strong><span>4 perfiles configurados</span></button><button class="admin-action" data-admin="parameters"><strong>Parámetros</strong><span>10 tramos de Giveaway</span></button><button class="admin-action" data-admin="audit"><strong>Auditoría</strong><span>Último evento hace 2 min</span></button><button class="admin-action" data-admin="reports"><strong>Reportes</strong><span>Exportar consolidado</span></button></div></div></section><section><div class="section-heading"><h2>Actividad reciente</h2><span class="text-muted small">Registro inmutable</span></div><div class="panel table-wrap"><table class="table align-middle"><thead><tr><th>Hora</th><th>Evento</th><th>Responsable</th><th>Resultado</th></tr></thead><tbody><tr><td>09:12</td><td>Cálculo de rendimiento</td><td>Sistema</td><td><span class="status-pill status-optimal">Registrado</span></td></tr><tr><td>08:42</td><td>Detención de línea</td><td>Tomás Vidal</td><td><span class="status-pill status-optimal">Registrado</span></td></tr><tr><td>06:00</td><td>Apertura de turno</td><td>Daniela Fuentes</td><td><span class="status-pill status-optimal">Registrado</span></td></tr></tbody></table></div></section></main></div>${modalMarkup()}`;
  const assignmentAction = document.createElement('button');
  assignmentAction.className = 'admin-action';
  assignmentAction.dataset.admin = 'assign-shift';
  assignmentAction.innerHTML = '<strong>Asignar turno</strong><span>Asignar a Jefe de línea</span>';
  document.querySelector('.admin-action-grid')?.prepend(assignmentAction);
  document.querySelector('[data-action="logout"]').addEventListener('click', logout);
  document.querySelectorAll('[data-admin]').forEach((button) => button.addEventListener('click', () => openModal(button.dataset.admin)));
  document.querySelector('#actionForm').addEventListener('submit', handleSubmit);
}
async function render() {
  if (!session) { await renderLogin(); return; }
  if (session.role === 'admin') { await renderAdminDashboard(); return; }
  if (session.token && can(session, 'manage_shift') && !catalogs.lines.length) await hydrateCatalogs();
  const result = performance();
  const showShiftActions = can(session, 'manage_shift');
  const canOperate = state.shift?.canOperate !== false;
  const showPeople = canOperate && can(session, 'manage_people');
  const showDowntime = canOperate && can(session, 'register_downtime');
  const showClose = canOperate && can(session, 'close_shift');
  const stage = workflowStage();
  const inProcess = stage === 'in_process';
  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar"><div class="page-container"><div class="topbar-content">
        <div class="brand"><img class="brand-logo" src="Views/Src/logo.png" alt="SGSP"><span class="d-none d-sm-inline header-meta">/ Sala de control</span></div>
        <div class="header-meta user-actions"><span class="pulse"></span><span>${session.name} · ${session.roleLabel}</span><button class="logout-button" data-action="logout">Salir</button></div>
      </div></div></header>
      <div class="workspace-body"><aside class="workspace-sidebar"><div><nav class="workspace-nav" aria-label="Navegación de operación"><button class="workspace-nav-item" data-view="dashboard">Dashboard</button><button class="workspace-nav-item" data-view="start">Apertura de turno</button><button class="workspace-nav-item" data-view="downtime">Tiempos muertos</button><button class="workspace-nav-item" data-view="people">Gestión Personal</button><button class="workspace-nav-item" data-view="close">Cierre de Turno</button></nav></div><div class="workspace-footer">Planta SGSP<br><span>Jefe de línea</span></div></aside><main class="container-fluid px-3 px-lg-5">
        <section class="mb-4" data-dashboard-chrome><div class="row align-items-end g-3"><div class="col-lg-8"><h1>Buenos días, ${session.name.split(' ')[0]}.</h1><p class="lede">Control operativo del turno iniciado a las ${state.shift.startedAt}. Todo lo importante, a la vista.</p></div><div class="col-lg-4 text-lg-end">${session.role === 'admin' ? '<button class="btn btn-outline-secondary" data-action="reset">Restablecer datos</button>' : ''}</div></div></section>
        <section class="dashboard-tranches mb-4" data-dashboard-chrome aria-label="Tramos persistentes por turno"><button class="tranche-slider-arrow tranche-slider-prev" type="button" data-tranche-prev aria-label="Gráfico anterior">◄</button><div class="tranche-slider-viewport"><div class="tranche-slider-track" data-tranche-track><article class="panel tariff-chart-card"><div class="section-heading"><div><span class="metric-label">Tramos T1</span><h2>Renta variable</h2></div><span class="shift-chart-badge shift-t1">T1</span></div>${renderTariffChart('T1')}</article><article class="panel tariff-chart-card"><div class="section-heading"><div><span class="metric-label">Tramos T2</span><h2>Renta variable</h2></div><span class="shift-chart-badge shift-t2">T2</span></div>${renderTariffChart('T2')}</article></div></div><button class="tranche-slider-arrow tranche-slider-next" type="button" data-tranche-next aria-label="Gráfico siguiente">►</button></section>
        <section class="workflow-steps mb-4" aria-label="Flujo diario"><div class="workflow-step ${stage === 'assigned' ? 'current' : 'done'}"><span>1</span><strong>Turno asignado</strong><small>Administrador</small></div><div class="workflow-line"></div><div class="workflow-step ${stage === 'in_process' ? 'current' : stage === 'completed' ? 'done' : ''}"><span>2</span><strong>En proceso</strong><small>Operación diaria</small></div><div class="workflow-line"></div><div class="workflow-step ${stage === 'completed' ? 'current' : ''}"><span>3</span><strong>Proceso terminado</strong><small>Guardar día</small></div></section>
        <section class="panel alert-strip mb-4"><div class="alert-status"><span class="shift-timer-label">Tiempo transcurrido</span><strong class="shift-timer" data-shift-timer>00:00:00</strong></div></section>
        <section class="dashboard-section process-start-section"><div class="section-heading"><h2>Iniciar proceso</h2><span class="text-muted small">Turno asignado</span></div><div class="section-panel">${stage === 'assigned' && showShiftActions ? '<button class="action-button action-primary" data-action="start-process"><span class="icon">' + icon('chart') + '</span><span>Iniciar proceso</span></button>' : '<span class="section-status">' + (stage === 'completed' ? 'Proceso ya terminado' : 'Proceso en curso') + '</span>'}</div></section>
        <section class="dashboard-section"><div class="section-heading"><h2>En proceso</h2><span class="text-muted small">Acciones operativas</span></div><div class="section-panel action-grid">${inProcess && showDowntime ? '<button class="action-button action-warm" data-action="downtime"><span class="icon">' + icon('stop') + '</span><span>Reportar detención</span></button>' : '<span class="section-status">Las acciones se habilitan al iniciar el proceso.</span>'}</div><div class="panel table-wrap mt-3"><table class="table align-middle"><thead><tr><th>Hora</th><th>Motivo</th><th>Categoría</th><th>Duración</th><th>Acción</th></tr></thead><tbody>${state.downtime.map((event) => `<tr><td>${event.time}</td><td>${event.reason}</td><td>${event.category}</td><td><strong>${event.duration}</strong></td><td>${!event.fin ? `<button class="btn btn-sm btn-outline-danger" data-downtime-end="${event.id || ''}">Finalizar detención</button>` : '<span class="text-muted small">Finalizada</span>'}</td></tr>`).join('')}</tbody></table></div></section>
        <section class="dashboard-section"><div class="section-heading"><h2>Gestionar gente</h2><span class="text-muted small">Rotación y dotación</span></div><div class="rotation-toolbar">${inProcess && showPeople ? '<button class="btn btn-sm btn-outline-secondary" data-action="rotate">Rotar puestos A → B → C</button><button class="btn btn-sm btn-colacion" data-action="rotate-colacion" data-colacion-group="1" type="button">Colación G1</button><button class="btn btn-sm btn-colacion" data-action="rotate-colacion" data-colacion-group="2" type="button">Colación G2</button><button class="btn btn-sm btn-outline-secondary" data-action="edit-groups">Editar grupos</button><button class="btn btn-sm btn-outline-secondary" data-action="edit-colacion-groups">Editar Grupos de colación</button>' : ''}${inProcess ? '<button class="btn btn-sm btn-outline-secondary" data-action="return-all">Retorno general</button>' : ''}<button class="btn btn-sm btn-outline-secondary" data-action="rotations">Historial</button></div><div class="work-lines-board">${workLines.map(renderWorkLine).join('')}</div></section>
        <section class="dashboard-section"><div class="section-heading"><h2>Proceso terminado</h2><span class="text-muted small">Guardar día</span></div><div class="section-panel closure-panel"><div class="d-flex justify-content-between mb-3"><span class="text-muted">Peso objetivo</span><strong>${formatNumber(state.shift.targetWeight)} kg</strong></div><div class="d-flex justify-content-between mb-3"><span class="text-muted">Peso procesado</span><strong>${formatNumber(state.shift.actualWeight)} kg</strong></div><div class="d-flex justify-content-between pt-3 border-top"><span class="text-muted">Incentivo estimado</span><strong class="text-teal">$${formatNumber(result.factor)}</strong></div>${showClose && inProcess ? '<button class="btn btn-sgsp w-100 mt-3" data-action="close">Terminar proceso y guardar día</button>' : `<p class="text-muted small mt-3 mb-0">${stage === 'assigned' ? 'Inicia el proceso para habilitar el cierre.' : 'El cierre queda registrado después de guardar el día.'}</p>`}</div></section>
      </main></div>
      ${footerMarkup()}
    </div>${modalMarkup()}`;
  await hydratePhysicalViews();
  bindNativeModal();
  bindEvents();
  startShiftTimer();
}
function renderColumn(status) {
  const operators = state.operators.filter((operator) => operator.status === status);
  return `<div class="kanban-column" data-status="${status}" tabindex="0" aria-label="${statusLabels[status]}. Suelta aquí una tarjeta o selecciónala para moverla"><div class="column-head"><span>${statusLabels[status]}</span><span class="column-count">${operators.length}</span></div>${operators.length ? operators.map(renderOperator).join('') : '<div class="empty-column">Suelta una tarjeta aquí</div>'}</div>`;
}
function renderWorkLine(line) {
  const operators = state.operators.filter((operator) => operatorLine(operator) === line.id);
  const count = line.capacity ? `${operators.length} / ${line.capacity}` : operators.length;
  return `<div class="work-line-column" data-work-line="${line.id}" tabindex="0" aria-label="${line.label}. Suelta aquí una tarjeta para rotarla"><div class="work-line-header"><span>${line.label}</span><span class="column-count">${count}</span></div><div class="work-line-body">${operators.length ? operators.map(renderOperator).join('') : '<div class="empty-column">Suelta una tarjeta aquí</div>'}</div></div>`;
}
function renderOperator(operator) {
  const elapsed = operator.breakStarted ? Math.max(1, Math.round((Date.now() - operator.breakStarted) / 60000)) : null;
  const warning = elapsed && elapsed > 10 ? ' status-critical' : '';
  const selected = selectedOperatorId === operator.id ? ' is-selected' : '';
  const group = operator.grupoRotacion ? `<span class="tag-group">G${operator.grupoRotacion}</span>` : '';
  const positionGroup = operator.grupoPuesto ? `<span class="tag-position position-${operator.grupoPuesto.toLowerCase()}">${operator.grupoPuesto}</span>` : '';
  const breakActions = operator.status === 'break' ? `<button type="button" class="btn-mini btn-finish-break" data-break-end="${operator.breakId || ''}" data-break-operator="${operator.id}" aria-label="Finalizar pausa de ${operator.name}" title="Finalizar pausa">✓</button>` : `<button type="button" class="btn-mini btn-start-break btn-mini-bano" data-break-type="bano" data-break-operator="${operator.id}" aria-label="Enviar a Baño a ${operator.name}" title="Baño">⌛</button><button type="button" class="btn-mini btn-start-break btn-mini-colacion" data-break-type="colacion" data-break-operator="${operator.id}" aria-label="Enviar a Colación a ${operator.name}" title="Colación">🍽</button>`;
  return `<div class="operator-card${selected} status-${operator.status}" tabindex="0" draggable="true" data-operator="${operator.id}" aria-label="${operator.name}, ${statusLabels[operator.status]}. Arrastra para cambiar de estado"><div class="operator-card-top"><span class="drag-handle" aria-hidden="true">⠿</span><div class="operator-identity"><span class="operator-name">${operator.name}</span><span class="operator-role">${operator.role || 'Operador'}</span></div><span class="operator-id" title="${operator.id}">${formatOperatorCardId(operator.id)}</span></div><div class="operator-tags">${group}${positionGroup}<span class="status-pill${warning}">${statusLabels[operator.status]}</span></div><div class="operator-meta"><span>${operator.station}</span><span>${elapsed ? `${elapsed} min` : operator.productivity}</span></div><div class="operator-actions">${breakActions}</div><div class="operator-hint">Arrastrar para rotar</div></div>`;
}
function renderDowntimeRows() {
  return state.downtime.map((event) => `<tr><td>${event.time}</td><td>${event.reason}</td><td>${event.category}</td><td><strong>${event.duration}</strong></td><td class="downtime-actions">${!event.fin ? `<button class="btn btn-sm btn-outline-danger" data-downtime-end="${event.id || ''}">Finalizar detención</button>` : '<span class="text-muted small">Finalizada</span>'}<button class="btn btn-sm btn-outline-danger" data-downtime-delete="${event.id || ''}">Borrar</button></td></tr>`).join('');
}
function renderTramoRowsByShift(shift) {
  const rows = state.giveawayHistory.filter((entry) => entry.shift === shift);
  if (!rows.length) return '<tr><td colspan="3" class="muted">Todavía no hay días trabajados registrados.</td></tr>';
  return rows.map((entry) => `<tr><td>${entry.date}</td><td><strong>${formatCurrencyCLP(entry.amount)}</strong></td><td>${entry.giveaway.toFixed(2)}%</td></tr>`).join('');
}
function configureModalActionButton({ hidden = false, label = 'Guardar' } = {}) {
  const actionButton = document.querySelector('#actionForm > .native-modal-footer .native-button-primary');
  if (!actionButton) return;
  actionButton.textContent = label;
  actionButton.classList.toggle('hidden', hidden);
}
async function closeMonthlyIncentive(turno) {
  if (!session?.token) { showToast('Debes iniciar sesión para cerrar el incentivo mensual.'); return; }
  const lineId = state.shift.lineaId || state.shift.lineId;
  if (!lineId) { showToast('No hay una línea activa para cerrar el incentivo mensual.'); return; }
  try {
    const result = await closeMonthlyIncentiveApi(lineId, turno);
    await hydrateFromApi();
    render();
    showToast(result.message || 'El incentivo mensual quedó cerrado.');
  } catch (error) { showToast(error.message); }
}
function openMonthlyCloseConfirmation() { const modal = document.querySelector('#monthlyCloseModal'); if (modal && !modal.open) modal.showModal(); }
function closeMonthlyCloseConfirmation() { document.querySelector('#monthlyCloseModal')?.close(); }
function modalMarkup() { return `<dialog class="native-modal" id="actionModal" aria-labelledby="modalTitle"><div class="native-modal-panel"><header class="native-modal-header"><h2 class="native-modal-title" id="modalTitle">Acción</h2><button type="button" class="native-modal-close" data-modal-close aria-label="Cerrar">×</button></header><form id="actionForm"><div class="native-modal-body" id="modalBody"></div><footer class="native-modal-footer"><button type="button" class="native-button native-button-light" data-modal-close>Cancelar</button><button class="native-button native-button-primary" type="submit">Guardar</button></footer></form></div></dialog><dialog class="native-modal personnel-form-modal" id="personnelFormModal" aria-labelledby="personnelFormTitle"><div class="native-modal-panel"><header class="native-modal-header"><h2 class="native-modal-title" id="personnelFormTitle">Agregar personal</h2><button type="button" class="native-modal-close" data-personnel-form-close aria-label="Cerrar">×</button></header><form id="personnelForm"><div class="native-modal-body" id="personnelFormBody"></div><footer class="native-modal-footer"><button type="button" class="native-button native-button-light" data-personnel-form-close>Cancelar</button><button class="native-button native-button-primary" type="submit">Guardar</button></footer></form></div></dialog><dialog class="native-modal personnel-form-modal" id="orderFormModal" aria-labelledby="orderFormTitle"><div class="native-modal-panel"><header class="native-modal-header"><h2 class="native-modal-title" id="orderFormTitle">Nuevo pedido</h2><button type="button" class="native-modal-close" data-order-form-close aria-label="Cerrar">×</button></header><form id="orderForm"><div class="native-modal-body" id="orderFormBody"></div><footer class="native-modal-footer"><button type="button" class="native-button native-button-light" data-order-form-close>Cancelar</button><button class="native-button native-button-primary" type="submit">Guardar</button></footer></form></div></dialog><dialog class="native-modal personnel-form-modal" id="monthlyCloseModal" aria-labelledby="monthlyCloseTitle"><div class="native-modal-panel"><header class="native-modal-header"><h2 class="native-modal-title" id="monthlyCloseTitle">Cerrar incentivo mensual</h2><button type="button" class="native-modal-close" data-monthly-close-cancel aria-label="Cerrar">×</button></header><form id="monthlyCloseForm"><div class="native-modal-body"><p class="muted small-text">Selecciona el turno cuyo acumulado deseas cerrar.</p><label class="field-label" for="monthlyCloseShift">Turno</label><select class="field-select" id="monthlyCloseShift"><option value="T1">T1</option><option value="T2">T2</option></select></div><footer class="native-modal-footer"><button type="button" class="native-button native-button-light" data-monthly-close-cancel>Cancelar</button><button class="native-button native-button-primary" type="submit">Confirmar cierre</button></footer></form></div></dialog>`; }
function showNativeModal() {
  const modal = document.querySelector('#actionModal');
  if (!modal) return;
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');
}
function closeNativeModal() {
  const modal = document.querySelector('#actionModal');
  if (!modal) return;
  if (typeof modal.close === 'function') modal.close();
  else modal.removeAttribute('open');
}
function bindNativeModal() {
  const modal = document.querySelector('#actionModal');
  if (!modal) return;
  modal.querySelectorAll('[data-modal-close]').forEach((button) => button.addEventListener('click', closeNativeModal));
  const personnelModal = document.querySelector('#personnelFormModal');
  personnelModal?.querySelectorAll('[data-personnel-form-close]').forEach((button) => button.addEventListener('click', closePersonnelFormModal));
  const orderModal = document.querySelector('#orderFormModal');
  orderModal?.querySelectorAll('[data-order-form-close]').forEach((button) => button.addEventListener('click', closeOrderFormModal));
  const monthlyModal = document.querySelector('#monthlyCloseModal');
  monthlyModal?.querySelectorAll('[data-monthly-close-cancel]').forEach((button) => button.addEventListener('click', closeMonthlyCloseConfirmation));
  document.querySelector('#monthlyCloseForm')?.addEventListener('submit', async (event) => { event.preventDefault(); const turno = document.querySelector('#monthlyCloseShift').value; closeMonthlyCloseConfirmation(); await closeMonthlyIncentive(turno); });
}
function showPersonnelFormModal() { document.querySelector('#personnelFormModal')?.showModal(); }
function closePersonnelFormModal() { document.querySelector('#personnelFormModal')?.close(); }
async function returnToPersonnelManagement() {
  closePersonnelFormModal();
  const managementModal = document.querySelector('#actionModal');
  if (managementModal?.open) closeNativeModal();
  openModal('personnel');
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await loadPersonnel();
  document.querySelector('#personnelTable')?.focus();
}
function showOrderFormModal() { document.querySelector('#orderFormModal')?.showModal(); }
function closeOrderFormModal() { document.querySelector('#orderFormModal')?.close(); }
function openModal(type, lineId = null, lineName = null) {
  configureModalActionButton({ hidden: false, label: 'Guardar' });
  document.querySelector('#actionModal')?.classList.remove('native-modal-wide');
  if (type === 'personnel') {
    document.querySelector('#modalTitle').textContent = 'Administración de personal';
    document.querySelector('#modalBody').innerHTML = '<div class="personnel-management-toolbar"><p class="muted small-text no-margin">Trabajadores registrados y disponibilidad.</p><button type="button" class="native-button native-button-primary" data-add-personnel>+ Agregar Personal</button></div><div id="personnelTable" class="table-wrap"><p class="muted small-text">Cargando personal desde la base local...</p></div>';
    document.querySelector('#actionForm').dataset.type = 'personnel';
    configureModalActionButton({ hidden: true, label: 'Guardar' });
    showNativeModal();
    document.querySelector('[data-add-personnel]').addEventListener('click', () => openPersonnelForm());
    loadPersonnel();
    return;
  }
  if (type === 'orders') {
    document.querySelector('#modalTitle').textContent = 'Administrar pedidos';
    document.querySelector('#modalBody').innerHTML = '<div class="personnel-management-toolbar"><p class="muted small-text no-margin">Pedidos disponibles para la operación.</p><button type="button" class="native-button native-button-primary" data-add-order>+ Nuevo Pedido</button></div><div id="ordersTable" class="table-wrap spaced-top"><p class="muted small-text">Cargando pedidos...</p></div>';
    document.querySelector('#actionForm').dataset.type = 'orders';
    configureModalActionButton({ hidden: true });
    showNativeModal();
    document.querySelector('[data-add-order]').addEventListener('click', () => openOrderForm());
    loadOrders();
    return;
  }
  if (type === 'certificates') {
    document.querySelector('#modalTitle').textContent = 'Certificados de máquinas';
    document.querySelector('#modalBody').innerHTML = '<p class="text-muted small">Marca los permisos de operación para Romana y Rayos X y guarda los cambios por fila.</p><div id="certificatesTable" class="table-wrap"><p class="text-muted small">Cargando trabajadores...</p></div>';
    document.querySelector('#actionForm').dataset.type = 'certificates';
    configureModalActionButton({ hidden: true });
    document.querySelector('#actionModal').classList.add('native-modal-wide');
    showNativeModal();
    loadMachineCertificates();
    return;
  }
  if (type === 'edit-groups') {
    document.querySelector('#modalTitle').textContent = 'Editar grupos de rotación';
    document.querySelector('#modalBody').innerHTML = `<p class="text-muted small">G1/G2 son grupos de personas. Arrastra cada tarjeta a A, B o C para organizar los puestos de trabajo.</p><div class="rotation-editor-board">${['A', 'B', 'C'].map((group) => `<div class="rotation-editor-zone position-zone-${group.toLowerCase()}" data-editor-position="${group}"><div class="rotation-editor-zone-title">Grupo ${group}<span>${state.operators.filter((operator) => (operator.grupoPuesto || 'A') === group).length}</span></div><div class="rotation-editor-zone-body">${state.operators.filter((operator) => (operator.grupoPuesto || 'A') === group).map((operator) => `<div class="rotation-editor-card position-card-${group.toLowerCase()}" draggable="true" data-group-editor-operator="${operator.id}" data-position-group="${group}"><strong>${operator.name}</strong><span>G${operator.grupoRotacion || 1} · ${operator.station}</span></div>`).join('') || '<div class="empty-column">Suelta aquí</div>'}</div></div>`).join('')}</div>`;
    document.querySelectorAll('[data-group-editor-operator]').forEach((card) => card.addEventListener('dragstart', (event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', card.dataset.groupEditorOperator); }));
    document.querySelectorAll('[data-group-editor-operator]').forEach((card) => card.addEventListener('click', () => { if (selectedGroupEditorId && selectedGroupEditorId !== card.dataset.groupEditorOperator) { const selected = document.querySelector(`[data-group-editor-operator="${selectedGroupEditorId}"]`); const targetZone = card.closest('[data-editor-position]'); if (selected && targetZone) { const position = targetZone.dataset.editorPosition.toLowerCase(); targetZone.querySelector('.rotation-editor-zone-body').appendChild(selected); selected.dataset.positionGroup = targetZone.dataset.editorPosition; selected.classList.remove('position-card-a', 'position-card-b', 'position-card-c', 'is-selected'); selected.classList.add(`position-card-${position}`); selectedGroupEditorId = null; return; } } selectedGroupEditorId = card.dataset.groupEditorOperator; }));
    document.querySelectorAll('[data-editor-position]').forEach((zone) => {
      zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('is-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
      zone.addEventListener('drop', (event) => { event.preventDefault(); zone.classList.remove('is-over'); const card = document.querySelector(`[data-group-editor-operator="${event.dataTransfer.getData('text/plain')}"]`); if (card) { const position = zone.dataset.editorPosition.toLowerCase(); zone.querySelector('.rotation-editor-zone-body').appendChild(card); card.dataset.positionGroup = zone.dataset.editorPosition; card.classList.remove('position-card-a', 'position-card-b', 'position-card-c', 'is-selected'); card.classList.add(`position-card-${position}`); selectedGroupEditorId = null; } });
      zone.addEventListener('click', (event) => { if (!selectedGroupEditorId || event.target.closest('[data-group-editor-operator]')) return; const card = document.querySelector(`[data-group-editor-operator="${selectedGroupEditorId}"]`); if (card) { const position = zone.dataset.editorPosition.toLowerCase(); zone.querySelector('.rotation-editor-zone-body').appendChild(card); card.dataset.positionGroup = zone.dataset.editorPosition; card.classList.remove('position-card-a', 'position-card-b', 'position-card-c', 'is-selected'); card.classList.add(`position-card-${position}`); selectedGroupEditorId = null; } });
    });
    document.querySelector('#actionForm').dataset.type = 'edit-groups';
    showNativeModal();
    return;
  }
  if (type === 'edit-colacion-groups') {
    selectedColacionEditorId = null;
    document.querySelector('#modalTitle').textContent = 'Editar grupos de colación';
    document.querySelector('#modalBody').innerHTML = `<p class="text-muted small">Arrastra cada tarjeta a G1 o G2 para reorganizar los turnos de colación.</p><div class="rotation-editor-board colacion-editor-board">${[1, 2].map((group) => `<div class="rotation-editor-zone colacion-zone-g${group}" data-colacion-zone="${group}"><div class="rotation-editor-zone-title">Grupo G${group}<span>${state.operators.filter((operator) => Number(operator.grupoRotacion || 1) === group).length}</span></div><div class="rotation-editor-zone-body">${state.operators.filter((operator) => Number(operator.grupoRotacion || 1) === group).map((operator) => `<div class="rotation-editor-card colacion-card-g${group}" draggable="true" data-colacion-editor-operator="${operator.id}" data-colacion-group="${group}"><strong>${operator.name}</strong><span>Puesto ${operator.grupoPuesto || 'A'} · ${operator.station}</span></div>`).join('') || '<div class="empty-column">Suelta aquí</div>'}</div></div>`).join('')}</div>`;
    document.querySelectorAll('[data-colacion-editor-operator]').forEach((card) => card.addEventListener('dragstart', (event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', card.dataset.colacionEditorOperator); }));
    document.querySelectorAll('[data-colacion-editor-operator]').forEach((card) => card.addEventListener('pointerdown', () => { selectedColacionEditorId = card.dataset.colacionEditorOperator; }));
    document.querySelectorAll('[data-colacion-editor-operator]').forEach((card) => card.addEventListener('click', () => { if (selectedColacionEditorId && selectedColacionEditorId !== card.dataset.colacionEditorOperator) { const selected = document.querySelector(`[data-colacion-editor-operator="${selectedColacionEditorId}"]`); const targetZone = card.closest('[data-colacion-zone]'); if (selected && targetZone) { const group = targetZone.dataset.colacionZone; targetZone.querySelector('.rotation-editor-zone-body').appendChild(selected); selected.dataset.colacionGroup = group; selected.classList.remove('colacion-card-g1', 'colacion-card-g2', 'is-selected'); selected.classList.add(`colacion-card-g${group}`); selectedColacionEditorId = null; return; } } selectedColacionEditorId = card.dataset.colacionEditorOperator; }));
    document.querySelectorAll('[data-colacion-zone]').forEach((zone) => {
      zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('is-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
      zone.addEventListener('pointerup', (event) => { if (!selectedColacionEditorId || event.target.closest('[data-colacion-editor-operator]')) return; const card = document.querySelector(`[data-colacion-editor-operator="${selectedColacionEditorId}"]`); if (card) { const group = zone.dataset.colacionZone; zone.querySelector('.rotation-editor-zone-body').appendChild(card); card.dataset.colacionGroup = group; card.classList.remove('colacion-card-g1', 'colacion-card-g2', 'is-selected'); card.classList.add(`colacion-card-g${group}`); selectedColacionEditorId = null; } });
      zone.addEventListener('drop', (event) => { event.preventDefault(); zone.classList.remove('is-over'); const card = document.querySelector(`[data-colacion-editor-operator="${event.dataTransfer.getData('text/plain')}"]`); if (card) { const group = zone.dataset.colacionZone; zone.querySelector('.rotation-editor-zone-body').appendChild(card); card.dataset.colacionGroup = group; card.classList.remove('colacion-card-g1', 'colacion-card-g2', 'is-selected'); card.classList.add(`colacion-card-g${group}`); selectedColacionEditorId = null; } });
      zone.addEventListener('click', (event) => { if (!selectedColacionEditorId || event.target.closest('[data-colacion-editor-operator]')) return; const card = document.querySelector(`[data-colacion-editor-operator="${selectedColacionEditorId}"]`); if (card) { const group = zone.dataset.colacionZone; zone.querySelector('.rotation-editor-zone-body').appendChild(card); card.dataset.colacionGroup = group; card.classList.remove('colacion-card-g1', 'colacion-card-g2', 'is-selected'); card.classList.add(`colacion-card-g${group}`); selectedColacionEditorId = null; } });
    });
    document.querySelector('#actionForm').dataset.type = 'edit-colacion-groups';
    showNativeModal();
    return;
  }
  const content = { break: ['Registrar pausa', `<label class="form-label" for="operator">Operador</label><select class="form-select mb-3" id="operator" required>${state.operators.filter((operator) => operator.status === 'assigned').map((operator) => `<option value="${operator.id}">${operator.name} · ${operator.station}</option>`).join('')}</select><label class="form-label" for="breakType">Tipo de pausa</label><select class="form-select" id="breakType"><option>Baño</option><option>Colación</option><option>Permiso</option></select>`], downtime: ['Reportar detención', `<label class="form-label" for="reason">Motivo</label><input class="form-control mb-3" id="reason" required placeholder="Ej. Ajuste de selladora"><label class="form-label" for="duration">Duración (minutos)</label><input class="form-control mb-3" id="duration" type="number" min="1" required><label class="form-label" for="category">Categoría</label><select class="form-select" id="category"><option>Mecánica</option><option>Calidad</option><option>Abastecimiento</option><option>Seguridad</option></select>`], 'start-shift': ['Configurar turno', `<label class="form-label" for="line">Línea</label><select class="form-select mb-3" id="line"><option>Andes Asia</option><option>Nippon</option></select><label class="form-label" for="product">Producto</label><input class="form-control" id="product" value="${state.shift.product}" required>`], close: ['Revisar cierre', `<p class="mb-3">El sistema consolidará el turno con los valores siguientes.</p><label class="form-label" for="actualWeight">Kilos procesados</label><input class="form-control mb-3" id="actualWeight" type="number" min="0" value="${state.shift.actualWeight}" required><label class="form-label">Giveaway calculado</label><div class="panel p-3"><strong>${performance().giveaway.toFixed(2)}%</strong> · Tramo ${performance().tier}</div>`], users: ['Usuarios y roles', `<div class="table-wrap"><table class="table align-middle"><thead><tr><th>Usuario</th><th>Perfil</th><th>Estado</th></tr></thead><tbody><tr><td>Sofía Herrera</td><td>Administrador</td><td><span class="status-pill status-optimal">Activo</span></td></tr><tr><td>Daniela Fuentes</td><td>Jefe de línea</td><td><span class="status-pill status-optimal">Activo</span></td></tr><tr><td>Tomás Vidal</td><td>Supervisor</td><td><span class="status-pill status-optimal">Activo</span></td></tr><tr><td>Camila Rojas</td><td>Operador</td><td><span class="status-pill status-optimal">Activo</span></td></tr></tbody></table></div>`], parameters: ['Parámetros globales', `<label class="form-label" for="pauseTolerance">Tolerancia de pausa (minutos)</label><input class="form-control mb-3" id="pauseTolerance" type="number" min="1" value="${state.parameters?.pauseTolerance ?? 10}" required><label class="form-label" for="optimalGiveaway">Límite óptimo de Giveaway (%)</label><input class="form-control" id="optimalGiveaway" type="number" min="0" step="0.01" value="${state.parameters?.optimalGiveaway ?? 0.16}" required>`], audit: ['Auditoría inmutable', `<div class="table-wrap"><table class="table align-middle"><thead><tr><th>Hora</th><th>Evento</th><th>Responsable</th></tr></thead><tbody><tr><td>09:12</td><td>Cálculo de rendimiento</td><td>Sistema</td></tr><tr><td>08:42</td><td>Detención de línea</td><td>Tomás Vidal</td></tr><tr><td>06:00</td><td>Apertura de turno</td><td>Daniela Fuentes</td></tr></tbody></table></div>`] }[type];
  if (type === 'assign-shift') {
    const lines = catalogs.lines.length ? catalogs.lines.map((line) => `<option value="${line._id}">${line.nombre}</option>`).join('') : '<option value="" disabled selected>No hay líneas disponibles</option>';
    const managers = lineManagers.length ? lineManagers.map((manager) => `<option value="${manager._id}">${manager.username}</option>`).join('') : '<option value="" disabled selected>No hay jefes de línea disponibles</option>';
    const orders = catalogs.orders.length ? catalogs.orders.map((order) => `<option value="${order._id}">${order.codigoPedido}</option>`).join('') : '<option value="" disabled selected>No hay pedidos disponibles</option>';
    document.querySelector('#modalTitle').textContent = lineName ? `Asignar Jefe de Línea · ${lineName}` : 'Asignar turno';
    document.querySelector('#modalBody').innerHTML = `<label class="form-label" for="assignManager">Jefe de línea</label><select class="form-select mb-3" id="assignManager" required>${managers}</select><label class="form-label" for="assignLine">Línea</label><select class="form-select mb-3" id="assignLine" required>${lines}</select><label class="form-label" for="assignShift">Turno</label><select class="form-select mb-3" id="assignShift" required><option value="T1">T1</option><option value="T2">T2</option></select><label class="form-label" for="assignOrder">Pedido</label><select class="form-select mb-3" id="assignOrder" required>${orders}</select><label class="form-label" for="assignDate">Fecha</label><input class="form-control" id="assignDate" type="date" required value="${new Date().toISOString().slice(0, 10)}"/>`;
    document.querySelector('#modalBody').insertAdjacentHTML('afterbegin', '<button type="button" class="btn btn-sm btn-outline-secondary mb-3" data-action="personnel">Administrar Personal</button>');
    document.querySelector('[data-action="personnel"]')?.addEventListener('click', () => openModal('personnel'));
    if (lineId) {
      const lineSelect = document.querySelector('#assignLine');
      lineSelect.value = lineId;
      lineSelect.disabled = true;
    }
    document.querySelector('#actionForm').dataset.type = 'assign-shift';
    showNativeModal();
    return;
  }
  if (type === 'rotations') {
    document.querySelector('#modalTitle').textContent = 'Historial de rotaciones';
    document.querySelector('#modalBody').innerHTML = '<div id="rotationHistory" class="table-wrap"><p class="text-muted small">Cargando historial...</p></div>';
    document.querySelector('#actionForm').dataset.type = 'rotations';
    showNativeModal();
    loadRotationHistory();
    return;
  }
  if (!content) return;
  document.querySelector('#modalTitle').textContent = content[0];
  document.querySelector('#modalBody').innerHTML = content[1];
  if (type === 'downtime') {
    const durationInput = document.querySelector('#duration');
    durationInput?.previousElementSibling?.remove();
    durationInput?.remove();
    document.querySelector('#category')?.insertAdjacentHTML('beforebegin', '<p class="text-muted small mb-3">El cronómetro comenzará al guardar y la duración se calculará al finalizar.</p>');
  }
  if (type === 'start-shift' && catalogs.lines.length) {
    document.querySelector('#line').innerHTML = catalogs.lines.map((line) => `<option value="${line._id}">${line.nombre}</option>`).join('');
    document.querySelector('#product').insertAdjacentHTML('afterend', `<label class="form-label mt-3" for="order">Pedido</label><select class="form-select mb-3" id="order" required>${catalogs.orders.map((order) => `<option value="${order._id}">${order.codigoPedido}</option>`).join('')}</select><label class="form-label" for="shiftDate">Fecha del turno</label><input class="form-control mb-3" id="shiftDate" type="date" required><label class="form-label" for="collaborators">Dotación inicial</label><select class="form-select" id="collaborators" multiple required>${catalogs.collaborators.map((collaborator) => `<option value="${collaborator._id}">${collaborator.nombreCompleto} · ${collaborator.cargo}</option>`).join('')}</select>`);
    document.querySelector('#shiftDate').value = new Date().toISOString().slice(0, 10);
  }
  document.querySelector('#actionForm').dataset.type = type;
  showNativeModal();
}
async function loadPersonnel() {
  const target = document.querySelector('#personnelTable');
  if (!target) return;
  try {
    const response = await getPersonnelApi(false);
    target.innerHTML = `<table class="data-table compact-table"><thead><tr><th>Nombre</th><th>Cargo</th><th>Turno</th><th>Disponibilidad</th><th>Acción</th></tr></thead><tbody>${response.data.length ? response.data.map((person) => `<tr><td>${person.nombreCompleto}</td><td>${person.cargo}</td><td><span class="shift-badge">${person.turno === 'T2' ? 'T2' : 'T1'}</span></td><td><label class="availability-switch"><input type="checkbox" data-personnel-status="${person._id}" data-active="${person.activo}" ${person.activo ? 'checked' : ''} aria-label="Cambiar disponibilidad de ${person.nombreCompleto}"><span class="availability-slider"></span><span class="availability-switch-text">${person.activo ? 'Disponible' : 'No disponible'}</span></label></td><td class="personnel-row-actions"><button type="button" class="native-button native-button-secondary compact-button personnel-action-button" data-personnel-edit="${person._id}">Editar</button><button type="button" class="native-button native-button-danger compact-button" data-personnel-delete="${person._id}">Eliminar</button></td></tr>`).join('') : '<tr><td colspan="5" class="muted">Sin personal registrado.</td></tr>'}</tbody></table>`;
    target.querySelectorAll('[data-personnel-edit]').forEach((button) => button.addEventListener('click', () => { const person = response.data.find((item) => item._id === button.dataset.personnelEdit); if (person) openPersonnelForm(person); }));
    target.querySelectorAll('[data-personnel-delete]').forEach((button) => button.addEventListener('click', () => { const person = response.data.find((item) => item._id === button.dataset.personnelDelete); if (person) openPersonnelDeleteConfirmation(person); }));
    document.querySelectorAll('[data-personnel-status]').forEach((button) => button.addEventListener('change', async () => {
      const nextActive = button.checked;
      const switchText = button.closest('.availability-switch')?.querySelector('.availability-switch-text');
      if (switchText) switchText.textContent = nextActive ? 'Disponible' : 'No disponible';
      try { await updatePersonnelStatusApi(button.dataset.personnelStatus, nextActive); loadPersonnel(); }
      catch (error) { showToast(error.message); }
    }));
  } catch (error) {
    target.innerHTML = `<p class="text-danger small">${error.message}</p>`;
  }
}
function openPersonnelForm(person = null) {
  const form = document.querySelector('#personnelForm');
  const body = document.querySelector('#personnelFormBody');
  if (!form || !body) return;
  const editing = Boolean(person);
  document.querySelector('#personnelFormTitle').textContent = editing ? 'Editar información del personal' : 'Agregar personal';
  body.innerHTML = `<div class="admin-form-grid"><div class="admin-form-field"><label class="field-label" for="personName">Nombre completo</label><input class="field-control" id="personName" required></div><div class="admin-form-field"><label class="field-label" for="personRole">Cargo</label><select class="field-select" id="personRole" required><option value="Jefe de linea">Jefe de línea</option><option value="Operador">Operador</option></select></div><div class="admin-form-field"><label class="field-label" for="personShift">Turno</label><select class="field-select" id="personShift" required><option value="T1">T1</option><option value="T2">T2</option></select></div><div class="admin-form-field"><label class="field-label" for="personDate">Fecha de ingreso</label><input class="field-control" id="personDate" type="date" required></div><div class="admin-form-field"><label class="field-label" for="personRut">RUT</label><input class="field-control" id="personRut"></div>${editing ? '' : '<div class="admin-form-field" data-account-fields><label class="field-label" for="personUsername">Usuario de acceso</label><input class="field-control" id="personUsername" autocomplete="off"></div><div class="admin-form-field" data-account-fields><label class="field-label" for="personPassword">Contraseña de acceso</label><input class="field-control" id="personPassword" type="password" autocomplete="new-password"></div>'}</div>`;
  document.querySelector('#personName').value = person?.nombreCompleto || '';
  document.querySelector('#personRole').value = person?.cargo?.toLowerCase().includes('jefe') ? 'Jefe de linea' : 'Operador';
  document.querySelector('#personShift').value = person?.turno === 'T2' ? 'T2' : 'T1';
  document.querySelector('#personDate').value = person?.fechaIngreso ? new Date(person.fechaIngreso).toISOString().slice(0, 10) : '';
  document.querySelector('#personRut').value = person?.rut || '';
  form.dataset.type = editing ? 'personnel-update' : 'personnel-create';
  form.dataset.personnelId = person?._id || '';
  form.onsubmit = handleSubmit;
  const roleSelect = document.querySelector('#personRole');
  const accountFields = document.querySelectorAll('[data-account-fields]');
  const updateAccountFields = () => accountFields.forEach((field) => { field.hidden = roleSelect.value !== 'Jefe de linea'; });
  roleSelect.addEventListener('change', updateAccountFields);
  updateAccountFields();
  showPersonnelFormModal();
}
function startPersonnelEdit(person) {
  openPersonnelForm(person);
}
function openPersonnelDeleteConfirmation(person) {
  const form = document.querySelector('#personnelForm');
  document.querySelector('#personnelFormTitle').textContent = 'Confirmar eliminación';
  document.querySelector('#personnelFormBody').innerHTML = `<div class="confirmation-panel"><strong>¿Eliminar a ${person.nombreCompleto}?</strong><p class="muted small-text">Esta acción eliminará su registro de personal y no se puede deshacer.</p></div>`;
  form.dataset.type = 'personnel-delete';
  form.dataset.personnelId = person._id;
  form.onsubmit = handleSubmit;
  showPersonnelFormModal();
}
async function loadOrders() {
  const target = document.querySelector('#ordersTable');
  if (!target) return;
  try {
    const response = await getOrdersApi();
    target.innerHTML = response.data.length ? `<table class="data-table compact-table orders-table"><thead><tr><th>NOMBRE DEL PEDIDO</th><th>ACCIONES</th></tr></thead><tbody>${response.data.map((order) => `<tr><td>${order.nombre}</td><td class="personnel-row-actions"><button type="button" class="native-button native-button-secondary compact-button" data-order-edit="${order._id}" data-order-name="${order.nombre}">Editar</button><button type="button" class="native-button native-button-danger compact-button" data-order-delete="${order._id}">Eliminar</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted small-text">No hay pedidos registrados.</p>';
    target.querySelectorAll('[data-order-edit]').forEach((button) => button.addEventListener('click', () => openOrderForm({ _id: button.dataset.orderEdit, nombre: button.dataset.orderName })));
    target.querySelectorAll('[data-order-delete]').forEach((button) => button.addEventListener('click', async () => { try { await deleteOrderApi(button.dataset.orderDelete); showToast('Pedido eliminado.'); loadOrders(); } catch (error) { showToast(error.message); } }));
  } catch (error) { target.innerHTML = `<p class="text-danger small">${error.message}</p>`; }
}
function openOrderForm(order = null) {
  const form = document.querySelector('#orderForm');
  const body = document.querySelector('#orderFormBody');
  if (!form || !body) return;
  document.querySelector('#orderFormTitle').textContent = order ? 'Editar pedido' : 'Nuevo pedido';
  body.innerHTML = '<label class="field-label" for="orderName">Nombre del Pedido</label><input class="field-control" id="orderName" required maxlength="120" placeholder="Ej. Filete congelado">';
  document.querySelector('#orderName').value = order?.nombre || '';
  form.dataset.orderId = order?._id || '';
  form.onsubmit = handleOrderSubmit;
  showOrderFormModal();
}
async function handleOrderSubmit(event) {
  event.preventDefault();
  const input = document.querySelector('#orderName');
  const name = input.value.trim();
  if (!name) return;
  try {
    const orderId = event.currentTarget.dataset.orderId || '';
    if (orderId) await updateOrderApi(orderId, name);
    else await createOrderApi(name);
    closeOrderFormModal();
    showToast('Pedido guardado.');
    loadOrders();
  } catch (error) { showToast(error.message); }
}
async function loadMachineCertificates() {
  const target = document.querySelector('#certificatesTable');
  if (!target) return;
  try {
    const response = await getMachineCertificatesApi();
    target.innerHTML = `<table class="table align-middle admin-certificates-table"><thead><tr><th>RUT</th><th>Nombre</th><th>Rol</th><th>Operación Romana</th><th>Operación Rayos X</th><th>Acción</th></tr></thead><tbody>${response.data.map((person) => `<tr><td>${person.rut || '—'}</td><td>${person.nombreCompleto}</td><td>${person.rol}</td><td><label class="admin-toggle"><input type="checkbox" data-cert-romana="${person._id}" ${person.romana ? 'checked' : ''}><span>${person.romana ? 'Certificado' : 'No certificado'}</span></label></td><td><label class="admin-toggle"><input type="checkbox" data-cert-rayos="${person._id}" ${person.rayosX ? 'checked' : ''}><span>${person.rayosX ? 'Certificado' : 'No certificado'}</span></label></td><td class="admin-row-actions"><button type="button" class="btn btn-sm btn-sgsp" data-cert-save="${person._id}">Guardar Cambios</button></td></tr>`).join('')}</tbody></table>`;
    target.querySelectorAll('[data-cert-romana], [data-cert-rayos]').forEach((checkbox) => checkbox.addEventListener('change', () => { const label = checkbox.nextElementSibling; if (label) label.textContent = checkbox.checked ? 'Certificado' : 'No certificado'; }));
    target.querySelectorAll('[data-cert-save]').forEach((button) => button.addEventListener('click', async () => { const id = button.dataset.certSave; const romana = target.querySelector(`[data-cert-romana="${id}"]`).checked; const rayosX = target.querySelector(`[data-cert-rayos="${id}"]`).checked; try { await updateMachineCertificateApi(id, { romana, rayosX }); showToast('Certificados actualizados.'); } catch (error) { showToast(error.message); } }));
  } catch (error) { target.innerHTML = `<p class="text-danger small">${error.message}</p>`; }
}
async function loadRotationHistory() {
  const target = document.querySelector('#rotationHistory');
  if (!target) return;
  if (!session.token || !state.shift._id) { target.innerHTML = '<p class="text-muted small">El historial requiere un turno activo registrado.</p>'; return; }
  try {
    const response = await getRotationsApi(state.shift._id);
    target.innerHTML = response.data.length ? `<table class="table align-middle"><thead><tr><th>Colaborador</th><th>Desde</th><th>Hacia</th><th>Inicio</th><th>Fin</th></tr></thead><tbody>${response.data.map((rotation) => `<tr><td>${rotation.colaborador || 'Colaborador'}</td><td>${rotation.anterior || 'Sin puesto'}</td><td>${rotation.nuevo || 'Sin puesto'}</td><td>${new Date(rotation.inicio).toLocaleTimeString('es-CL')}</td><td>${rotation.fin ? new Date(rotation.fin).toLocaleTimeString('es-CL') : '<span class="status-pill status-acceptable">Activa</span>'}</td></tr>`).join('')}</tbody></table>` : '<p class="text-muted small">No hay rotaciones registradas.</p>';
  } catch (error) { target.innerHTML = `<p class="text-danger small">${error.message}</p>`; }
}
function bindEvents() {
  const workspace = document.querySelector('.workspace-body');
  let sidebarToggle = document.querySelector('[data-action="toggle-sidebar-global"]');
  if (!sidebarToggle) {
    sidebarToggle = document.createElement('button');
    sidebarToggle.className = 'sidebar-toggle-global';
    sidebarToggle.dataset.action = 'toggle-sidebar-global';
    sidebarToggle.setAttribute('aria-label', 'Ocultar barra lateral');
    sidebarToggle.setAttribute('aria-expanded', 'true');
    sidebarToggle.textContent = '‹';
    document.querySelector('.topbar')?.appendChild(sidebarToggle);
  }
  sidebarToggle.onclick = () => {
    const collapsed = workspace.classList.toggle('sidebar-collapsed');
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    sidebarToggle.setAttribute('aria-label', collapsed ? 'Mostrar barra lateral' : 'Ocultar barra lateral');
    sidebarToggle.textContent = collapsed ? '›' : '‹';
  };
  const dashboardSections = document.querySelectorAll('.dashboard-section');
  ['start-process-section', 'in-process-section', 'people-section', 'close-section'].forEach((id, index) => dashboardSections[index]?.setAttribute('id', id));
  const viewSectionMap = { start: ['start-process-section'], process: ['in-process-section'], pauses: ['people-section'], people: ['people-section'], downtime: ['in-process-section'], close: ['close-section'] };
  const applyActiveView = () => {
    const visibleSections = viewSectionMap[activeView] || [];
    dashboardSections.forEach((section) => section.classList.toggle('view-hidden', !visibleSections.includes(section.id)));
    document.querySelectorAll('[data-dashboard-chrome], .workflow-steps, .alert-strip').forEach((element) => element.classList.toggle('view-hidden', activeView !== 'dashboard'));
  };
  applyActiveView();
  document.querySelectorAll('[data-tranche-track]').forEach((track) => { let slide = 0; const update = () => { track.style.transform = `translateX(-${slide * 50}%)`; }; track.parentElement.parentElement.querySelector('[data-tranche-prev]')?.addEventListener('click', () => { slide = Math.max(0, slide - 1); update(); }); track.parentElement.parentElement.querySelector('[data-tranche-next]')?.addEventListener('click', () => { slide = Math.min(1, slide + 1); update(); }); update(); });
  const sliderTrack = document.querySelector('[data-slider-track]');
  if (sliderTrack) {
    const slideTitle = document.querySelector('[data-summary-view-title]');
    const slideIndicator = document.querySelector('[data-slide-indicator]');
    const slideInfo = { 1: { title: 'Tramo T1', label: '1/2 Tramo T1' }, 2: { title: 'Tramo T2', label: '2/2 Tramo T2' } };
    let activeSlide = 1;
    const updateSlide = () => {
      sliderTrack.style.transform = activeSlide === 1 ? 'translateX(0%)' : 'translateX(-50%)';
      if (slideTitle) slideTitle.textContent = slideInfo[activeSlide].title;
      if (slideIndicator) slideIndicator.textContent = slideInfo[activeSlide].label;
    };
    document.querySelector('[data-slide-prev]')?.addEventListener('click', () => { activeSlide = activeSlide === 1 ? 2 : 1; updateSlide(); });
    document.querySelector('[data-slide-next]')?.addEventListener('click', () => { activeSlide = activeSlide === 1 ? 2 : 1; updateSlide(); });
    updateSlide();
  }
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    activeView = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    applyActiveView();
    if (button.dataset.view === 'settings') { showToast('Configuración disponible para Administrador.'); return; }
  }));
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault();
    if (button.dataset.action === 'logout') return;
    if (button.dataset.action === 'toggle-sidebar-global') return;
    if (button.dataset.action === 'people') showToast('Selecciona una tarjeta para cambiar su estado.');
    else if (button.dataset.action === 'edit-groups') openModal('edit-groups');
    else if (button.dataset.action === 'edit-colacion-groups') openModal('edit-colacion-groups');
    else if (button.dataset.action === 'start-process') startProcess();
    else if (button.dataset.action === 'close-monthly-incentive') openMonthlyCloseConfirmation();
    else if (button.dataset.action === 'rotate') rotateWorkLines();
    else if (button.dataset.action === 'rotate-colacion') return;
    else if (button.dataset.action === 'return-all') { button.disabled = true; returnAllOperators().finally(() => { button.disabled = false; }); }
    else openModal(button.dataset.action);
  }));
  document.querySelectorAll('[data-downtime-end]').forEach((button) => button.addEventListener('click', () => finishDowntime(button.dataset.downtimeEnd)));
  document.querySelectorAll('[data-downtime-delete]').forEach((button) => button.addEventListener('click', () => deleteDowntime(button.dataset.downtimeDelete)));
  document.querySelectorAll('[data-action="rotate-colacion"]').forEach((button) => button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); button.disabled = true; rotateColacion(Number(button.dataset.colacionGroup)).finally(() => { button.disabled = false; }); }));
  document.querySelectorAll('[data-break-operator]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); startQuickBreak(button.dataset.breakOperator, button.dataset.breakType); }));
  document.querySelectorAll('[data-break-end]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); finishQuickBreak(button.dataset.breakEnd, button.dataset.breakOperator); }));
  document.querySelector('#closeShiftForm')?.addEventListener('submit', (event) => { event.currentTarget.dataset.type = 'close'; handleSubmit(event); });
  const giveawayInput = document.querySelector('#giveawayPercentage');
  giveawayInput?.addEventListener('input', () => {
    const result = document.querySelector('[data-giveaway-result]');
    const tier = document.querySelector('[data-tier-result]');
    const incentive = document.querySelector('[data-incentive-result]');
    const value = Number(giveawayInput.value);
    if (!Number.isFinite(value) || value < 0) { result.textContent = '--'; tier.textContent = '--'; incentive.textContent = '--'; return; }
    const evaluation = evaluateIncentive(value);
    result.textContent = `${value.toFixed(2)}%`;
    tier.textContent = `Tramo ${evaluation.tier}`;
    incentive.textContent = `$${formatNumber(evaluation.factor)}`;
  });
  document.querySelector('#startProcessForm')?.addEventListener('submit', (event) => { event.preventDefault(); confirmAndStartProcess(); });
  document.querySelectorAll('[data-action="logout"]').forEach((button) => button.addEventListener('click', logout));
  document.querySelectorAll('[data-operator]').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      selectedOperatorId = card.dataset.operator;
      draggedOperatorId = card.dataset.operator;
      card.classList.add('is-dragging');
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', selectedOperatorId); }
    });
    card.addEventListener('dragend', () => { card.classList.remove('is-dragging'); draggedOperatorId = null; document.querySelectorAll('.kanban-column, .work-line-column').forEach((column) => { column.classList.remove('is-over'); column.dataset.dragDepth = '0'; }); });
    card.addEventListener('click', () => {
      selectedOperatorId = selectedOperatorId === card.dataset.operator ? null : card.dataset.operator;
      render();
      if (selectedOperatorId) showToast('Tarjeta seleccionada: elige una columna de destino.');
    });
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); } });
  });
  document.querySelectorAll('.kanban-column').forEach((column) => {
    column.dataset.dragDepth = '0';
    column.addEventListener('dragenter', (event) => { event.preventDefault(); column.dataset.dragDepth = String(Number(column.dataset.dragDepth || 0) + 1); column.classList.add('is-over'); });
    column.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; });
    column.addEventListener('dragleave', () => { column.dataset.dragDepth = String(Math.max(0, Number(column.dataset.dragDepth || 0) - 1)); if (column.dataset.dragDepth === '0') column.classList.remove('is-over'); });
    column.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); column.classList.remove('is-over'); column.dataset.dragDepth = '0'; const operatorId = event.dataTransfer?.getData('text/plain') || draggedOperatorId || selectedOperatorId; moveOperator(operatorId, column.dataset.status); });
    column.querySelector('.column-head').addEventListener('click', () => { if (selectedOperatorId) moveOperator(selectedOperatorId, column.dataset.status); });
    column.querySelector('.empty-column')?.addEventListener('click', () => { if (selectedOperatorId) moveOperator(selectedOperatorId, column.dataset.status); });
    column.addEventListener('keydown', (event) => { if ((event.key === 'Enter' || event.key === ' ') && selectedOperatorId) { event.preventDefault(); moveOperator(selectedOperatorId, column.dataset.status); } });
  });
  document.querySelectorAll('.work-line-column').forEach((column) => {
    column.dataset.dragDepth = '0';
    column.addEventListener('dragenter', (event) => { event.preventDefault(); column.dataset.dragDepth = String(Number(column.dataset.dragDepth || 0) + 1); column.classList.add('is-over'); });
    column.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; });
    column.addEventListener('dragleave', () => { column.dataset.dragDepth = String(Math.max(0, Number(column.dataset.dragDepth || 0) - 1)); if (column.dataset.dragDepth === '0') column.classList.remove('is-over'); });
    column.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); column.classList.remove('is-over'); column.dataset.dragDepth = '0'; const operatorId = event.dataTransfer?.getData('text/plain') || draggedOperatorId || selectedOperatorId; moveOperatorToLine(operatorId, column.dataset.workLine); });
    column.querySelector('.work-line-header').addEventListener('click', () => { if (selectedOperatorId) moveOperatorToLine(selectedOperatorId, column.dataset.workLine); });
    column.querySelector('.empty-column')?.addEventListener('click', () => { if (selectedOperatorId) moveOperatorToLine(selectedOperatorId, column.dataset.workLine); });
  });
  document.querySelector('#actionForm').addEventListener('submit', handleSubmit);
}
function logout() {
  logoutApi().catch(() => {});
  session = null;
  localStorage.removeItem(SESSION_KEY);
  render();
}
async function cycleOperator(id) {
  if (!can(session, 'manage_people')) { showToast('Tu perfil solo tiene permisos de consulta.'); return; }
  const operator = state.operators.find((item) => item.id === id);
  if (!operator) return;
  const next = statusOrder[(statusOrder.indexOf(operator.status) + 1) % statusOrder.length];
  if (session.token && state.shift._id) {
    try { await updateOperatorStatusApi({ turnoId: state.shift._id, colaboradorId: operator.id, estado: next }); }
    catch (error) { showToast(error.message); return; }
  }
  operator.status = next;
  operator.breakStarted = next === 'break' ? Date.now() : undefined;
  operator.station = next === 'assigned' ? 'Puesto 06' : next === 'break' ? 'Colación' : next === 'available' ? 'Sin puesto' : 'Salida';
  saveState(); render(); showToast(`${operator.name} pasó a ${statusLabels[next].toLowerCase()}.`);
}
async function moveOperator(id, next) {
  if (!id || !statusOrder.includes(next)) return;
  const operator = state.operators.find((item) => item.id === id);
  if (!operator || operator.status === next) { selectedOperatorId = null; render(); return; }
  if (!can(session, 'manage_people')) { showToast('Tu perfil solo tiene permisos de consulta.'); return; }
  if (session.token && state.shift._id) {
    try { await updateOperatorStatusApi({ turnoId: state.shift._id, colaboradorId: operator.id, estado: next }); }
    catch (error) { showToast(error.message); return; }
  }
  operator.status = next;
  operator.breakStarted = next === 'break' ? Date.now() : undefined;
  operator.station = next === 'assigned' ? 'Puesto 06' : next === 'break' ? 'Colación' : next === 'available' ? 'Sin puesto' : 'Salida';
  selectedOperatorId = null;
  saveState();
  render();
  showToast(`${operator.name} pasó a ${statusLabels[next].toLowerCase()}.`);
}
async function moveOperatorToLine(id, line) {
  if (!id || !workLines.some((item) => item.id === line)) return;
  const operator = state.operators.find((item) => item.id === id);
  if (!operator || !can(session, 'manage_people')) return;
  const previousLine = operatorLine(operator);
  const nextStatus = line === 'colacion' || line === 'bano' ? 'break' : line === 'unassigned' ? 'available' : 'assigned';
  if (session.token && state.shift._id) {
    try { await updateOperatorStatusApi({ turnoId: state.shift._id, colaboradorId: operator.id, estado: nextStatus, lineaTrabajo: line }); }
    catch (error) { showToast(error.message); return; }
  }
  if (line === 'colacion' && previousLine !== 'colacion' && previousLine !== 'bano') operator.previousWorkLine = previousLine;
  operator.workLine = line;
  operator.status = nextStatus;
  operator.station = line === 'colacion' ? 'Colación' : line === 'bano' ? 'Baño' : line === 'unassigned' ? 'Sin puesto' : workLines.find((item) => item.id === line).label;
  operator.breakStarted = nextStatus === 'break' ? (operator.breakStarted || Date.now()) : undefined;
  selectedOperatorId = null;
  saveState();
  render();
  showToast(`${operator.name} rotado a ${workLines.find((item) => item.id === line).label}.`);
}
async function startProcess() {
  if (workflowStage() !== 'assigned') return;
  if (session.token) {
    if (!state.shift._id) { showToast('No hay un turno asignado en la base local para iniciar.'); return; }
    try {
      const started = await startShiftApi(state.shift._id);
      state.shift = { ...state.shift, ...started.data, workflowStage: 'in_process', startedAt: new Date(started.data.horaInicio).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) };
      await hydrateFromApi();
    } catch (error) { showToast(error.message); return; }
  } else {
    state.shift.workflowStage = 'in_process';
    state.shift.estado = 'activo';
    state.shift.active = true;
    state.shift.startedAt = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
  }
  activeView = 'process';
  saveState();
  render();
  showToast('Proceso iniciado. Acciones operativas habilitadas.');
}
async function confirmAndStartProcess() {
  const lineId = document.querySelector('#line')?.value;
  const orderId = document.querySelector('#order')?.value;
  const shiftType = document.querySelector('#shiftType')?.value || 'T1';
  const shiftDate = document.querySelector('#shiftDate')?.value;
  const dateMatch = shiftDate?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!lineId || !orderId || !dateMatch) { showToast('Completa turno, pedido y fecha con formato dd/mm/yyyy para iniciar.'); return; }
  const [, day, month, year] = dateMatch;
  const selectedDate = new Date(Number(year), Number(month) - 1, Number(day), 6);
  if (selectedDate.getFullYear() !== Number(year) || selectedDate.getMonth() !== Number(month) - 1 || selectedDate.getDate() !== Number(day)) { showToast('Ingresa una fecha válida con formato dd/mm/yyyy.'); return; }
  if (!session?.token) { showToast('Debes iniciar sesión para iniciar el turno.'); return; }
  if (workflowStage() === 'in_process') { showToast('Ya hay un turno en proceso. Ciérralo antes de iniciar otro.'); return; }
  try {
    const matchesAssignedShift = state.shift._id && state.shift.lineaId === lineId && state.shift.turno === shiftType;
    if (!matchesAssignedShift || workflowStage() !== 'assigned') {
      const created = await createShiftApi({ lineaId: lineId, turno: shiftType, fecha: selectedDate, jefeLineaId: session.id || session._id, pedidos: [{ pedidoId: orderId, prioridad: 1 }], colaboradores: [] });
      state.shift = { ...state.shift, ...created.data, _id: created.data._id, estado: 'planificado', workflowStage: 'assigned' };
    }
    const started = await startShiftApi(state.shift._id);
    state.shift = { ...state.shift, ...started.data, workflowStage: 'in_process', active: true, startedAt: new Date(started.data.horaInicio).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) };
    activeView = 'process';
    await hydrateFromApi();
    saveState();
    render();
    showToast('Proceso iniciado. Distribuye el personal desde el tablero.');
  } catch (error) { showToast(error.message); }
}
async function rotateWorkLines(targetGroup = null) {
  for (const operator of state.operators) {
    if (targetGroup && operator.grupoRotacion !== targetGroup) continue;
    const target = nextWorkLine(operatorLine(operator));
    if (!target) continue;
    await moveOperatorToLine(operator.id, target);
    const positionGroup = nextPositionGroup(operator.grupoPuesto);
    if (positionGroup && positionGroup !== operator.grupoPuesto) {
      if (session.token && state.shift._id) {
        try { await updateRotationGroupsApi({ turnoId: state.shift._id, colaboradorId: operator.id, grupoPuesto: positionGroup }); }
        catch (error) { showToast(error.message); continue; }
      }
      operator.grupoPuesto = positionGroup;
    }
  }
  saveState();
  showToast(targetGroup ? `Rotación de puestos para G${targetGroup} completada.` : 'Rotación de puestos A → B → C completada.');
}
async function rotateColacion(targetGroup) {
  const targetMembers = state.operators.filter((operator) => operator.grupoRotacion === targetGroup && operator.status !== 'inactive');
  const previousMembers = state.operators.filter((operator) => operator.grupoRotacion !== targetGroup && operatorLine(operator) === 'colacion');
  for (const operator of previousMembers) await moveOperatorToLine(operator.id, operator.previousWorkLine || 'unassigned');
  for (const operator of targetMembers) {
    if (operatorLine(operator) !== 'bano') await moveOperatorToLine(operator.id, 'colacion');
  }
  saveState();
  render();
  showToast(`Grupo G${targetGroup} enviado a Colación.`);
}
async function returnAllOperators() {
  const activeOperators = state.operators.filter((operator) => operator.status !== 'inactive');
  for (const operator of activeOperators) {
    if (operatorLine(operator) === 'bano' || operatorLine(operator) === 'colacion') {
      await moveOperatorToLine(operator.id, operator.previousWorkLine || 'unassigned');
    }
  }
  const positionGroups = ['A', 'B', 'C'];
  for (let index = 0; index < activeOperators.length; index += 1) {
    const operator = activeOperators[index];
    const targetGroup = positionGroups[index % positionGroups.length];
    if (operator.grupoPuesto !== targetGroup) {
      if (session.token && state.shift._id) await updateRotationGroupsApi({ turnoId: state.shift._id, colaboradorId: operator.id, grupoRotacion: Number(operator.grupoRotacion || 1), grupoPuesto: targetGroup });
      operator.grupoPuesto = targetGroup;
    }
  }
  saveState();
  render();
  showToast('Personal retornado y grupos A/B/C redistribuidos.');
}
async function finishDowntime(id) {
  const downtime = state.downtime.find((event) => String(event.id) === String(id));
  if (!downtime) return;
  if (session.token && isMongoObjectId(downtime.id)) {
    try { await endDowntimeApi(downtime.id); }
    catch (error) { showToast(error.message); return; }
  }
  const finishedAt = Date.now();
  const startedAt = new Date(downtime.inicio || Date.now()).getTime();
  downtime.fin = new Date(finishedAt).toISOString();
  downtime.duration = `${Math.max(0, ((finishedAt - startedAt) / 60000).toFixed(2))} min`;
  state.activeDowntimes = state.downtime.filter((event) => !event.fin);
  saveState();
  render();
  showToast('Detención finalizada y duración calculada.');
}
async function deleteDowntime(id) {
  const downtime = state.downtime.find((event) => String(event.id) === String(id));
  if (!downtime || !window.confirm('¿Borrar esta detención de la bitácora?')) return;
  if (session.token && isMongoObjectId(downtime.id)) {
    try { await deleteDowntimeApi(downtime.id); }
    catch (error) { showToast(error.message); return; }
  }
  state.downtime = state.downtime.filter((event) => String(event.id) !== String(id));
  state.activeDowntimes = state.downtime.filter((event) => !event.fin);
  saveState();
  render();
  showToast('Detención eliminada de la bitácora.');
}
async function startQuickBreak(operatorId, type) {
  const operator = state.operators.find((item) => item.id === operatorId);
  if (!operator) return;
  if (session.token && state.shift._id) {
    try {
      const response = await createBreakApi({ turnoId: state.shift._id, colaboradorId: operator.id, tipo: type });
      operator.breakId = response.data._id;
    } catch (error) { showToast(error.message); return; }
  }
  operator.previousWorkLine = operatorLine(operator);
  operator.status = 'break';
  operator.station = type === 'bano' ? 'Baño' : 'Colación';
  operator.workLine = type === 'bano' ? 'bano' : 'colacion';
  operator.breakStarted = Date.now();
  saveState();
  render();
  showToast(`${operator.name} inició pausa de ${type === 'bano' ? 'baño' : 'colación'}.`);
}
async function finishQuickBreak(breakId, operatorId) {
  const operator = state.operators.find((item) => item.breakId === breakId || item.id === operatorId);
  if (session.token && breakId) {
    try { await endBreakApi(breakId); } catch (error) { showToast(error.message); return; }
  }
  if (operator) {
    const returnLine = returnLineAfterBreak(operator.previousWorkLine);
    operator.status = returnLine === 'unassigned' ? 'available' : 'assigned';
    operator.workLine = returnLine;
    operator.station = workLines.find((line) => line.id === returnLine)?.label || 'Sin puesto';
    operator.breakStarted = undefined;
    operator.breakId = undefined;
    operator.previousWorkLine = undefined;
  }
  saveState();
  render();
  showToast('Pausa finalizada.');
}
async function handleSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const type = form.dataset.type;
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.dataset.previousLabel = submitButton.textContent;
    submitButton.textContent = 'Guardando...';
  }
  if (type === 'personnel-create') {
    try {
      await createPersonnelApi({ nombreCompleto: document.querySelector('#personName').value.trim(), cargo: document.querySelector('#personRole').value, turno: document.querySelector('#personShift').value, fechaIngreso: document.querySelector('#personDate').value, rut: document.querySelector('#personRut').value.trim(), username: document.querySelector('#personUsername')?.value.trim(), password: document.querySelector('#personPassword')?.value });
      await returnToPersonnelManagement();
      showToast('Personal creado correctamente.');
    } catch (error) { showToast(error.message); }
  } else if (type === 'personnel-update') {
    try {
      await updatePersonnelApi(form.dataset.personnelId, { nombreCompleto: document.querySelector('#personName').value.trim(), cargo: document.querySelector('#personRole').value, turno: document.querySelector('#personShift').value, fechaIngreso: document.querySelector('#personDate').value, rut: document.querySelector('#personRut').value.trim() });
      await returnToPersonnelManagement();
      showToast('Información del personal actualizada.');
    } catch (error) { showToast(error.message); }
  } else if (type === 'personnel-delete') {
    try {
      await deletePersonnelApi(form.dataset.personnelId);
      closePersonnelFormModal();
      showToast('Personal eliminado.');
      openModal('personnel');
    } catch (error) { showToast(error.message); }
  } else if (type === 'edit-groups') {
    const changes = [...document.querySelectorAll('[data-group-editor-operator]')];
    try {
      for (const select of changes) {
        const operator = state.operators.find((item) => item.id === select.dataset.groupEditorOperator);
        const positionGroup = select.dataset.positionGroup;
        if (!operator || positionGroup === operator.grupoPuesto) continue;
        if (session.token && state.shift._id) await updateRotationGroupsApi({ turnoId: state.shift._id, colaboradorId: operator.id, grupoRotacion: Number(operator.grupoRotacion || 1), grupoPuesto: positionGroup });
        operator.grupoPuesto = positionGroup;
      }
    } catch (error) { showToast(error.message); return; }
    saveState();
    showToast('Grupos G1/G2 y A/B/C actualizados.');
  } else if (type === 'edit-colacion-groups') {
    const changes = [...document.querySelectorAll('[data-colacion-editor-operator]')];
    try {
      for (const card of changes) {
        const operator = state.operators.find((item) => item.id === card.dataset.colacionEditorOperator);
        const colacionGroup = Number(card.dataset.colacionGroup);
        if (!operator || colacionGroup === Number(operator.grupoRotacion || 1)) continue;
        if (session.token && state.shift._id) await updateRotationGroupsApi({ turnoId: state.shift._id, colaboradorId: operator.id, grupoRotacion: colacionGroup, grupoPuesto: operator.grupoPuesto || 'A' });
        operator.grupoRotacion = colacionGroup;
      }
    } catch (error) { showToast(error.message); return; }
    saveState();
    showToast('Grupos de colación G1/G2 actualizados.');
  } else if (type === 'assign-shift') {
    if (!session.token) { showToast('Debes iniciar sesión para asignar el turno.'); return; }
    try {
      const response = await createShiftApi({ lineaId: document.querySelector('#assignLine').value, turno: document.querySelector('#assignShift').value, jefeLineaId: document.querySelector('#assignManager').value, fecha: new Date(`${document.querySelector('#assignDate').value}T06:00:00`), pedidos: [{ pedidoId: document.querySelector('#assignOrder').value, prioridad: 1 }], colaboradores: [] });
      showToast(`Turno ${response.data._id} asignado correctamente.`);
    } catch (error) { showToast(error.message); return; }
  } else if (type === 'break') {
    const operator = state.operators.find((item) => item.id === document.querySelector('#operator').value);
    if (operator && session.token && state.shift._id) {
      try { await createBreakApi({ turnoId: state.shift._id, colaboradorId: operator.id, tipo: normalizeApiValue(document.querySelector('#breakType').value) }); }
      catch (error) { showToast(error.message); return; }
    }
    if (operator) { operator.status = 'break'; operator.station = document.querySelector('#breakType').value; operator.breakStarted = Date.now(); showToast('Pausa registrada con timestamp de inicio.'); }
  } else if (type === 'downtime') {
    const downtime = { id: `demo-downtime-${Date.now()}`, time: new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }), duration: 'En curso', reason: document.querySelector('#reason').value, category: document.querySelector('#category').value, inicio: new Date().toISOString(), fin: null };
    if (session.token && state.shift._id) {
      try {
        const created = await createDowntimeApi({ turnoId: state.shift._id, categoria: normalizeApiValue(downtime.category), motivo: downtime.reason });
        downtime.id = created.data._id;
      }
      catch (error) { showToast(error.message); return; }
    }
    state.downtime.unshift(downtime);
    state.activeDowntimes = state.downtime.filter((event) => !event.fin);
    showToast('Detención agregada a la bitácora.');
  } else if (type === 'start-shift') {
    const lineValue = document.querySelector('#line').value;
    const productValue = document.querySelector('#product').value;
    if (session.token && catalogs.lines.length) {
      try {
        const shiftResponse = await createShiftApi({ lineaId: lineValue, turno: document.querySelector('#shiftType')?.value || 'T1', fecha: new Date(`${document.querySelector('#shiftDate').value}T06:00:00`), pedidos: [{ pedidoId: document.querySelector('#order').value, prioridad: 1 }], colaboradores: [...document.querySelector('#collaborators').selectedOptions].map((option) => option.value) });
        state.shift = { ...state.shift, ...shiftResponse.data, _id: shiftResponse.data._id, estado: 'planificado', workflowStage: 'assigned', line: catalogs.lines.find((line) => line._id === lineValue)?.nombre || lineValue, product: productValue, startedAt: 'Pendiente' };
        showToast('Turno asignado. Listo para iniciar proceso.');
      } catch (error) { showToast(error.message); return; }
    } else {
      state.shift.line = lineValue; state.shift.product = productValue; state.shift.workflowStage = 'assigned'; state.shift.active = false; showToast('Turno asignado. Listo para iniciar proceso.');
    }
  } else if (type === 'close') {
    const actualWeight = Number(document.querySelector('#actualWeight').value);
    const giveawayPercentage = Number(document.querySelector('#giveawayPercentage').value);
    if (session.token) {
      if (!state.shift._id) { showToast('No hay un turno activo para cerrar. Asigna e inicia un turno primero.'); return; }
      try {
        const result = await closeShiftApi(state.shift._id, { kilosProcesados: actualWeight, porcentajeGiveaway: giveawayPercentage, lineaId: state.shift.lineaId || state.shift.lineId });
        await hydrateFromApi();
        state.shift = { ...state.shift, workflowStage: 'assigned', active: false, horaInicio: null, startedAt: 'Pendiente' };
        activeView = 'start';
        showToast(`Día guardado. Giveaway final: ${Number(result.data.rentaVariable.giveawayNumber).toFixed(2)}%. Nuevo turno listo.`);
      } catch (error) { showToast(error.message); return; }
    } else {
      state.shift = { ...structuredClone(initialState.shift), workflowStage: 'assigned', active: false, horaInicio: null, actualWeight: structuredClone(initialState.shift.targetWeight), startedAt: 'Pendiente' };
      state.operators = [];
      state.downtime = [];
      state.activeDowntimes = [];
      activeView = 'start';
      showToast(`Día guardado. Giveaway final: ${giveawayPercentage.toFixed(2)}%. Nuevo turno listo.`);
    }
  }
  if (!['personnel-create', 'personnel-update', 'personnel-delete'].includes(type)) {
    saveState();
    closeNativeModal();
    render();
  }
  if (submitButton) {
    submitButton.disabled = false;
    submitButton.textContent = submitButton.dataset.previousLabel || 'Guardar';
    delete submitButton.dataset.previousLabel;
  }
}

document.addEventListener('click', (event) => { if (event.target.closest('[data-action="reset"]')) { localStorage.removeItem(STORAGE_KEY); state = structuredClone(initialState); render(); showToast('Datos restablecidos.'); } });
render();
if (session?.token) hydrateFromApi().then(() => render());
