'use strict';

const express = require('express');
const asyncHandler = require('../utils/async');
const { ok, creado, fail } = require('../utils/respuesta');
const sia = require('../sia/client');
const store = require('../db');
const localAuth = require('../services/localAuth');
const rateLimit = require('../services/rateLimit');
const email = require('../services/email');
const whatsapp = require('../services/whatsapp');
const { permisosDe } = require('../services/permisos');
const { requireAuth, requireManage } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();

function limitar(req, res, nombre, maximo, ventanaMs, mensaje) {
  const clave = nombre + ':' + (req.ip || 'local');
  if (!rateLimit.permitir(clave, maximo, ventanaMs)) {
    return fail(
      res,
      429,
      'DEMASIADOS_INTENTOS',
      mensaje || 'Demasiados intentos. Espere un momento antes de volver a intentar.'
    );
  }
  return null;
}

/**
 * POST /api/auth/login
 * Login institucional: el SIGELAB delega en el nucleo SIA.
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { identificador, clave } = req.body || {};
    if (!identificador || !clave) {
      return fail(res, 400, 'DATOS_INVALIDOS', 'Ingrese su cédula o correo y su contraseña.');
    }

    let sesion;
    try {
      sesion = await sia.login(String(identificador).trim(), String(clave));
    } catch (e) {
      if (e instanceof sia.SiaError) {
        return fail(res, e.status, e.codigo, e.message);
      }
      throw e;
    }

    // Validacion local de firma RS256, emisor y expiracion.
    let payload;
    try {
      payload = await sia.verifyToken(sesion.token);
    } catch (e) {
      if (e instanceof sia.SiaError) {
        return fail(res, e.status, e.codigo, e.message);
      }
      throw e;
    }

    const user = sia.usuarioDesdeToken(payload);
    const permisos = permisosDe(user);

    if (!permisos.canRead) {
      return fail(res, 403, 'SIN_PERMISO', 'La cuenta no tiene acceso al sistema SIGELAB.');
    }

    // Cache de lectura (nombre/cargo). Nunca decide permisos.
    await store.upsertCachePersona({
      persona_id: user.persona_id,
      ci: user.ci,
      nombre: user.nombre,
      cargo: permisos.cargos.join(', '),
    });

    return ok(res, {
      token: sesion.token,
      usuario: {
        persona_id: user.persona_id,
        ci: user.ci,
        nombre: user.nombre,
        roles: user.roles,
        cargos: permisos.cargos,
      },
      permisos,
    });
  })
);

/**
 * POST /api/auth/login-local
 * Login con cuenta SIGELAB (Gmail o telefono + contrasena).
 */
router.post(
  '/login-local',
  asyncHandler(async (req, res) => {
    const bloqueo = limitar(
      req,
      res,
      'login-local',
      10,
      15 * 60 * 1000,
      'Demasiados intentos de ingreso. Espere 15 minutos.'
    );
    if (bloqueo) return bloqueo;

    const { identificador, clave } = req.body || {};
    const sesion = await localAuth.loginLocal(identificador, clave);
    const permisos = permisosDe(sesion.usuario);
    return ok(res, {
      token: sesion.token,
      usuario: sesion.usuario,
      permisos,
    });
  })
);

/**
 * POST /api/auth/registro
 * Crea una cuenta SIGELAB y envia codigos de 4 digitos al Gmail y WhatsApp.
 */
router.post(
  '/registro',
  asyncHandler(async (req, res) => {
    const bloqueo = limitar(
      req,
      res,
      'registro',
      20,
      60 * 60 * 1000,
      'Demasiados registros desde esta conexión. Intente más tarde.'
    );
    if (bloqueo) return bloqueo;

    const datos = await localAuth.registrar(req.body || {});
    return creado(res, datos);
  })
);

/**
 * POST /api/auth/verificar-codigo
 * Verifica el codigo de correo (activa la cuenta) o de WhatsApp.
 */
router.post(
  '/verificar-codigo',
  asyncHandler(async (req, res) => {
    const bloqueo = limitar(
      req,
      res,
      'verificar-codigo',
      30,
      15 * 60 * 1000,
      'Demasiados intentos de verificación. Espere unos minutos.'
    );
    if (bloqueo) return bloqueo;

    const { usuario_id, canal, codigo } = req.body || {};
    if (!usuario_id || !canal || !codigo) {
      return fail(res, 400, 'DATOS_INVALIDOS', 'Indique la cuenta, el canal y el código.');
    }

    const datos = await localAuth.verificarCodigo(usuario_id, canal, codigo);
    return ok(res, datos);
  })
);

