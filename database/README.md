# Fase 1: Modelo de datos local

El dominio de SGSP conserva la misma estructura documental, pero la demostración local usa un almacenamiento persistente en `database/sgsp.local.json` a través de [Model/mongo.js](../Model/mongo.js).

## Entidades

- `roles` y `usuarios`: autenticacion, perfiles y permisos.
- `colaboradores`: ficha laboral de cada persona.
- `lineasProduccion`, `productos` y `pedidosProduccion`: catalogos y carga productiva.
- `turnosProduccion`: ciclo de un turno con una lista acotada de referencias a pedidos.
- `puestos`, `asistenciaTurno` y `rotacionesPuesto`: dotacion y asignacion operativa.
- `pausasSala`: pausas de bano, colacion y permiso.
- `detencionesLinea`: bitacora de tiempos muertos.
- `tramosGiveawayTarifa` y `rentaVariable`: calculo de incentivo.
- `auditoria`: trazabilidad de cambios y operaciones.

## Decisiones de normalizacion

El diagrama mostraba `Asistencia_Turno` y `Tramo_Giveaway_Tarifa` repetidas; se implementa una unica coleccion de cada entidad. Las referencias usan `ObjectId` y los pedidos del turno se embeben como lista acotada en `turnosProduccion`, porque se consultan junto con el turno y tienen un limite operativo.

Las pausas, detenciones, rotaciones y auditorias permanecen en colecciones separadas porque crecen con el tiempo y se consultan de forma independiente. La pausa activa se restringe con un indice parcial: un colaborador no puede tener dos pausas abiertas en el mismo turno.

Los validadores `$jsonSchema` protegen tipos y estados en la base de datos. Los campos monetarios y de peso usan `Decimal128` para evitar errores de precision de `float`.

## Aplicacion

Requisitos:

- Node.js 20 o superior.
- Permisos de escritura sobre el directorio `database/`.

La aplicación Node usa [Model/mongo.js](../Model/mongo.js) como adaptador local con una API compatible con las colecciones existentes. Si `MONGODB_URI` está definido, el mismo módulo usa MongoDB Atlas con una conexión reutilizable para entornos Serverless. Sin esa variable, al iniciar `npm run api` crea `database/sgsp.local.json` si no existe y ejecuta el seed idempotente local.

La plantilla de configuración sigue disponible en [.env.example](../.env.example). `JWT_SECRET` es opcional para entorno local porque el servidor define un valor demo si no existe; nunca subas un archivo `.env` real al repositorio.

## API backend

El servidor se inicia con `npm run api` y expone por defecto `http://localhost:3000`.

- `GET /health`: comprueba que el proceso HTTP está vivo.
- `GET /ready`: comprueba que el proceso puede abrir y responder desde la base local `SGSP`.

- `POST /api/auth/login`: obtiene un JWT.
- `GET /api/auth/me`: valida la sesión actual.
- `GET /api/operation/dashboard`: dashboard del turno activo.
- `GET /api/shifts`: consulta de turnos.
- `POST /api/shifts`: crea y asigna un turno; requiere `assign_shift`.
- `POST /api/shifts/:id/start`: inicia un turno; requiere `manage_shift`.
- `POST /api/shifts/:id/close`: cierra un turno; requiere `close_shift`.
- `POST /api/breaks` y `PATCH /api/breaks/:id/end`: gestiona pausas.
- `POST /api/downtimes`: registra una detención.
- `PATCH /api/downtimes/:id/end`: finaliza la detención y calcula su duración desde los timestamps.
- `PATCH /api/operators/status`: actualiza el estado de un operador.
- `GET /api/admin/line-managers`: consulta jefes de línea disponibles para asignación.
- `GET /api/admin/summary`: consulta el resumen operativo administrativo.

Todas las rutas, salvo login y `/health`, requieren `Authorization: Bearer <token>` y validan permisos del rol en la base local.

La asignación inicial requiere `lineaId`, `turno` (`T1` o `T2`) y `jefeLineaId`, y solo la puede realizar un Administrador mediante `POST /api/shifts`. El Jefe de línea solo puede iniciar un turno planificado que le fue asignado.

El cierre recibe `kilogramosProcesados` y `giveawayPorcentaje`. El backend selecciona el tramo desde `tramosGiveawayTarifa`, guarda `rentaVariable`, registra la auditoria, marca el turno como `cerrado` y devuelve el siguiente estado `assigned` para iniciar un nuevo ciclo.

Las detenciones no reciben duración desde el formulario: `POST /api/downtimes` guarda el inicio y cada registro activo tiene su propio `PATCH /api/downtimes/:id/end`, que guarda el fin y calcula los minutos transcurridos. Pueden existir varias detenciones activas simultáneamente en un turno.

Las rotaciones actualizan `asistenciaTurno.lineaTrabajo` y además conservan historial en `rotacionesPuesto`: se cierra la asignación anterior y se crea la nueva con sus timestamps. La API controla capacidades de Mesa (5), Máquinas (4), Embalaje (6), Rayos X (2) y Romana (1). Colación es una única zona especial sin capacidad fija; Rayos X y Romana requieren una certificación textual coincidente en `colaboradores.certificaciones`.

Los grupos se mantienen separados: `grupoRotacion` contiene G1/G2 para la rotacion de personas y `grupoPuesto` contiene A/B/C para la rotacion de puestos. Ninguno de estos campos representa una pausa de colacion; `bano` y `colacion` son estados operativos independientes.

## Usuarios iniciales

El seed local crea automáticamente usuarios demo, colaboradores, líneas, puestos y tramos tarifarios. La carga es idempotente: si el archivo ya existe, solo inserta lo que falta y no duplica registros.

## Persistencia local

La base local `database/sgsp.local.json` es la única ruta de persistencia requerida por la demostración y por la operación local del proyecto.
