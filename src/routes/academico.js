'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const asyncHandler = require('../utils/async');
const { ok } = require('../utils/respuesta');
const sia = require('../sia/client');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'cache-academico.json');

function leerCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    return { carreras: [], cursos: [] };
  }
}

function guardarCache(parcial) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const actual = leerCache();
    const nuevo = Object.assign({}, actual, parcial, { actualizado_en: new Date().toISOString() });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(nuevo, null, 2), 'utf8');
  } catch (e) {
    // si falla el cache en disco, continuar sin interrumpir
  }
}

function extraerLista(cuerpo) {
  if (!cuerpo) return [];
  const datos = cuerpo.datos !== undefined ? cuerpo.datos : cuerpo;
  if (Array.isArray(datos)) return datos;
  if (datos && Array.isArray(datos.carreras)) return datos.carreras;
  if (datos && Array.isArray(datos.cursos)) return datos.cursos;
  if (datos && Array.isArray(datos.items)) return datos.items;
  return [];
}

/**
 * GET /api/academico/carreras
 * Lista carreras desde el SIA.
 */
router.get(
  '/carreras',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const r = await sia.getConToken('/api/v1/carreras', req.token);
      if (r.ok) {
        const lista = extraerLista(r.data);
        if (lista.length) guardarCache({ carreras: lista });
        const meta = r.data && r.data.meta ? r.data.meta : null;
        return ok(res, lista, { ...(meta || {}), origen: 'SIA' });
      }
    } catch (e) {
      // sin conexión
    }
    const cache = leerCache();
    const lista = Array.isArray(cache.carreras) ? cache.carreras : [];
    return ok(res, lista, { origen: 'CACHE', aviso: lista.length ? 'Mostrando carreras desde caché local.' : 'No se pudo obtener carreras del SIA.' });
  })
);

/**
 * GET /api/academico/cursos
 * Lista cursos desde el SIA. Puede filtrar por carrera_id si se envía.
 */
router.get(
  '/cursos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = new URLSearchParams();
    if (req.query.carrera_id) params.set('carrera_id', req.query.carrera_id);
    if (req.query.carreraId) params.set('carrera_id', req.query.carreraId);
    if (req.query.gestion_id) params.set('gestion_id', req.query.gestion_id);
    if (req.query.limite) params.set('limite', req.query.limite);
    if (req.query.pagina) params.set('pagina', req.query.pagina);
    const qs = params.toString();
    const ruta = '/api/v1/cursos' + (qs ? '?' + qs : '');

    try {
      const r = await sia.getConToken(ruta, req.token);
      if (r.ok) {
        let lista = extraerLista(r.data);
        // Guardar en caché la lista completa (sin filtrar por carrera)
        if (!req.query.carrera_id && !req.query.carreraId && lista.length) {
          guardarCache({ cursos: lista });
        }
        // Filtro local por carrera si el SIA no lo aplica
        const carreraId = req.query.carrera_id || req.query.carreraId;
        if (carreraId) {
          lista = lista.filter((c) => String(c.carreraId || c.carrera_id) === String(carreraId));
        }
        const meta = r.data && r.data.meta ? r.data.meta : null;
        return ok(res, lista, { ...(meta || {}), origen: 'SIA' });
      }
    } catch (e) {
      // sin conexión
    }
    const cache = leerCache();
    let lista = Array.isArray(cache.cursos) ? cache.cursos : [];
    const carreraId = req.query.carrera_id || req.query.carreraId;
    if (carreraId) {
      lista = lista.filter((c) => String(c.carreraId || c.carrera_id) === String(carreraId));
    }
    return ok(res, lista, { origen: 'CACHE', aviso: lista.length ? 'Mostrando cursos desde caché local.' : 'No se pudo obtener cursos del SIA.' });
  })
);

module.exports = router;