/**
 * POST /api/auth/reenviar-codigo
 */
router.post(
  '/reenviar-codigo',
  asyncHandler(async (req, res) => {
    const bloqueo = limitar(
      req,
      res,
      'reenviar-codigo',
      15,
      60 * 60 * 1000,
      'Demasiados reenvíos. Intente más tarde.'
    );
    if (bloqueo) return bloqueo;

    const { usuario_id, canal, tipo } = req.body || {};
    if (!usuario_id || !canal) {
      return fail(res, 400, 'DATOS_INVALIDOS', 'Indique la cuenta y el canal.');
    }

    const datos = await localAuth.reenviarCodigo(usuario_id, canal, tipo);
    return ok(res, datos);
  })
);

/**
 * POST /api/auth/recuperar
 * Solicita un codigo de recuperacion. La respuesta es generica para no
 * revelar si el correo/telefono esta registrado.
 */
router.post(
  '/recuperar',
  asyncHandler(async (req, res) => {
    const bloqueo = limitar(
      req,
      res,
      'recuperar',
      6,
      60 * 60 * 1000,
      'Demasiadas solicitudes. Intente más tarde.'
    );
    if (bloqueo) return bloqueo;

    const { identificador, canal } = req.body || {};
    const datos = await localAuth.solicitarRecuperacion(identificador, canal);
    return ok(res, datos);
  })
);

/**
 * POST /api/auth/restablecer
 * Cambia la contrasena usando el codigo de recuperacion.
 */
router.post(
  '/restablecer',
  asyncHandler(async (req, res) => {
    const bloqueo = limitar(
      req,
      res,
      'restablecer',
      12,
      60 * 60 * 1000,
      'Demasiados intentos. Intente más tarde.'
    );
    if (bloqueo) return bloqueo;

    const { identificador, canal, codigo, nueva_clave, confirmar_clave } = req.body || {};
    if (!identificador || !canal || !codigo || !nueva_clave) {
      return fail(res, 400, 'DATOS_INVALIDOS', 'Complete todos los datos para restablecer la contraseña.');
    }

    const datos = await localAuth.restablecer(
      identificador,
      canal,
      codigo,
      nueva_clave,
      confirmar_clave
    );
    return ok(res, datos);
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    return ok(res, { usuario: req.user, permisos: req.permisos });
  })
);

// Informacion publica para la pantalla de ingreso y el registro.
router.get('/config', (req, res) => {
  return ok(res, {
    sistema: config.sistema,
    version: config.version,
    siaUrl: config.siaUrl,
    puerto: config.port,
    authLocal: true,
    registroHabilitado: true,
    demoCodigos: config.authDemoCodes,
    smtpConfigurado: email.estaConfigurado(),
    whatsappConfigurado: whatsapp.estaConfigurado(),
    whatsappProveedor: config.whatsapp.provider,
    correoGoogle: true,
    telefonoPais: '+591',
    rolesSolicitud: localAuth.ROLES_SOLICITUD,
  });
});

/**
 * GET /api/auth/solicitudes
 * Lista todas las solicitudes pendientes y aprobadas/rechazadas.
 * Requiere login (local o SIA) y rol de Encargado (canManage).
 */
router.get(
  '/solicitudes',
  requireAuth,
  requireManage,
  asyncHandler(async (req, res) => {
    const solicitudes = await localAuth.listarSolicitudes();
    return ok(res, { solicitudes });
  })
);

/**
 * POST /api/auth/solicitudes/:id/aprobar
 * Aprueba una solicitud de cuenta. El administrador puede asignar un rol.
 */
router.post(
  '/solicitudes/:id/aprobar',
  requireAuth,
  requireManage,
  asyncHandler(async (req, res) => {
    const { rol } = req.body || {};
    const admin = req.user;
    const datos = await localAuth.aprobarSolicitud(req.params.id, rol, admin);
    return ok(res, datos);
  })
);

/**
 * POST /api/auth/solicitudes/:id/rechazar
 * Rechaza una solicitud de cuenta.
 */
router.post(
  '/solicitudes/:id/rechazar',
  requireAuth,
  requireManage,
  asyncHandler(async (req, res) => {
    const { motivo } = req.body || {};
    const admin = req.user;
    const datos = await localAuth.rechazarSolicitud(req.params.id, motivo, admin);
    return ok(res, datos);
  })
);

module.exports = router;
