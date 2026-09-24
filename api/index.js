import { app } from '../server.js';
import { initializeDatabase } from '../Model/mongo.js';

export default async function handler(request, response) {
	try {
		await initializeDatabase();
		return app(request, response);
	} catch (error) {
		console.error(`[Vercel] No se pudo inicializar la base de datos: ${error.message}`);
		return response.status(503).json({ success: false, error: 'DATABASE_UNAVAILABLE', message: 'La base de datos no está disponible.' });
	}
}
