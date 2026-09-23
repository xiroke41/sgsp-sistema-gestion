# Provisionamiento inicial local

Al iniciar `npm run api`, la API crea y puebla automáticamente la base local en `database/sgsp.local.json`.

## Datos creados automáticamente

1. Roles base: `Administrador`, `Jefe de linea`, `Supervisor` y `Operador`.
2. Usuarios demo:
  - `admin / Admin12345`
  - `jefe / Jefe123456`
3. Líneas por defecto:
  - `Andes Asia` con turno activo.
  - `Nippon` con turno pendiente.
4. Tramos de Giveaway, puestos operativos, colaboradores demo, dotación inicial y una detención de ejemplo.

## Reinicio de datos locales

1. Detén la API.
2. Elimina `database/sgsp.local.json`.
3. Inicia nuevamente `npm run api`.

No pegues contraseñas reales en el repositorio, en tickets ni en el chat. Si vas a usar credenciales distintas a las demo, créalas desde el panel o cambia los datos semilla del backend.
