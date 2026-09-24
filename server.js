import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import apiRoutes from './routes/api.js';
import { errorHandler } from './middleware/http.js';
import { closeMongo, initializeDatabase } from './Model/mongo.js';
import { seedLocalDatabase } from './Model/localSeed.js';

process.env.JWT_SECRET ||= 'sgsp-local-demo-secret';

const app = express();

function isAllowedLocalOrigin(origin) {
  if (!origin) return true;
  if (process.env.FRONTEND_ORIGIN && origin === process.env.FRONTEND_ORIGIN) return true;
  if (process.env.VERCEL_URL && origin === `https://${process.env.VERCEL_URL}`) return true;
  if (origin === 'https://sgsp-sistema-gestion.vercel.app') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    if (isAllowedLocalOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origen no permitido por CORS.'));
  }
}));
app.use(express.json({ limit: '100kb' }));
app.get('/health', (_request, response) => response.json({ success: true, data: { service: 'sgsp-api', status: 'ok' }, message: 'API disponible.' }));
app.get('/ready', async (_request, response) => {
  try {
    await initializeDatabase();
    return response.json({ success: true, data: { service: 'sgsp-api', database: 'SGSP Local', status: 'ready' }, message: 'API y base local disponibles.' });
  } catch (error) {
    return response.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'La base local aún no está disponible.' });
  }
});
app.use('/api', apiRoutes);
app.use((request, response, next) => {
  if (request.path === '/api' || request.path.startsWith('/api/')) {
    return response.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Ruta no encontrada.' });
  }
  return next();
});
app.use(express.static('.'));
app.use((_request, response) => response.sendFile(resolve('.', 'index.html')));
app.use(errorHandler);

export { app };
export default app;

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.API_PORT || 3000);

  async function start() {
    await initializeDatabase();
    const { admin, jefe } = await seedLocalDatabase();
    console.log(`Base local lista. Usuarios por defecto: ${admin.username} / ${jefe.username}.`);

    const server = app.listen(port, () => console.log(`SGSP API escuchando en http://localhost:${port}`));

    async function shutdown(signal) {
      console.log(`Recibida señal ${signal}. Cerrando API.`);
      server.close(async () => {
        await closeMongo();
        process.exit(0);
      });
    }

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  start().catch(async (error) => {
    console.error(`No se pudo iniciar la base local: ${error.message}`);
    await closeMongo();
    process.exit(1);
  });
}
