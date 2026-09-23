# Vistas SGSP

Las pantallas operativas se separan en plantillas HTML para mantener la capa View fuera de los controladores:

- `login.html`: autenticacion.
- `operacion/inicio-proceso.html`: turno asignado y habilitacion del proceso.
- `operacion/en-proceso.html`: detenciones y acciones del proceso.
- `operacion/gestion-personal.html`: Kanban, grupos G1/G2, puestos A/B/C, Baño y Colacion.
- `operacion/cierre-turno.html`: kilos, Giveaway, tramo y Guardar dia.

Los atributos `data-*` son los puntos de montaje para los controladores. La logica de negocio permanece en Model/Services y la coordinacion HTTP en Controller/routes.
