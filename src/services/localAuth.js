'use strict';

/**
 * Autenticacion local del SIGELAB.
 *
 * El SIA sigue siendo el proveedor institucional. Este modulo agrega
 * cuentas SIGELAB opcionales para el demo:
 *   - registro con Gmail + telefono
 *   - codigo de 4 digitos por correo y por WhatsApp
 *   - recuperacion de contrasena
 *
 * Las contrasenas se guardan con scrypt (sal aleatoria). Los codigos
 * se guardan como HMAC-SHA256, nunca en texto plano.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const config = require('../config');
const store = require('../db');
const email = require('./email');
const whatsapp = require('./whatsapp');

const ISSUER = 'sigelab-local';
const AUDIENCE = 'sigelab';

const TIPOS = {
  VERIFICAR_CORREO: 'VERIFICAR_CORREO',
  VERIFICAR_TELEFONO: 'VERIFICAR_TELEFONO',
  RECUPERAR_CLAVE: 'RECUPERAR_CLAVE',
};

const CANALES = {
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP',
};

const ESTADOS_SOLICITUD = {
  PENDIENTE: 'PENDIENTE',
  APROBADO: 'APROBADO',
  RECHAZADO: 'RECHAZADO',
};

// Roles que una persona puede solicitar al registrarse. El administrador
// revisa la solicitud y puede aprobar el rol pedido o asignar otro.
const ROLES_SOLICITUD = [
  {
    valor: 'CONSULTA',
    etiqueta: 'Consulta',
    descripcion: 'Solo lectura del inventario.',
    cargo: 'Consulta',
  },
  {
    valor: 'SERVICIO',
    etiqueta: 'Técnico de Laboratorio',
    descripcion: 'Consultar y cambiar el estado de los equipos.',
    cargo: 'Técnico de Laboratorio',
  },
  {
    valor: 'ADMINISTRATIVO',
    etiqueta: 'Encargado de Laboratorios',
    descripcion: 'Control total del inventario.',
    cargo: 'Encargado de Laboratorios',
  },
];

class LocalAuthError extends Error {
  constructor(codigo, mensaje, status) {
    super(mensaje);
    this.name = 'LocalAuthError';
    this.codigo = codigo || 'DATOS_INVALIDOS';
    this.status = status || 400;
  }
}

// ------------------------------------------------------------------
// Secreto para firmar sesiones locales.
// No se versiona: se genera una vez en data/local-jwt-secret.
// ------------------------------------------------------------------

function cargarSecreto() {
  if (process.env.JWT_LOCAL_SECRET) return process.env.JWT_LOCAL_SECRET;

  const archivo = path.join(__dirname, '..', '..', 'data', 'local-jwt-secret');
  try {
    if (fs.existsSync(archivo)) {
      const guardado = fs.readFileSync(archivo, 'utf8').trim();
      if (guardado) return guardado;
    }
    const nuevo = crypto.randomBytes(48).toString('hex');
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, nuevo, { encoding: 'utf8', mode: 0o600 });
    return nuevo;
  } catch (e) {
    // Ultimo recurso: las sesiones se invalidan al reiniciar el proceso.
    console.warn('[SIGELAB] No se pudo guardar el secreto local:', e.message);
    return crypto.randomBytes(48).toString('hex');
  }
}

const SECRETO = cargarSecreto();

// ------------------------------------------------------------------
// Validaciones
// ------------------------------------------------------------------

function normalizarCorreo(correo) {
  return String(correo || '').trim().toLowerCase();
}

function esCorreoGoogle(correo) {
  return /^[a-z0-9._%+-]+@(gmail\.com|googlemail\.com)$/i.test(String(correo || ''));
}

function normalizarTelefono(telefono) {
  let valor = String(telefono || '').trim().replace(/[^\d+]/g, '');
  if (!valor) return '';

  if (valor.startsWith('00')) valor = '+' + valor.slice(2);
  if (!valor.startsWith('+')) {
    if (/^591\d{8}$/.test(valor)) valor = '+' + valor;
    else if (/^\d{8}$/.test(valor)) valor = '+591' + valor;
    else valor = '+' + valor.replace(/\D/g, '');
  }

  const digitos = valor.replace(/\D/g, '');
  if (digitos.length < 8 || digitos.length > 15) return '';
  return '+' + digitos;
}

function validarNombre(nombre) {
  const valor = String(nombre || '').trim();
  if (valor.length < 3) return 'Ingrese su nombre completo.';
  if (valor.length > 120) return 'El nombre es demasiado largo.';
  return null;
}

function validarClave(clave) {
  const valor = String(clave || '');
  if (valor.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[A-Za-z]/.test(valor) || !/\d/.test(valor)) {
    return 'La contraseña debe incluir al menos una letra y un número.';
  }
  return null;
}

function normalizarRol(valor) {
  return String(valor || '').trim().toUpperCase();
}

function rolValido(valor) {
  return ROLES_SOLICITUD.some((r) => r.valor === valor);
}

function datosRol(valor) {
  return ROLES_SOLICITUD.find((r) => r.valor === valor) || ROLES_SOLICITUD[0];
}

function etiquetaRol(valor) {
  return datosRol(normalizarRol(valor)).etiqueta;
}

function cargoDeRol(valor) {
  return datosRol(normalizarRol(valor)).cargo;
}

/**
 * Una cuenta antigua (creada antes de este flujo) se considera aprobada si
 * ya estaba activa. Las cuentas nuevas siempre guardan estado_solicitud.
 */
