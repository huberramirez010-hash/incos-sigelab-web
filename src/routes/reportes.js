'use strict';

const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const asyncHandler = require('../utils/async');
const { fail } = require('../utils/respuesta');
const store = require('../db');
const { requireAuth } = require('../middleware/auth');
const { mapaNombres } = require('../services/nombres');

const router = express.Router();

function nombreArchivo(base, ext) {
  const fecha = new Date().toISOString().slice(0, 10);
  return `${base}_${fecha}.${ext}`;
}

async function enviarXlsx(res, nombre, hojas) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SIGELAB-INCOS';
  wb.created = new Date();
  for (const hoja of hojas) {
    const ws = wb.addWorksheet(hoja.nombre || 'Reporte');
    ws.columns = (hoja.columnas || []).map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width || 20,
    }));
    ws.addRows(hoja.filas || []);
    // estilo encabezado
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle' };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: (hoja.columnas || []).length || 1 },
    };
  }
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(Buffer.from(buffer));
}

function enviarPdf(res, nombre, titulo, columnas, filas) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => {
    const pdf = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.send(pdf);
  });

  doc.fontSize(16).text(titulo, { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#555').text(`Generado: ${new Date().toLocaleString('es-BO')}`, { align: 'left' });
  doc.moveDown(0.8);
  doc.fillColor('#000');

  const headers = columnas.map((c) => c.header);
  const keys = columnas.map((c) => c.key);
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = pageWidth / Math.max(headers.length, 1);

  function drawRow(values, opts) {
    const options = opts || {};
    const yStart = doc.y;
    const rowHeight = 16;
    // nueva página si es necesario
    if (yStart + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
    const y = doc.y;
    doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    values.forEach((v, i) => {
      const x = doc.page.margins.left + i * colWidth;
      const text = String(v == null ? '' : v);
      doc.text(text, x + 2, y + 4, { width: colWidth - 4, height: rowHeight - 4, ellipsis: true, lineBreak: false });
    });
    doc.y = y + rowHeight;
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + pageWidth, doc.y).strokeColor('#ddd').stroke();
    doc.strokeColor('#000');
  }

  drawRow(headers, { bold: true });
  for (const fila of filas) {
    drawRow(keys.map((k) => fila[k]));
  }
  if (!filas.length) {
    doc.moveDown(1).font('Helvetica').fontSize(10).text('Sin registros para los filtros seleccionados.', { align: 'center' });
  }

  doc.end();
}

async function datosUsos(query) {
  const filtros = {
    ambiente_id: query.ambiente_id,
    persona_id: query.persona_id,
    carrera_id: query.carrera_id,
    curso_id: query.curso_id,
    fecha: query.fecha,
    fecha_desde: query.fecha_desde,
    fecha_hasta: query.fecha_hasta,
    turno: query.turno,
    estado: query.estado,
    incluir_inactivos: 'true',
  };
  const usos = await store.listUsos(filtros);
  const ambientes = await store.listAmbientes();
  const mapaAmb = {};
  for (const a of ambientes) mapaAmb[Number(a.id)] = a;
  const nombres = await mapaNombres();

  return usos.map((u) => {
    const amb = mapaAmb[Number(u.ambiente_id)] || {};
    return {
      id: u.id,
      fecha: u.fecha || '',
      turno: u.turno || '',
      hora_inicio: u.hora_inicio || '',
      hora_fin: u.hora_fin || '',
      horario: (u.hora_inicio || '') + ' - ' + (u.hora_fin || ''),
      ambiente_codigo: amb.codigo || '',
      ambiente_nombre: amb.nombre || '',
      ambiente: amb.codigo ? (amb.codigo + ' - ' + (amb.nombre || '')) : '',
      docente: nombres[Number(u.persona_id)] || u.persona_id || '',
      carrera: u.carrera_nombre || '',
      curso: u.curso_nombre || '',
      estado: u.estado || '',
      observaciones: u.observaciones || '',
    };
  });
}

async function datosEquipos(query) {
  const filtros = {
    ambiente_id: query.ambiente_id,
    estado: query.estado,
    tipo: query.tipo,
    q: query.q,
    incluir_baja: 'true',
  };
  const equipos = await store.listEquipos(filtros);
  const ambientes = await store.listAmbientes();
  const mapaAmb = {};
  for (const a of ambientes) mapaAmb[Number(a.id)] = a;

  return equipos.map((e) => {
    const amb = mapaAmb[Number(e.ambiente_id)] || {};
    return {
      id: e.id,
      codigo_activo: e.codigo_activo || '',
      tipo: e.tipo || '',
      marca: e.marca || '',
      modelo: e.modelo || '',
      estado: e.estado || '',
      ambiente_codigo: amb.codigo || '',
      ambiente_nombre: amb.nombre || '',
      ambiente: amb.codigo ? (amb.codigo + ' - ' + (amb.nombre || '')) : '',
      caracteristicas: e.caracteristicas || '',
      fecha_alta: e.fecha_alta || '',
    };
  });
}

async function datosAmbientes() {
  const ambientes = await store.listAmbientes();
  const equipos = await store.listEquipos({ incluir_baja: 'true' });
  const conteo = {};
  for (const e of equipos) {
    const k = Number(e.ambiente_id);
    if (!conteo[k]) conteo[k] = { total: 0, operativos: 0, mantenimiento: 0, baja: 0 };
    conteo[k].total += 1;
    if (e.estado === 'OPERATIVO') conteo[k].operativos += 1;
    else if (e.estado === 'EN_MANTENIMIENTO') conteo[k].mantenimiento += 1;
    else if (e.estado === 'DE_BAJA') conteo[k].baja += 1;
  }
  const nombres = await mapaNombres();
  return ambientes.map((a) => {
    const c = conteo[Number(a.id)] || { total: 0, operativos: 0, mantenimiento: 0, baja: 0 };
    return {
      id: a.id,
      codigo: a.codigo || '',
      nombre: a.nombre || '',
      tipo: a.tipo || '',
      capacidad_maxima: a.capacidad_maxima || '',
      responsable: nombres[Number(a.persona_responsable_id)] || (a.persona_responsable_id ? ('ID ' + a.persona_responsable_id) : ''),
      activo: a.activo === false ? 'NO' : 'SI',
      equipos_total: c.total,
      equipos_operativos: c.operativos,
      equipos_mantenimiento: c.mantenimiento,
      equipos_baja: c.baja,
    };
  });
}

// --- Uso de laboratorios ---
router.get('/usos', requireAuth, asyncHandler(async (req, res) => {
  const formato = String(req.query.formato || 'xlsx').toLowerCase();
  const filas = await datosUsos(req.query);
  const columnas = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Fecha', key: 'fecha', width: 14 },
    { header: 'Turno', key: 'turno', width: 12 },
    { header: 'Horario', key: 'horario', width: 16 },
    { header: 'Ambiente', key: 'ambiente', width: 28 },
    { header: 'Docente', key: 'docente', width: 28 },
    { header: 'Carrera', key: 'carrera', width: 26 },
    { header: 'Curso', key: 'curso', width: 22 },
    { header: 'Estado', key: 'estado', width: 14 },
    { header: 'Observaciones', key: 'observaciones', width: 30 },
  ];
  if (formato === 'pdf') {
    return enviarPdf(res, nombreArchivo('reporte_uso_laboratorios', 'pdf'), 'Reporte de uso de laboratorios', columnas, filas);
  }
  return enviarXlsx(res, nombreArchivo('reporte_uso_laboratorios', 'xlsx'), [{ nombre: 'Uso de laboratorios', columnas, filas }]);
}));

