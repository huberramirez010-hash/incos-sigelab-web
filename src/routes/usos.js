'use strict';

const express = require('express');
const asyncHandler = require('../utils/async');
const { ok, creado, fail } = require('../utils/respuesta');
const store = require('../db');
const { requireAuth, requireManage } = require('../middleware/auth');
const { mapaNombres } = require('../services/nombres');

const router = express.Router();

const SLOTS = [
  { valor: 'TARDE', etiqueta: 'Tarde (18:00-19:30)', hora_inicio: '18:00', hora_fin: '19:30' },
  { valor: 'NOCHE_1', etiqueta: 'Noche (19:30-21:00)', hora_inicio: '19:30', hora_fin: '21:00' },
  { valor: 'NOCHE_2', etiqueta: 'Noche (21:00-22:30)', hora_inicio: '21:00', hora_fin: '22:30' },
];

const ESTADOS = ['EN_USO', 'FINALIZADO', 'CANCELADO'];

function slotPorValor(valor) {
  return SLOTS.find((s) => s.valor === String(valor));
}

function fechaValida(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(valor || ''));
}

async function enriquecer(usos) {
  const ambientes = await store.listAmbientes();
  const mapaAmb = {};
  for (const a of ambientes) mapaAmb[Number(a.id)] = a;
  const nombres = await mapaNombres();
  return usos.map((u) => {
    const amb = mapaAmb[Number(u.ambiente_id)] || null;
    const slot = slotPorValor(u.turno);
    return {
      ...u,
      ambiente_codigo: amb ? amb.codigo : '',
      ambiente_nombre: amb ? amb.nombre : '',
      persona_nombre: nombres[Number(u.persona_id)] || null,
      turno_etiqueta: slot ? slot.etiqueta : u.turno,
    };
  });
}

router.get(
  '/catalogos',
  requireAuth,
  requireManage,
  (req, res) => {
    return ok(res, { turnos: SLOTS, estados: ESTADOS });
  }
);

router.get(
  '/',
  requireAuth,
  requireManage,
  asyncHandler(async (req, res) => {
    const filtros = {
      ambiente_id: req.query.ambiente_id,
      persona_id: req.query.persona_id,
      carrera_id: req.query.carrera_id,
      curso_id: req.query.curso_id,
      fecha: req.query.fecha,
      fecha_desde: req.query.fecha_desde,
      fecha_hasta: req.query.fecha_hasta,
      turno: req.query.turno,
      estado: req.query.estado,
      incluir_inactivos: req.query.incluir_inactivos,
    };
    const usos = await store.listUsos(filtros);
    const datos = await enriquecer(usos);
    return ok(res, datos, { total: datos.length });
  })
);

