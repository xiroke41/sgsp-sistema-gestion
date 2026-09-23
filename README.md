# SGSP Operacion

Sistema de gestion de sala y rendimiento productivo con Node.js, Express, persistencia local y vistas HTML/CSS/JS.

## Requisitos

- Node.js 20 o superior.
- El backend usa una base local persistente en `database/sgsp.local.json` cuando no existe `MONGODB_URI`.

## Configuracion

1. Copia `.env.example` a `.env` si quieres sobrescribir puertos, secretos o conexión.
2. Si no defines `JWT_SECRET`, la API usa un secreto local de demostración.
3. Para MongoDB Atlas/Vercel define `MONGODB_URI` en las variables de entorno de Vercel.
4. No subas `.env` al repositorio.

La API usa una base local `SGSP` persistida en disco o la base `SGSP` de MongoDB definida por `MONGODB_URI`. La conexión Atlas se reutiliza entre invocaciones Serverless mediante un cliente y una promesa cacheados a nivel de módulo.

## Ejecucion

```powershell
npm install
npm run api
```

En otra terminal, sirve la interfaz:

```powershell
npm start
```

- Interfaz: `http://localhost:4173`
- API: `http://localhost:3000`
- Salud del proceso: `GET /health`
- Disponibilidad de la base local: `GET /ready`

## Pruebas

```powershell
npm test
```

La suite valida reglas de negocio, middleware y el flujo HTTP del backend local.

## Arquitectura

- `Model/`: reglas de negocio, persistencia local y pruebas unitarias.
- `Controller/`: coordinación de API y eventos de interfaz.
- `middleware/`: autenticación JWT, RBAC, validación y errores.
- `routes/`: rutas HTTP protegidas por permisos.
- `Views/`: plantillas físicas de login, operación y administración.
- `services/`: cálculo server-side de rendimiento y renta variable.
- `database/`: base local persistente y documentación del esquema.

La API crea automáticamente usuarios demo y datos iniciales al arrancar por primera vez.

## Flujo operativo

1. El administrador asigna el turno a un jefe de línea.
2. El jefe inicia el proceso.
3. La sala registra detenciones y pausas de Baño/Colación.
4. La dotación se mueve entre líneas con capacidades y certificaciones.
5. G1/G2 representan grupos de personas y A/B/C grupos de puestos.
6. El cierre calcula Giveaway y renta variable.
7. Al guardar el día, el turno se registra como cerrado y la interfaz vuelve automáticamente a Apertura de turno para comenzar un nuevo ciclo T1/T2.

El frontend conserva un modo demo local cuando la API no está disponible; cuando la API está activa, la persistencia real usa la base local y un JWT válido.

Stack Técnico: HTML5, CSS3 (Vanilla), JavaScript (ES6+), Node.js con Express.

Librerías externas: Ninguna. Se requiere CSS nativo sin frameworks adicionales (sin Bootstrap, Tailwind o similares).