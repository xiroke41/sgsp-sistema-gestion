import { Router } from 'express';
import { asyncHandler, validateBody } from '../middleware/http.js';
import { authenticateRequest, requirePermission } from '../middleware/auth.js';
import * as authController from '../Controller/authController.js';
import * as shiftController from '../Controller/shiftController.js';
import * as operationController from '../Controller/operationController.js';
import * as adminController from '../Controller/adminController.js';
import * as personnelController from '../Controller/personnelController.js';
import * as adminDataController from '../Controller/adminDataController.js';

const router = Router();

router.post('/auth/login', validateBody(['username', 'password']), asyncHandler(authController.login));
router.use(authenticateRequest);
router.get('/auth/me', asyncHandler(authController.me));

router.get('/operation/dashboard', requirePermission('view_dashboard'), asyncHandler(shiftController.dashboard));
router.get('/operation/catalogs', requirePermission('manage_shift'), asyncHandler(shiftController.catalogs));
router.get('/shifts', requirePermission('view_dashboard'), asyncHandler(shiftController.listShifts));
router.post('/shifts', requirePermission('assign_shift'), validateBody(['lineaId', 'fecha', 'turno', 'jefeLineaId']), asyncHandler(shiftController.createShift));
router.post('/shifts/:id/start', requirePermission('manage_shift'), asyncHandler(shiftController.startShift));
router.post('/shifts/:id/close', requirePermission('close_shift'), validateBody(['kilosProcesados', 'porcentajeGiveaway', 'lineaId']), asyncHandler(shiftController.closeShift));
router.post('/incentives/monthly-close', requirePermission('close_shift'), validateBody(['lineaId']), asyncHandler(shiftController.closeMonthlyIncentive));

router.post('/breaks', requirePermission('register_break'), validateBody(['turnoId', 'colaboradorId', 'tipo']), asyncHandler(operationController.createBreak));
router.patch('/breaks/:id/end', requirePermission('register_break'), asyncHandler(operationController.endBreak));
router.post('/downtimes', requirePermission('register_downtime'), validateBody(['turnoId', 'categoria', 'motivo']), asyncHandler(operationController.createDowntime));
router.patch('/downtimes/:id/end', requirePermission('register_downtime'), asyncHandler(operationController.endDowntime));
router.delete('/downtimes/:id', requirePermission('register_downtime'), asyncHandler(operationController.deleteDowntime));
router.patch('/operators/status', requirePermission('manage_people'), validateBody(['turnoId', 'colaboradorId', 'estado']), asyncHandler(operationController.updateOperatorStatus));
router.patch('/operators/rotation-groups', requirePermission('manage_people'), validateBody(['turnoId', 'colaboradorId', 'grupoRotacion']), asyncHandler(operationController.updateRotationGroups));
router.get('/rotations/:turnoId', requirePermission('view_dashboard'), asyncHandler(operationController.listRotations));

router.get('/admin/summary', requirePermission('all'), asyncHandler(adminController.summary));
router.get('/admin/line-managers', requirePermission('assign_shift'), asyncHandler(adminController.listLineManagers));
router.get('/admin/personnel', requirePermission('all'), asyncHandler(personnelController.list));
router.post('/admin/personnel', requirePermission('all'), validateBody(['nombreCompleto', 'fechaIngreso', 'cargo']), asyncHandler(personnelController.create));
router.put('/admin/personnel/:id', requirePermission('all'), validateBody(['nombreCompleto', 'fechaIngreso', 'cargo']), asyncHandler(personnelController.update));
router.delete('/admin/personnel/:id', requirePermission('all'), asyncHandler(personnelController.remove));
router.patch('/admin/personnel/:id/status', requirePermission('all'), validateBody(['activo']), asyncHandler(personnelController.updateStatus));
router.get('/pedidos', requirePermission('all'), asyncHandler(adminDataController.listOrders));
router.post('/pedidos', requirePermission('all'), validateBody(['nombre']), asyncHandler(adminDataController.createOrder));
router.put('/pedidos/:id', requirePermission('all'), validateBody(['nombre']), asyncHandler(adminDataController.updateOrder));
router.delete('/pedidos/:id', requirePermission('all'), asyncHandler(adminDataController.deleteOrder));
router.get('/certificados', requirePermission('all'), asyncHandler(adminDataController.listMachineCertificates));
router.put('/certificados/:id', requirePermission('all'), validateBody(['romana', 'rayosX']), asyncHandler(adminDataController.updateMachineCertificate));

export default router;
