'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Cliente del nucleo SIA-INCOS.
 *
 * Reglas del contrato:
 *  - El login se hace contra POST /api/v1/auth/ingresar.
 *  - El token se valida LOCALMENTE (RS256) con la clave publica.
 *  - La clave publica se cachea 10 minutos.
 *  - Si el nucleo no responde, se usa la clave cacheada y se sigue en modo lectura.
 */

class SiaError extends Error {
  constructor(mensaje, opciones) {
    super(mensaje);
    const o = opciones || {};
    this.name = 'SiaError';
    this.status = o.status || 502;
    this.codigo = o.codigo || 'ERROR_INTERNO';
    this.datos = o.datos || null;
  }
}

const state = {
  // El SIA puede rotar el par RSA y publicar varios `kid` en el JWKS.
  // Se cachea una clave por kid, mas una clave por defecto (endpoint PEM).
  keys: new Map(),
  defaultPem: null,
  defaultAt: 0,
  claveCacheada: false,
  ultimaValidacion: null,
  ultimoKid: null,
};

async function fetchJson(url, opciones, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || config.siaTimeoutMs);
  try {
    // Todas las llamadas al SIA (login, JWKS, estado, personas, cargos)
    // llevan la sigla del sistema para que el panel del SIA identifique
    // el origen. Sin este header la actividad aparece como SIN IDENTIFICAR.
    const opcionesFinales = { ...(opciones || {}) };
    opcionesFinales.headers = {
      'X-Sistema': config.siaSistema,
      ...((opciones && opciones.headers) || {}),
    };
    opcionesFinales.signal = controller.signal;
    const res = await fetch(url, opcionesFinales);
    const texto = await res.text();
    let data = null;
    if (texto) {
      try {
        data = JSON.parse(texto);
      } catch (e) {
        data = texto;
      }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

function extraerPem(cuerpo) {
  if (!cuerpo) return null;
  if (typeof cuerpo === 'string') {
    return cuerpo.includes('BEGIN PUBLIC KEY') ? cuerpo : null;
  }
  if (typeof cuerpo === 'object') {
    const candidatos = [
      cuerpo.clave,
      cuerpo.publicKey,
      cuerpo.clave_publica,
      cuerpo.clavePublica,
      cuerpo.public_key,
      cuerpo.datos,
    ];
    for (const c of candidatos) {
      const pem = extraerPem(c);
      if (pem) return pem;
    }
  }
  return null;
}

function guardarClave(pem, kid) {
  const ahoraMs = Date.now();
  if (kid) {
    state.keys.set(String(kid), { pem, at: ahoraMs });
    state.ultimoKid = String(kid);
  } else {
    state.defaultPem = pem;
    state.defaultAt = ahoraMs;
  }
  state.claveCacheada = true;
}

function kidDelToken(token) {
  try {
    const decodificado = jwt.decode(token, { complete: true });
    return (decodificado && decodificado.header && decodificado.header.kid) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Convierte una entrada JWKS a PEM.
 *
 * El SIA de produccion publica en `n` la clave SPKI/DER completa codificada
 * en base64 (no el modulo puro como exige el estandar JWK). Se detecta ese
 * formato y se parsea como DER; si no, se usa el formato JWK estandar.
 */
function jwkAPem(jwk) {
  if (!jwk || !jwk.n) return null;

  try {
    const der = Buffer.from(String(jwk.n), 'base64');
    if (der.length > 4 && der[0] === 0x30 && der[1] === 0x82) {
      return crypto
        .createPublicKey({ key: der, format: 'der', type: 'spki' })
        .export({ type: 'spki', format: 'pem' });
    }
  } catch (e) {
    // No era DER: se intenta el formato JWK estandar.
  }

  try {
    return crypto
      .createPublicKey({ key: jwk, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' });
  } catch (e) {
    return null;
  }
}

/**
 * Obtiene la clave publica adecuada para el token.
 * - Si el token trae `kid`, se busca esa clave exacta en el JWKS.
 * - Si no, se usa la primera clave o el endpoint PEM.
 * - `forzar` ignora la cache (se usa cuando el SIA rota el par RSA).
 */
async function getPublicKeyPem(forzar, kid) {
  const ahoraMs = Date.now();
  const kidStr = kid ? String(kid) : null;

  if (!forzar) {
    if (kidStr && state.keys.has(kidStr)) {
      const entrada = state.keys.get(kidStr);
      if (ahoraMs - entrada.at < config.jwtCacheMs) return entrada.pem;
    }
    if (!kidStr && state.defaultPem && ahoraMs - state.defaultAt < config.jwtCacheMs) {
      return state.defaultPem;
    }
  }

  // 1) JWKS: fuente recomendada y permite seleccionar por kid.
  try {
    const r = await fetchJson(config.siaUrl + '/.well-known/jwks.json');
    const jwks = r.data && r.data.datos ? r.data.datos : r.data;
    const claves = jwks && Array.isArray(jwks.keys) ? jwks.keys : [];
    if (claves.length) {
      let jwk = null;
      if (kidStr) {
        jwk = claves.find((k) => String(k.kid) === kidStr) || null;
      }
      if (!jwk && !kidStr) jwk = claves[0];
      // Si el emisor publica una sola clave, se acepta aunque el kid no
      // coincida exactamente (tolerancia ante cambios de nombre).
      if (!jwk && claves.length === 1) jwk = claves[0];

      if (jwk) {
        const pem = jwkAPem(jwk);
        if (pem) {
          guardarClave(pem, jwk.kid ? String(jwk.kid) : null);
          return pem;
        }
      }
    }
  } catch (e) {
    // Se intenta el endpoint PEM como respaldo.
  }

  // 2) Respaldo: endpoint PEM (no informa kid).
  try {
    const r = await fetchJson(config.siaUrl + '/api/v1/auth/clave-publica');
    const pem = extraerPem(r.data);
    if (pem) {
      guardarClave(pem, null);
      return pem;
    }
  } catch (e) {
    // Sin conexion: se usan las claves cacheadas, aunque esten vencidas.
  }

  if (kidStr && state.keys.has(kidStr)) return state.keys.get(kidStr).pem;
  if (state.defaultPem) return state.defaultPem;
  if (state.keys.size) return state.keys.values().next().value.pem;

  throw new SiaError('No se pudo obtener la clave pública del núcleo SIA.', {
    status: 503,
    codigo: 'SIN_CONEXION',
  });
}

async function login(identificador, clave) {
  let respuesta;
  try {
    respuesta = await fetchJson(config.siaUrl + '/api/v1/auth/ingresar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identificador, clave }),
    });
  } catch (e) {
    throw new SiaError('No se pudo conectar con el núcleo SIA. Verifique su conexión.', {
      status: 503,
      codigo: 'SIN_CONEXION',
    });
  }

  const cuerpo = respuesta.data;

  if (!respuesta.ok) {
    const error = (cuerpo && cuerpo.error) || {};
    throw new SiaError(error.mensaje || 'No fue posible iniciar sesión.', {
      status: respuesta.status,
      codigo: error.codigo || 'NO_AUTENTICADO',
      datos: cuerpo,
    });
  }

  const datos = cuerpo && cuerpo.datos !== undefined ? cuerpo.datos : cuerpo;
  const token = datos && (datos.token || datos.jwt || datos.access_token);
  const persona = (datos && (datos.persona || datos.usuario)) || null;

  if (!token) {
    throw new SiaError('El núcleo no devolvió un token válido.', {
      status: 502,
      codigo: 'ERROR_INTERNO',
    });
  }

  return { token, persona, datos };
}

function verificarCon(pem, token) {
  return jwt.verify(token, pem, {
    algorithms: ['RS256'],
    issuer: config.emisor,
    clockTolerance: 30,
  });
}

async function verifyToken(token) {
  const kid = kidDelToken(token);
  if (kid) state.ultimoKid = kid;

  let pem = await getPublicKeyPem(false, kid);
  let ultimoError = null;
  let payload = null;

  try {
    payload = verificarCon(pem, token);
  } catch (e) {
    // La clave pudo haber rotado en el nucleo: se fuerza una actualizacion
    // (buscando el kid exacto) y se reintenta una sola vez.
    ultimoError = e;
    try {
      pem = await getPublicKeyPem(true, kid);
      payload = verificarCon(pem, token);
      ultimoError = null;
    } catch (e2) {
      ultimoError = e2;
    }
  }

  if (payload) {
    state.ultimaValidacion = {
      valida: true,
      emisor: config.emisor,
      cuando: new Date().toISOString(),
    };
    return payload;
  }

  state.ultimaValidacion = {
    valida: false,
    emisor: config.emisor,
    cuando: new Date().toISOString(),
    motivo: ultimoError ? ultimoError.message : 'Token inválido',
  };

  if (ultimoError && ultimoError.name === 'TokenExpiredError') {
    throw new SiaError('El token expiró. Vuelva a ingresar.', {
      status: 401,
      codigo: 'TOKEN_EXPIRADO',
    });
  }
  throw new SiaError('Token inválido.', {
    status: 401,
    codigo: 'TOKEN_INVALIDO',
  });
}

let estadoCache = { valor: 'SIN_CONEXION', at: 0 };

async function estadoNucleo(forzar) {
  const ahoraMs = Date.now();
  if (!forzar && ahoraMs - estadoCache.at < config.estadoCacheMs) {
    return estadoCache.valor;
  }
  let valor = 'SIN_CONEXION';
  try {
    const r = await fetchJson(config.siaUrl + '/api/v1/estado', {}, 5000);
    if (r.ok) valor = 'CONECTADO';
  } catch (e) {
    valor = 'SIN_CONEXION';
  }
  estadoCache = { valor, at: Date.now() };
  return valor;
}

async function getConToken(rutaRelativa, token) {
  return fetchJson(config.siaUrl + rutaRelativa, {
    headers: { Authorization: 'Bearer ' + token },
  });
}

function usuarioDesdeToken(payload) {
  if (!payload) return null;
  return {
    persona_id: Number(payload.sub),
    ci: payload.ci || '',
    nombre:
      payload.nombre ||
      [payload.nombres, payload.apellidos].filter(Boolean).join(' '),
    roles: payload.roles || {},
    cargos: payload.cargos || [],
  };
}

function estadoJwt() {
  // Si hubo una verificacion explicita, manda ese resultado.
  // Si aun no se verifico ningun token, se reporta si la clave publica esta disponible.
  return {
    valida: state.ultimaValidacion
      ? Boolean(state.ultimaValidacion.valida)
      : Boolean(state.claveCacheada),
    emisor: config.emisor,
    claveCacheada: state.claveCacheada,
    kid: state.ultimoKid || null,
  };
}

module.exports = {
  SiaError,
  login,
  verifyToken,
  estadoNucleo,
  getConToken,
  usuarioDesdeToken,
  estadoJwt,
  getPublicKeyPem,
};
