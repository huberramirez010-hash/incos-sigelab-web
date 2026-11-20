'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const RAIZ = path.join(__dirname, '..');

// Precedencia: variables del proceso > .env.local > .env
// .env.local esta ignorado por Git y sirve para credenciales reales.
const entornoProceso = { ...process.env };
dotenv.config({ path: path.join(RAIZ, '.env') });

const archivoLocal = path.join(RAIZ, '.env.local');
if (fs.existsSync(archivoLocal)) {
  const valoresLocales = dotenv.parse(fs.readFileSync(archivoLocal, 'utf8'));
  for (const clave of Object.keys(valoresLocales)) {
    if (entornoProceso[clave] === undefined) {
      process.env[clave] = valoresLocales[clave];
    }
  }
}

/**
 * Configuracion central del demo SIGELAB-INCOS.
 * Toda direccion y puerto se lee del entorno (regla del contrato).
 */
const config = {
  // Identidad del sistema (debe coincidir con la clave del claim roles)
  sistema: 'SIGELAB',
  version: '1.0.0',

  // Servidor del demo
  port: parseInt(process.env.PORT || '4100', 10),

  // Nucleo SIA-INCOS (sin barra final)
  siaUrl: (process.env.API_ACADEMICO_URL || 'http://127.0.0.1:3000').replace(/\/+$/, ''),

  // Sigla con la que SIGELAB se identifica ante el SIA en cada llamada.
  // El SIA usa X-Sistema para saber que equipo esta conectado.
  siaSistema: (process.env.SIA_SISTEMA || 'SIGELAB').trim().toUpperCase() || 'SIGELAB',

  // Emisor esperado del JWT
  emisor: 'sia-incos',

  // Almacenamiento propio: auto | firestore | file
  dbBackend: (process.env.DB_BACKEND || 'auto').toLowerCase(),

  // Zona horaria oficial del ecosistema
  timezone: 'America/La_Paz',

  // Cache de la clave publica: 10 minutos (contrato 5.1)
  jwtCacheMs: 10 * 60 * 1000,

  // Cache del diagnostico del nucleo (evita golpear el SIA en cada request)
  estadoCacheMs: 10 * 1000,

  // Regla de negocio del SIGELAB (informativa segun la guia)
  maxEquiposPorSala: 20,

  // Timeout de llamadas al SIA
  siaTimeoutMs: parseInt(process.env.SIA_TIMEOUT_MS || '8000', 10),

  // ----------------------------------------------------------------
  // Cuentas locales SIGELAB (modulo adicional al SIA)
  // ----------------------------------------------------------------
  // En modo demo el codigo de 4 digitos se muestra en pantalla y en
  // la consola del servidor. Para envio real, configurar SMTP/WhatsApp
  // y AUTH_DEMO_CODES=false.
  authDemoCodes: String(process.env.AUTH_DEMO_CODES || 'true').toLowerCase() !== 'false',
  authCodigoExpiraMs: 10 * 60 * 1000,
  authCodigoMaxIntentos: 5,
  authCodigoReenvioMs: 60 * 1000,
  authCodigoMaxPorHora: 8,
  localJwtExpira: process.env.JWT_LOCAL_EXPIRA || '8h',

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: String(process.env.SMTP_SECURE || 'true').toLowerCase() !== 'false',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  },

  whatsapp: {
    provider: (process.env.WHATSAPP_PROVIDER || 'demo').toLowerCase(),
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: process.env.TWILIO_WHATSAPP_FROM || '',
    metaToken: process.env.META_WHATSAPP_TOKEN || '',
    metaPhoneId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || '',
    metaVersion: process.env.META_WHATSAPP_API_VERSION || 'v20.0',
  },
};

module.exports = config;