function estadoSolicitud(user) {
  const estado = normalizarRol(user && user.estado_solicitud);
  if (
    estado === ESTADOS_SOLICITUD.PENDIENTE ||
    estado === ESTADOS_SOLICITUD.APROBADO ||
    estado === ESTADOS_SOLICITUD.RECHAZADO
  ) {
    return estado;
  }
  return user && user.activo
    ? ESTADOS_SOLICITUD.APROBADO
    : ESTADOS_SOLICITUD.PENDIENTE;
}

function rolSolicitadoDe(user) {
  const rol = normalizarRol(user && (user.rol_solicitado || user.rol));
  return rolValido(rol) ? rol : 'CONSULTA';
}

// ------------------------------------------------------------------
// Contrasenas
// ------------------------------------------------------------------

function hashPassword(clave) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(clave), sal, 64).toString('hex');
  return 'scrypt$' + sal + '$' + hash;
}

function verificarPassword(clave, almacenado) {
  try {
    const partes = String(almacenado || '').split('$');
    if (partes.length !== 3 || partes[0] !== 'scrypt') return false;
    const esperado = Buffer.from(partes[2], 'hex');
    const calculado = crypto.scryptSync(String(clave), partes[1], 64);
    return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------------
// Codigos
// ------------------------------------------------------------------

function generarCodigo() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

function hashCodigo(codigo, usuarioId, tipo, canal) {
  return crypto
    .createHmac('sha256', SECRETO)
    .update([String(codigo), String(usuarioId), String(tipo), String(canal)].join(':'))
    .digest('hex');
}

function mismoHash(a, b) {
  try {
    const ba = Buffer.from(String(a), 'hex');
    const bb = Buffer.from(String(b), 'hex');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (e) {
    return false;
  }
}

async function crearCodigo(user, tipo, canal) {
  const codigo = generarCodigo();
  const previo = await store.getCodigo(user.id, tipo, canal);
  await store.upsertCodigo({
    usuario_id: user.id,
    tipo,
    canal,
    destino: canal === CANALES.EMAIL ? user.correo : user.telefono,
    codigo_hash: hashCodigo(codigo, user.id, tipo, canal),
    expira_en: new Date(Date.now() + config.authCodigoExpiraMs).toISOString(),
    envios: previo ? Number(previo.envios || 1) + 1 : 1,
  });
  return codigo;
}

async function enviarCodigo(user, tipo, canal) {
  const codigo = await crearCodigo(user, tipo, canal);
  const resultado =
    canal === CANALES.EMAIL
      ? await email.enviarCodigo(user.correo, codigo, user.nombre_completo, tipo)
      : await whatsapp.enviarCodigo(user.telefono, codigo, user.nombre_completo, tipo);
  return { codigo, resultado };
}

async function validarCodigo(user, tipo, canal, codigo) {
  const registro = await store.getCodigo(user.id, tipo, canal);
  if (!registro) {
    throw new LocalAuthError('CODIGO_INVALIDO', 'Solicite un código nuevo.', 400);
  }
  if (registro.usado_en) {
    throw new LocalAuthError('CODIGO_USADO', 'El código ya fue utilizado.', 400);
  }
  if (new Date(registro.expira_en).getTime() < Date.now()) {
    throw new LocalAuthError('CODIGO_EXPIRADO', 'El código expiró. Solicite uno nuevo.', 400);
  }
  if (Number(registro.intentos) >= config.authCodigoMaxIntentos) {
    throw new LocalAuthError('CODIGO_BLOQUEADO', 'Demasiados intentos. Solicite un código nuevo.', 429);
  }

  const esperado = hashCodigo(String(codigo).trim(), user.id, tipo, canal);
  if (!mismoHash(esperado, registro.codigo_hash)) {
    await store.updateCodigo(user.id, tipo, canal, {
      intentos: Number(registro.intentos || 0) + 1,
    });
    throw new LocalAuthError('CODIGO_INVALIDO', 'El código no es correcto.', 400);
  }

  await store.updateCodigo(user.id, tipo, canal, {
    usado_en: new Date().toISOString(),
  });
  return true;
}

// ------------------------------------------------------------------
// Sesiones locales
// ------------------------------------------------------------------

function crearToken(user) {
  return jwt.sign(
    {
      sub: String(user.id),
      nombre: user.nombre_completo,
      correo: user.correo,
      telefono: user.telefono,
      roles: { SIGELAB: user.rol || 'CONSULTA' },
      cargos: cargosDeRol(user.rol),
      origen: 'LOCAL',
      tv: Number(user.token_version) || 0,
    },
    SECRETO,
    {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: config.localJwtExpira,
    }
  );
}

function cargosDeRol(rol) {
  return [cargoDeRol(rol)];
}

function esTokenLocal(token) {
  try {
    const payload = jwt.decode(token);
    return Boolean(payload && payload.iss === ISSUER);
  } catch (e) {
    return false;
  }
}

async function validarTokenLocal(token) {
  let payload;
  try {
    payload = jwt.verify(token, SECRETO, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch (e) {
    if (e && e.name === 'TokenExpiredError') {
      throw new LocalAuthError('TOKEN_EXPIRADO', 'La sesión expiró. Vuelva a ingresar.', 401);
    }
    throw new LocalAuthError('TOKEN_INVALIDO', 'Token inválido.', 401);
  }

  const user = await store.getUsuarioLocal(payload.sub);
  if (!user || !user.activo) {
    throw new LocalAuthError('CUENTA_INACTIVA', 'La cuenta está inactiva.', 401);
  }
  if (estadoSolicitud(user) !== ESTADOS_SOLICITUD.APROBADO) {
    throw new LocalAuthError(
      'SOLICITUD_PENDIENTE',
      'La solicitud de esta cuenta aún no fue aprobada por el administrador.',
      401
    );
  }
  if (Number(payload.tv) !== Number(user.token_version || 0)) {
    throw new LocalAuthError('TOKEN_INVALIDO', 'La sesión ya no es válida. Vuelva a ingresar.', 401);
  }

  return {
    persona_id: Number(user.persona_id),
    ci: '',
    nombre: user.nombre_completo,
    roles: { SIGELAB: user.rol || 'CONSULTA' },
    cargos: cargosDeRol(user.rol),
    correo: user.correo,
    telefono: user.telefono,
    origen: 'LOCAL',
    usuario_id: user.id,
  };
}

function datosPublicos(user) {
  const estado = estadoSolicitud(user);
  const rolSolicitado = rolSolicitadoDe(user);
  return {
    usuario_id: user.id,
    nombre_completo: user.nombre_completo,
    correo: user.correo,
    telefono: user.telefono,
    rol: user.rol || rolSolicitado,
    rol_solicitado: rolSolicitado,
    rol_solicitado_etiqueta: etiquetaRol(rolSolicitado),
    estado_solicitud: estado,
    activo: Boolean(user.activo),
    correo_verificado: Boolean(user.correo_verificado),
    telefono_verificado: Boolean(user.telefono_verificado),
    solicitud_en: user.solicitud_en || user.creado_en || null,
    aprobado_en: user.aprobado_en || null,
    rechazado_en: user.rechazado_en || null,
    motivo_rechazo: user.motivo_rechazo || '',
  };
}

// ------------------------------------------------------------------
// Flujos
// ------------------------------------------------------------------

async function registrar(datos) {
  const nombre = String(datos.nombre_completo || '').trim();
  const correo = normalizarCorreo(datos.correo);
  const telefono = normalizarTelefono(datos.telefono);
  const clave = String(datos.clave || '');
  const confirmar = String(datos.confirmar_clave || '');
  const rolSolicitado = normalizarRol(datos.rol_solicitado);

  const errorNombre = validarNombre(nombre);
  if (errorNombre) throw new LocalAuthError('DATOS_INVALIDOS', errorNombre, 400);

  if (!rolValido(rolSolicitado)) {
    throw new LocalAuthError(
      'ROL_REQUERIDO',
      'Seleccione el cargo o rol que solicita para su cuenta.',
      400
    );
  }

  if (!esCorreoGoogle(correo)) {
    throw new LocalAuthError(
      'CORREO_NO_GOOGLE',
      'Use un correo real de Google (@gmail.com).',
      400
    );
  }

  if (!telefono) {
    throw new LocalAuthError(
      'TELEFONO_INVALIDO',
      'Ingrese un número de WhatsApp válido con código de país. Ej: +591 71234567.',
      400
    );
  }

  const errorClave = validarClave(clave);
  if (errorClave) throw new LocalAuthError('CLAVE_DEBIL', errorClave, 400);
  if (clave !== confirmar) {
    throw new LocalAuthError('CLAVES_DISTINTAS', 'Las contraseñas no coinciden.', 400);
  }

  // En modo real no se crea una cuenta que no podra verificarse.
  if (!config.authDemoCodes) {
    if (!email.estaConfigurado()) {
      throw new LocalAuthError(
        'CORREO_NO_CONFIGURADO',
        'El envío de correo no está configurado. Contacte al administrador.',
        503
      );
    }
    if (!whatsapp.estaConfigurado()) {
      throw new LocalAuthError(
        'WHATSAPP_NO_CONFIGURADO',
        'El envío por WhatsApp no está configurado. Contacte al administrador.',
        503
      );
    }
  }

  const existente = await store.getUsuarioLocalPorCorreo(correo);
  const estadoExistente = existente ? estadoSolicitud(existente) : null;

  if (
    existente &&
    (existente.activo || estadoExistente === ESTADOS_SOLICITUD.APROBADO)
  ) {
    throw new LocalAuthError(
      'REGISTRO_DUPLICADO',
      'Ya existe una cuenta aprobada con ese correo. Inicie sesión o use "¿Olvidaste tu contraseña?".',
      400
    );
  }

  let user;
  if (existente) {
    // Una solicitud pendiente o rechazada puede volver a enviarse. Se
    // actualizan los datos, el rol pedido y se reinicia el estado.
    const porTelefono = await store.getUsuarioLocalPorTelefono(telefono);
    if (porTelefono && Number(porTelefono.id) !== Number(existente.id)) {
      throw new LocalAuthError(
        'REGISTRO_DUPLICADO',
        'Ese teléfono ya está registrado en otra cuenta.',
        400
      );
    }
    user = await store.updateUsuarioLocal(existente.id, {
      nombre_completo: nombre,
      telefono,
      password_hash: hashPassword(clave),
      rol_solicitado: rolSolicitado,
      rol: rolSolicitado,
      estado_solicitud: ESTADOS_SOLICITUD.PENDIENTE,
      solicitud_en: new Date().toISOString(),
      activo: false,
      correo_verificado: false,
      telefono_verificado: false,
      aprobado_en: null,
      aprobado_por_persona_id: null,
      aprobado_por_nombre: null,
      rechazado_en: null,
      rechazado_por_persona_id: null,
      rechazado_por_nombre: null,
      motivo_rechazo: null,
    });
  } else {
    user = await store.createUsuarioLocal({
      nombre_completo: nombre,
      correo,
      telefono,
      password_hash: hashPassword(clave),
      rol_solicitado: rolSolicitado,
      rol: rolSolicitado,
      estado_solicitud: ESTADOS_SOLICITUD.PENDIENTE,
      solicitud_en: new Date().toISOString(),
      activo: false,
    });
  }

  if (!user) {
    throw new LocalAuthError('ERROR_INTERNO', 'No fue posible crear la cuenta.', 500);
  }

  // Cache de nombre para que historial y auditoria muestren el nombre.
  await store.upsertCachePersona({
    persona_id: user.persona_id,
    ci: '',
    nombre_completo: user.nombre_completo,
    cargo: 'Cuenta local SIGELAB',
  });

  let envioCorreo;
  try {
    envioCorreo = await enviarCodigo(user, TIPOS.VERIFICAR_CORREO, CANALES.EMAIL);
  } catch (e) {
    console.error('[SIGELAB] Error enviando el código de correo:', e.message);
    throw new LocalAuthError(
      'ENVIO_CORREO_FALLIDO',
      'La cuenta fue creada, pero no se pudo enviar el código al correo. Intente registrarse nuevamente para reenviarlo.',
      502
    );
  }

  let envioWhatsapp;
  try {
    envioWhatsapp = await enviarCodigo(user, TIPOS.VERIFICAR_TELEFONO, CANALES.WHATSAPP);
  } catch (e) {
    // El correo es el canal que activa la cuenta. Si WhatsApp falla, no se
    // bloquea el registro: el usuario puede reenviar el código más tarde.
    console.error('[SIGELAB] Error enviando el código de WhatsApp:', e.message);
    envioWhatsapp = {
      codigo: null,
      resultado: { enviado: false, modo: 'ERROR', error: e.message },
    };
  }

  return {
    usuario: datosPublicos(user),
    envios: {
      correo: {
        enviado: envioCorreo.resultado.enviado,
        modo: envioCorreo.resultado.modo,
        destino: user.correo,
      },
      whatsapp: {
        enviado: envioWhatsapp.resultado.enviado,
        modo: envioWhatsapp.resultado.modo,
        destino: user.telefono,
      },
    },
    demo: config.authDemoCodes
      ? { correo: envioCorreo.codigo, whatsapp: envioWhatsapp.codigo }
      : null,
  };
}

async function verificarCodigo(usuarioId, canal, codigo) {
  const user = await store.getUsuarioLocal(usuarioId);
  if (!user) throw new LocalAuthError('NO_ENCONTRADO', 'La cuenta no existe.', 404);

  const canalNorm = String(canal || '').toUpperCase();

  if (canalNorm === CANALES.EMAIL) {
    await validarCodigo(user, TIPOS.VERIFICAR_CORREO, CANALES.EMAIL, codigo);
    // Sólo activa si la solicitud ya está aprobada. En modo pendiente, el usuario
    // estará sin activar hasta que el admin apruebe.
    const nuevoActivo = estadoSolicitud(user) === ESTADOS_SOLICITUD.APROBADO
      ? true
      : user.activo;  // si ya estaba activo, mantenlo; si no, no
    const actualizado = await store.updateUsuarioLocal(user.id, {
      correo_verificado: true,
      activo: nuevoActivo,
      token_version: Number(user.token_version || 0) + 1,
    });
    return { usuario: datosPublicos(actualizado), activo: nuevoActivo };
  }

  if (canalNorm === CANALES.WHATSAPP) {
    await validarCodigo(user, TIPOS.VERIFICAR_TELEFONO, CANALES.WHATSAPP, codigo);
    const actualizado = await store.updateUsuarioLocal(user.id, {
      telefono_verificado: true,
    });
    return { usuario: datosPublicos(actualizado), activo: Boolean(actualizado.activo) };
  }

  throw new LocalAuthError('CANAL_INVALIDO', 'Canal de verificación inválido.', 400);
}

async function reenviarCodigo(usuarioId, canal, tipo) {
  const canalNorm = String(canal || '').toUpperCase();
  if (canalNorm !== CANALES.EMAIL && canalNorm !== CANALES.WHATSAPP) {
    throw new LocalAuthError('CANAL_INVALIDO', 'Canal de envío inválido.', 400);
  }

  if (!config.authDemoCodes) {
    if (canalNorm === CANALES.EMAIL && !email.estaConfigurado()) {
      throw new LocalAuthError(
        'CORREO_NO_CONFIGURADO',
        'El envío de correo no está configurado.',
        503
      );
    }
    if (canalNorm === CANALES.WHATSAPP && !whatsapp.estaConfigurado()) {
      throw new LocalAuthError(
        'WHATSAPP_NO_CONFIGURADO',
        'El envío por WhatsApp no está configurado.',
        503
      );
    }
  }

  const user = await store.getUsuarioLocal(usuarioId);
  if (!user) throw new LocalAuthError('NO_ENCONTRADO', 'La cuenta no existe.', 404);

  const tipoNorm = String(tipo || 'VERIFICAR').toUpperCase();
  let tipoCodigo;
  if (tipoNorm === 'RECUPERAR') tipoCodigo = TIPOS.RECUPERAR_CLAVE;
  else if (canalNorm === CANALES.EMAIL) tipoCodigo = TIPOS.VERIFICAR_CORREO;
  else tipoCodigo = TIPOS.VERIFICAR_TELEFONO;

  const previo = await store.getCodigo(user.id, tipoCodigo, canalNorm);
  if (previo && Date.now() - new Date(previo.ultimo_envio_en).getTime() < config.authCodigoReenvioMs) {
    throw new LocalAuthError('ESPERAR', 'Espere un minuto antes de solicitar otro código.', 429);
  }
  if (previo && Number(previo.envios || 0) >= config.authCodigoMaxPorHora) {
    throw new LocalAuthError('LIMITE', 'Se alcanzó el límite de códigos. Intente más tarde.', 429);
  }

  const envio = await enviarCodigo(user, tipoCodigo, canalNorm);
  return {
    envio: {
      enviado: envio.resultado.enviado,
      modo: envio.resultado.modo,
      destino: canalNorm === CANALES.EMAIL ? user.correo : user.telefono,
    },
    demo: config.authDemoCodes ? { codigo: envio.codigo } : null,
  };
}

/**
 * Lista todas las cuentas locales con su estado de solicitud.
 * Se requiere autorización requireManage en el controlador.
 */
async function listarSolicitudes() {
  const usuarios = await store.listUsuariosLocal();
  return usuarios.map((u) => {
    const rolSol = normalizarRol(u.rol_solicitado || u.rol || 'CONSULTA');
    return {
      usuario_id: u.id,
      nombre_completo: u.nombre_completo,
      correo: u.correo,
      telefono: u.telefono,
      rol_solicitado: rolSol,
      rol_solicitado_etiqueta: u.rol_solicitado_etiqueta || etiquetaRol(rolSol),
      rol: u.rol,
      estado_solicitud: estadoSolicitud(u),
      correo_verificado: Boolean(u.correo_verificado),
      telefono_verificado: Boolean(u.telefono_verificado),
      activo: Boolean(u.activo),
      solicitud_en: u.solicitud_en || u.creado_en || null,
      aprobado_en: u.aprobado_en || null,
      rechazado_en: u.rechazado_en || null,
      motivo_rechazo: u.motivo_rechazo || '',
      aprobado_por_nombre: u.aprobado_por_nombre || '',
      rechazado_por_nombre: u.rechazado_por_nombre || '',
    };
  }).sort((a, b) => String(b.solicitud_en).localeCompare(String(a.solicitud_en)));
}

/**
 * Aprueba una solicitud de cuenta. El rol solicitado o el rol administrado
 * se guardan en el campo `rol`. El usuario se activa si su correo ya fue
 * verificado.
 */
async function aprobarSolicitud(usuarioId, rolAprobado, admin) {
  if (!rolValido(rolAprobado)) {
    throw new LocalAuthError('ROL_INVALIDO', 'Rol inválido para la aprobación.', 400);
  }
  const user = await store.getUsuarioLocal(usuarioId);
  if (!user) throw new LocalAuthError('NO_ENCONTRADO', 'La cuenta no existe.', 404);
  const estado = estadoSolicitud(user);
  if (estado !== ESTADOS_SOLICITUD.PENDIENTE) {
    throw new LocalAuthError(
      'SOLICITUD_YA_PROCESADA',
      'Esta solicitud ya fue ' + estado + '.',
      409
    );
  }

  const activo = Boolean(user.correo_verificado);
  const actualizado = await store.updateUsuarioLocal(usuarioId, {
    rol: rolAprobado,
    estado_solicitud: ESTADOS_SOLICITUD.APROBADO,
    activo: activo,
    aprobado_en: new Date().toISOString(),
    aprobado_por_persona_id: admin ? admin.persona_id : null,
    aprobado_por_nombre: admin ? admin.nombre : null,
    motivo_rechazo: null,
    token_version: Number(user.token_version || 0) + 1,
  });

  // Auditar la aprobación (si el store lo soporta).
  try {
    await store.addAuditoria({
      persona_id: admin ? admin.persona_id : null,
      accion: 'APROBAR_SOLICITUD',
      entidad: 'sigelab_usuarios',
      entidad_id: usuarioId,
      detalle: {
        nuevo_rol: rolAprobado,
        correo: user.correo,
        nombre: user.nombre_completo,
        aprobado_por: admin ? admin.nombre : null,
      },
    });
  } catch (e) {
    console.warn('[SIGELAB] No se pudo registrar la auditoría de aprobación:', e.message);
  }

  return { usuario: datosPublicos(actualizado) };
}

/**
 * Rechaza una solicitud de cuenta.
 */
async function rechazarSolicitud(usuarioId, motivo, admin) {
  const motivoLimpio = String(motivo || '').trim().slice(0, 300);
  const user = await store.getUsuarioLocal(usuarioId);
  if (!user) throw new LocalAuthError('NO_ENCONTRADO', 'La cuenta no existe.', 404);
  const estado = estadoSolicitud(user);
  if (estado !== ESTADOS_SOLICITUD.PENDIENTE) {
    throw new LocalAuthError(
      'SOLICITUD_YA_PROCESADA',
      'Esta solicitud ya fue ' + estado + '.',
      409
    );
  }

  const actualizado = await store.updateUsuarioLocal(usuarioId, {
    estado_solicitud: ESTADOS_SOLICITUD.RECHAZADO,
    activo: false,
    rechazado_en: new Date().toISOString(),
    rechazado_por_persona_id: admin ? admin.persona_id : null,
    rechazado_por_nombre: admin ? admin.nombre : null,
    motivo_rechazo: motivoLimpio || null,
    token_version: Number(user.token_version || 0) + 1,
  });

  // Auditar el rechazo
  try {
    await store.addAuditoria({
      persona_id: admin ? admin.persona_id : null,
      accion: 'RECHAZAR_SOLICITUD',
      entidad: 'sigelab_usuarios',
      entidad_id: usuarioId,
      detalle: {
        motivo: motivoLimpio,
        correo: user.correo,
        nombre: user.nombre_completo,
        rechazado_por: admin ? admin.nombre : null,
      },
    });
  } catch (e) {
    console.warn('[SIGELAB] No se pudo registrar la auditoría de rechazo:', e.message);
  }

  return { usuario: datosPublicos(actualizado) };
}

async function solicitarRecuperacion(identificador, canal) {
  const valor = String(identificador || '').trim();
  const canalNorm = String(canal || '').toUpperCase();

  if (!valor) throw new LocalAuthError('DATOS_INVALIDOS', 'Ingrese su correo o teléfono.', 400);
  if (canalNorm !== CANALES.EMAIL && canalNorm !== CANALES.WHATSAPP) {
    throw new LocalAuthError('CANAL_INVALIDO', 'Seleccione correo o WhatsApp.', 400);
  }

  if (!config.authDemoCodes) {
    if (canalNorm === CANALES.EMAIL && !email.estaConfigurado()) {
      throw new LocalAuthError(
        'CORREO_NO_CONFIGURADO',
        'El envío de correo no está configurado.',
        503
      );
    }
    if (canalNorm === CANALES.WHATSAPP && !whatsapp.estaConfigurado()) {
      throw new LocalAuthError(
        'WHATSAPP_NO_CONFIGURADO',
        'El envío por WhatsApp no está configurado.',
        503
      );
    }
  }

  const user = valor.includes('@')
    ? await store.getUsuarioLocalPorCorreo(valor)
    : await store.getUsuarioLocalPorTelefono(normalizarTelefono(valor));

  const generico = { enviado: true, canal: canalNorm, modo: 'GENERICO', demo: null };

  if (!user || !user.activo) return generico;
  if (canalNorm === CANALES.EMAIL && !user.correo) return generico;
  if (canalNorm === CANALES.WHATSAPP && !user.telefono) return generico;

  let envio;
  try {
    envio = await enviarCodigo(user, TIPOS.RECUPERAR_CLAVE, canalNorm);
  } catch (e) {
    console.error('[SIGELAB] No se pudo enviar el código de recuperación:', e.message);
    return generico;
  }

  // En modo real la respuesta debe ser identica exista o no la cuenta.
  if (!config.authDemoCodes) return generico;

  return {
    enviado: true,
    canal: canalNorm,
    modo: envio.resultado.modo,
    demo: { codigo: envio.codigo, usuario_id: user.id },
  };
}

async function restablecer(identificador, canal, codigo, nuevaClave, confirmarClave) {
  const valor = String(identificador || '').trim();
  const canalNorm = String(canal || '').toUpperCase();

  const errorClave = validarClave(nuevaClave);
  if (errorClave) throw new LocalAuthError('CLAVE_DEBIL', errorClave, 400);
  if (String(nuevaClave) !== String(confirmarClave)) {
    throw new LocalAuthError('CLAVES_DISTINTAS', 'Las contraseñas no coinciden.', 400);
  }

  const user = valor.includes('@')
    ? await store.getUsuarioLocalPorCorreo(valor)
    : await store.getUsuarioLocalPorTelefono(normalizarTelefono(valor));

  if (!user) throw new LocalAuthError('CODIGO_INVALIDO', 'El código no es correcto.', 400);

  await validarCodigo(user, TIPOS.RECUPERAR_CLAVE, canalNorm, codigo);
  const actualizado = await store.updateUsuarioLocal(user.id, {
    password_hash: hashPassword(nuevaClave),
    token_version: Number(user.token_version || 0) + 1,
  });
  return { usuario: datosPublicos(actualizado) };
}

async function loginLocal(identificador, clave) {
  const valor = String(identificador || '').trim();
  if (!valor || !clave) {
    throw new LocalAuthError('DATOS_INVALIDOS', 'Ingrese su correo o teléfono y su contraseña.', 400);
  }

  const user = valor.includes('@')
    ? await store.getUsuarioLocalPorCorreo(valor)
    : await store.getUsuarioLocalPorTelefono(normalizarTelefono(valor));

  if (!user || !verificarPassword(clave, user.password_hash)) {
    throw new LocalAuthError(
      'NO_AUTENTICADO',
      'Correo/teléfono o contraseña incorrectos.',
      401
    );
  }

  const estado = estadoSolicitud(user);

  if (estado === ESTADOS_SOLICITUD.PENDIENTE) {
    const rolEtiq = etiquetaRol(rolSolicitadoDe(user));
    throw new LocalAuthError(
      'SOLICITUD_PENDIENTE',
      'Su solicitud para el rol ' + rolEtiq + ' está pendiente de aprobación por el administrador.',
      403
    );
  }

  if (estado === ESTADOS_SOLICITUD.RECHAZADO) {
    const motivo = user.motivo_rechazo || '';
    const msg = motivo
      ? 'Su solicitud fue rechazada. ' + motivo
      : 'Su solicitud fue rechazada. Contacte al administrador.';
    throw new LocalAuthError(
      'SOLICITUD_RECHAZADA',
      msg,
      403
    );
  }

  if (!user.correo_verificado) {
    throw new LocalAuthError(
      'CORREO_NO_VERIFICADO',
      'Debe verificar su correo antes de iniciar sesión.',
      403
    );
  }

  if (!user.activo) {
    throw new LocalAuthError(
      'CUENTA_INACTIVA',
      'La cuenta aún no está verificada. Revise el código enviado a su correo.',
      403
    );
  }

  const actualizado = await store.updateUsuarioLocal(user.id, {
    ultimo_acceso: new Date().toISOString(),
  });

  const usuario = {
    persona_id: Number(user.persona_id),
    ci: '',
    nombre: user.nombre_completo,
    roles: { SIGELAB: user.rol || 'CONSULTA' },
    cargos: cargosDeRol(user.rol),
    correo: user.correo,
    telefono: user.telefono,
    origen: 'LOCAL',
    usuario_id: user.id,
  };

  return { token: crearToken(actualizado), usuario };
}

module.exports = {
  LocalAuthError,
  TIPOS,
  CANALES,
  ESTADOS_SOLICITUD,
  ROLES_SOLICITUD,
  registrar,
  verificarCodigo,
  reenviarCodigo,
  solicitarRecuperacion,
  restablecer,
  loginLocal,
  esTokenLocal,
  validarTokenLocal,
  normalizarCorreo,
  normalizarTelefono,
  esCorreoGoogle,
  listarSolicitudes,
  aprobarSolicitud,
  rechazarSolicitud,
};
