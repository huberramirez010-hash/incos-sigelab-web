'use strict';

const express = require('express');
const asyncHandler = require('../utils/async');
const { ok } = require('../utils/respuesta');
const sia = require('../sia/client');
const store = require('../db');
const { requireAuth } = require('../middleware/auth');
const { normalizarCargos } = require('../services/permisos');

const router = express.Router();

function extraerLista(cuerpo) {
  if (!cuerpo) return [];
  const datos = cuerpo.datos !== undefined ? cuerpo.datos : cuerpo;
  if (Array.isArray(datos)) return datos;
  if (datos && Array.isArray(datos.personas)) return datos.personas;
  if (datos && Array.isArray(datos.docentes)) return datos.docentes;
  if (datos && Array.isArray(datos.items)) return datos.items;
  return [];
}

function normalizarPersona(p) {
  const id = p.id || p.persona_id || p.personaId;
  const nombre =
    p.nombre_completo ||
    p.nombre ||
    [p.nombres, p.apellidos].filter(Boolean).join(' ');
  const cargos = normalizarCargos(p.cargos);
  return {
    id: id,
    persona_id: id,
    ci: p.ci || '',
    nombre_completo: nombre || '',
    nombres: p.nombres || '',
    apellidos: p.apellidos || '',
    cargo: cargos.length ? cargos.join(', ') : (p.cargo || 'Docente'),
  };
}

/**
 * GET /api/docentes
 * Lista docentes desde el SIA. Si el núcleo no responde, usa la caché local.
 */
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const params = new URLSearchParams();
    if (req.query.q) params.set('q', req.query.q);
    if (req.query.pagina) params.set('pagina', req.query.pagina);
    if (req.query.limite) params.set('limite', req.query.limite);

    const qs = params.toString();
    const ruta = '/api/v1/docentes' + (qs ? '?' + qs : '');

    try {
      const r = await sia.getConToken(ruta, req.token);
      if (r.ok) {
        const lista = extraerLista(r.data).map(normalizarPersona).filter((p) => p.persona_id);
        for (const p of lista) {
          await store.upsertCachePersona({
            persona_id: p.persona_id,
            ci: p.ci,
            nombres: p.nombres,
            apellidos: p.apellidos,
            nombre_completo: p.nombre_completo,
            cargo: p.cargo || 'Docente',
          });
        }
        const meta = r.data && r.data.meta ? r.data.meta : null;
        return ok(res, lista, { ...(meta || {}), origen: 'SIA' });
      }
    } catch (e) {
      // Sin conexión: se intenta la caché.
    }

    const cache = await store.listCachePersonas();
    const q = String(req.query.q || '').toLowerCase();
    let lista = cache.filter((p) => {
      const cargo = String(p.cargo || '').toLowerCase();
      return cargo.includes('docente');
    });
    if (!q) {
      // si no hay docentes cacheados, devolver toda la cache como fallback
      if (!lista.length) lista = cache.slice();
    } else {
      const base = lista.length ? lista : cache;
      lista = base.filter((p) => {
        return (
          String(p.nombre_completo || '').toLowerCase().includes(q) ||
          String(p.ci || '').includes(q)
        );
      });
    }
    return ok(
      res,
      lista.map((p) => ({
        id: p.persona_id,
        persona_id: p.persona_id,
        ci: p.ci,
        nombre_completo: p.nombre_completo,
        cargo: p.cargo,
      })),
      { origen: 'CACHE', aviso: 'Núcleo SIA no disponible: mostrando caché local.' }
    );
  })
);

module.exports = router;