router.post(
  '/',
  requireAuth,
  requireManage,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const ambienteId = Number(body.ambiente_id);
    const personaId = Number(body.persona_id);
    const fecha = String(body.fecha || '').slice(0, 10);

    // Soporta un turno o múltiples turnos (para docentes con más de un horario)
    let turnosReq = [];
    if (Array.isArray(body.turnos)) turnosReq = body.turnos;
    else if (body.turno) turnosReq = [body.turno];
    // normalizar, únicos, válidos
    const valoresTurno = [...new Set(turnosReq.map((t) => String(t)).filter(Boolean))];
    const slots = valoresTurno.map(slotPorValor).filter(Boolean);

    if (!ambienteId) return fail(res, 400, 'DATOS_INVALIDOS', 'Seleccione un laboratorio/ambiente.');
    if (!personaId) return fail(res, 400, 'DATOS_INVALIDOS', 'Seleccione el docente que utiliza el laboratorio.');
    if (!fechaValida(fecha)) return fail(res, 400, 'DATOS_INVALIDOS', 'La fecha no es válida (use AAAA-MM-DD).');
    if (!slots.length) return fail(res, 400, 'DATOS_INVALIDOS', 'Seleccione al menos un turno/horario.');

    const ambiente = await store.getAmbiente(ambienteId);
    if (!ambiente) return fail(res, 404, 'NO_ENCONTRADO', 'El ambiente no existe.');
    if (ambiente.activo === false) return fail(res, 400, 'DATOS_INVALIDOS', 'El ambiente está inactivo.');

    const existentes = await store.listUsos({ ambiente_id: ambienteId, fecha });

    // Cachear nombre del docente si viene en la solicitud
    if (body.persona_nombre) {
      await store.upsertCachePersona({
        persona_id: personaId,
        nombre_completo: body.persona_nombre,
        cargo: body.persona_cargo || 'Docente',
      });
    }

    const creados = [];
    const conflictos = [];

    for (const slot of slots) {
      const conflicto = existentes.find(
        (u) => u.activo !== false && u.turno === slot.valor && u.estado !== 'CANCELADO'
      );
      if (conflicto) {
        conflictos.push(slot.etiqueta || slot.valor);
        continue;
      }

      const uso = await store.createUso({
        ambiente_id: ambienteId,
        persona_id: personaId,
        carrera_id: body.carrera_id || null,
        carrera_nombre: String(body.carrera_nombre || '').trim(),
        curso_id: body.curso_id || null,
        curso_nombre: String(body.curso_nombre || '').trim(),
        fecha,
        turno: slot.valor,
        hora_inicio: slot.hora_inicio,
        hora_fin: slot.hora_fin,
        estado: 'EN_USO',
        observaciones: String(body.observaciones || '').trim(),
        registrado_por_persona_id: req.user.persona_id,
      });

      await store.addAuditoria({
        persona_id: req.user.persona_id,
        accion: 'REGISTRO_USO',
        entidad: 'USO_AMBIENTE',
        entidad_id: uso.id,
      });

      creados.push(uso);
      // agregar a existentes en memoria para evitar duplicados dentro del mismo lote
      existentes.push(uso);
    }

    if (!creados.length) {
      return fail(
        res,
        409,
        'CONFLICTO',
        'Los turnos seleccionados ya tienen un uso registrado en esa fecha y laboratorio: ' + conflictos.join(', ') + '.'
      );
    }

    const enriquecidos = await enriquecer(creados);
    const meta = { creados: creados.length };
    if (conflictos.length) {
      meta.avisos = ['No se registraron estos turnos porque ya estaban ocupados: ' + conflictos.join(', ')];
    }
    return creado(res, enriquecidos.length === 1 ? enriquecidos[0] : enriquecidos, meta);
  })
);

router.post(
  '/:id/finalizar',
  requireAuth,
  requireManage,
  asyncHandler(async (req, res) => {
    const uso = await store.getUso(req.params.id);
    if (!uso || uso.activo === false) return fail(res, 404, 'NO_ENCONTRADO', 'El registro de uso no existe.');
    if (uso.estado === 'FINALIZADO') return fail(res, 400, 'DATOS_INVALIDOS', 'El uso ya está finalizado.');
    if (uso.estado === 'CANCELADO') return fail(res, 400, 'DATOS_INVALIDOS', 'El uso está cancelado.');

    const actualizado = await store.updateUso(req.params.id, {
      estado: 'FINALIZADO',
      observaciones: req.body && req.body.observaciones !== undefined
        ? String(req.body.observaciones || '').trim()
        : uso.observaciones,
    });

    await store.addAuditoria({
      persona_id: req.user.persona_id,
      accion: 'FINALIZAR_USO',
      entidad: 'USO_AMBIENTE',
      entidad_id: actualizado.id,
    });

    const [enriquecido] = await enriquecer([actualizado]);
    return ok(res, enriquecido);
  })
);

router.delete(
  '/:id',
  requireAuth,
  requireManage,
  asyncHandler(async (req, res) => {
    const uso = await store.getUso(req.params.id);
    if (!uso || uso.activo === false) return fail(res, 404, 'NO_ENCONTRADO', 'El registro de uso no existe.');

    const actualizado = await store.updateUso(req.params.id, {
      activo: false,
      estado: 'CANCELADO',
    });

    await store.addAuditoria({
      persona_id: req.user.persona_id,
      accion: 'CANCELAR_USO',
      entidad: 'USO_AMBIENTE',
      entidad_id: actualizado.id,
    });

    return ok(res, { id: actualizado.id, estado: 'CANCELADO' });
  })
);

module.exports = router;
