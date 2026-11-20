'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const store = require('./db');
const { fail } = require('./utils/respuesta');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ------------------------------------------------------------------
// API REST del SIGELAB
// ------------------------------------------------------------------
app.use('/api/auth', require('./routes/auth'));
app.use('/api/ambientes', require('./routes/ambientes'));
app.use('/api/equipos', require('./routes/equipos'));
app.use('/api/personas', require('./routes/personas'));
app.use('/api/docentes', require('./routes/docentes'));
app.use('/api/academico', require('./routes/academico'));
app.use('/api/usos', require('./routes/usos'));
app.use('/api/reportes', require('./routes/reportes'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/auditoria', require('./routes/auditoria'));

// Endpoints publicos del contrato: /salud-integracion, /health, /api/estado
app.use(require('./routes/salud'));

// ------------------------------------------------------------------
// Frontend estatico (mismo origen: sin problemas de CORS)
// ------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// Cualquier otra ruta de API no encontrada responde con el sobre unico.
app.use('/api', (req, res) => {
  return fail(res, 404, 'NO_ENCONTRADO', 'Ruta no encontrada.');
});

// ------------------------------------------------------------------
// Manejo estandar de errores
// ------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (
    err &&
    (err.name === 'StoreError' ||
      err.name === 'SiaError' ||
      err.name === 'LocalAuthError')
  ) {
    return fail(res, err.status || 400, err.codigo || 'DATOS_INVALIDOS', err.message);
  }
  if (err && err.type === 'entity.parse.failed') {
    return fail(res, 400, 'DATOS_INVALIDOS', 'El cuerpo JSON enviado no es válido.');
  }
  console.error('[SIGELAB] Error interno:', err);
  return fail(res, 500, 'ERROR_INTERNO', 'Ocurrió un error interno en el servidor.');
});

const server = app.listen(config.port, () => {
  console.log('====================================================');
  console.log('  SIGELAB-INCOS · Demo de laboratorios e inventario');
  console.log('====================================================');
  console.log('  Demo:          http://127.0.0.1:' + config.port);
  console.log('  Nucleo SIA:    ' + config.siaUrl);
  console.log('  Almacenamiento:' + ' ' + store.backend);
  console.log(
    '  Cuentas locales: ' +
      (config.authDemoCodes ? 'modo demo (código en pantalla/consola)' : 'envío real')
  );
  console.log('  Salud:         http://127.0.0.1:' + config.port + '/salud-integracion');
  console.log('====================================================');
});

function cerrar() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);

module.exports = app;