// --- Equipos / Máquinas ---
router.get('/equipos', requireAuth, asyncHandler(async (req, res) => {
  const formato = String(req.query.formato || 'xlsx').toLowerCase();
  const filas = await datosEquipos(req.query);
  const columnas = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Código activo', key: 'codigo_activo', width: 18 },
    { header: 'Tipo', key: 'tipo', width: 16 },
    { header: 'Marca', key: 'marca', width: 16 },
    { header: 'Modelo', key: 'modelo', width: 16 },
    { header: 'Estado', key: 'estado', width: 18 },
    { header: 'Ambiente', key: 'ambiente', width: 28 },
    { header: 'Características', key: 'caracteristicas', width: 30 },
    { header: 'Fecha alta', key: 'fecha_alta', width: 14 },
  ];
  if (formato === 'pdf') {
    return enviarPdf(res, nombreArchivo('reporte_equipos', 'pdf'), 'Reporte de equipos (inventario y estado)', columnas, filas);
  }
  return enviarXlsx(res, nombreArchivo('reporte_equipos', 'xlsx'), [{ nombre: 'Equipos', columnas, filas }]);
}));

// --- Ambientes ---
router.get('/ambientes', requireAuth, asyncHandler(async (req, res) => {
  const formato = String(req.query.formato || 'xlsx').toLowerCase();
  const filas = await datosAmbientes();
  const columnas = [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Código', key: 'codigo', width: 12 },
    { header: 'Nombre', key: 'nombre', width: 28 },
    { header: 'Tipo', key: 'tipo', width: 16 },
    { header: 'Capacidad', key: 'capacidad_maxima', width: 12 },
    { header: 'Responsable', key: 'responsable', width: 26 },
    { header: 'Activo', key: 'activo', width: 10 },
    { header: 'Equipos total', key: 'equipos_total', width: 14 },
    { header: 'Operativos', key: 'equipos_operativos', width: 12 },
    { header: 'En mantenimiento', key: 'equipos_mantenimiento', width: 16 },
    { header: 'De baja', key: 'equipos_baja', width: 10 },
  ];
  if (formato === 'pdf') {
    return enviarPdf(res, nombreArchivo('reporte_ambientes', 'pdf'), 'Reporte de ambientes y equipos', columnas, filas);
  }
  return enviarXlsx(res, nombreArchivo('reporte_ambientes', 'xlsx'), [{ nombre: 'Ambientes', columnas, filas }]);
}));

module.exports = router;
