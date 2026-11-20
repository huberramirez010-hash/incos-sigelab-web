'use strict';

const fs = require('fs');
const path = require('path');
const seed = require('./seedData');

/**
 * Almacenamiento local en archivo JSON.
 * Se usa cuando no hay credenciales de Firebase o DB_BACKEND=file.
 * Mantiene la misma interfaz que el backend de Firestore.
 */

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');

class StoreError extends Error {
  constructor(codigo, mensaje, status) {
    super(mensaje);
    this.name = 'StoreError';
    this.codigo = codigo;
    this.status = status || 400;
  }
}

let db = null;

function ahora() {
  return new Date().toISOString();
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function maxId(lista) {
  return (lista || []).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
}

function inicializar() {
  const estado = {
    counters: {},
    sigelab_ambientes: clone(seed.ambientes),
    sigelab_equipos: clone(seed.equipos),
    sigelab_historial_estados: clone(seed.historial),
    sigelab_auditoria: clone(seed.auditoria),
    sigelab_cache_personas: clone(seed.cachePersonas),
    sigelab_usos_ambientes: [],
    sigelab_usuarios: [],
    sigelab_codigos: [],
  };
  for (const col of Object.keys(estado)) {
    if (col === 'counters') continue;
    estado.counters[col] = maxId(estado[col]);
  }
  return estado;
}

function guardar() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function cargar() {
  if (db) return db;
  if (fs.existsSync(FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      db = inicializar();
      guardar();
      return db;
    }
  } else {
    db = inicializar();
    guardar();
    return db;
  }

  // Asegurar estructura completa y compatibilidad con archivos antiguos.
  if (!db || typeof db !== 'object') db = inicializar();
  if (!db.counters || typeof db.counters !== 'object') db.counters = {};

  // Migracion desde nombres antiguos.
  if (Array.isArray(db.usuarios_local) && !Array.isArray(db.sigelab_usuarios)) {
    db.sigelab_usuarios = db.usuarios_local;
  }
  if (Array.isArray(db.codigos_verificacion) && !Array.isArray(db.sigelab_codigos)) {
    db.sigelab_codigos = db.codigos_verificacion;
  }

  const colecciones = [
    'sigelab_ambientes',
    'sigelab_equipos',
    'sigelab_historial_estados',
    'sigelab_auditoria',
    'sigelab_cache_personas',
    'sigelab_usos_ambientes',
    'sigelab_usuarios',
    'sigelab_codigos',
  ];
  for (const col of colecciones) {
    if (!Array.isArray(db[col])) db[col] = [];
    if (db.counters[col] === undefined) db.counters[col] = maxId(db[col]);
  }

  return db;
}

function nextId(estado, coleccion) {
  const actual = Number(estado.counters[coleccion] || 0) + 1;
  estado.counters[coleccion] = actual;
  return actual;
}

// ------------------------------------------------------------------
// Ambientes
// ------------------------------------------------------------------

async function listAmbientes() {
  const st = cargar();
  return clone(st.sigelab_ambientes);
}

async function getAmbiente(id) {
  const st = cargar();
  const item = st.sigelab_ambientes.find((a) => a.id === Number(id));
  return item ? clone(item) : null;
}

async function createAmbiente(datos) {
  const st = cargar();
  const codigo = String(datos.codigo || '').trim().toUpperCase();
  if (st.sigelab_ambientes.some((a) => a.codigo.toUpperCase() === codigo)) {
    throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe un ambiente con ese código.', 400);
  }
  const item = {
    id: nextId(st, 'sigelab_ambientes'),
    codigo,
    nombre: datos.nombre,
    tipo: datos.tipo,
    capacidad_maxima: Number(datos.capacidad_maxima) || 0,
    persona_responsable_id: datos.persona_responsable_id || null,
    activo: datos.activo !== false,
    creado_en: ahora(),
    actualizado_en: ahora(),
  };
  st.sigelab_ambientes.push(item);
  guardar();
  return clone(item);
}

async function updateAmbiente(id, datos) {
  const st = cargar();
  const item = st.sigelab_ambientes.find((a) => a.id === Number(id));
  if (!item) return null;
  if (datos.codigo) {
    const codigo = String(datos.codigo).trim().toUpperCase();
    const dup = st.sigelab_ambientes.some((a) => a.id !== item.id && a.codigo.toUpperCase() === codigo);
    if (dup) throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe un ambiente con ese código.', 400);
    item.codigo = codigo;
  }
  for (const campo of ['nombre', 'tipo']) {
    if (datos[campo] !== undefined) item[campo] = datos[campo];
  }
  if (datos.capacidad_maxima !== undefined) item.capacidad_maxima = Number(datos.capacidad_maxima) || 0;
  if (datos.persona_responsable_id !== undefined) item.persona_responsable_id = datos.persona_responsable_id || null;
  if (datos.activo !== undefined) item.activo = Boolean(datos.activo);
  item.actualizado_en = ahora();
  guardar();
  return clone(item);
}

async function countEquiposPorAmbiente(ambienteId) {
  const st = cargar();
  const equipos = st.sigelab_equipos.filter((e) => e.ambiente_id === Number(ambienteId));
  return {
    total: equipos.length,
    activos: equipos.filter((e) => !e.eliminado_en).length,
  };
}

// ------------------------------------------------------------------
// Equipos
// ------------------------------------------------------------------

function coincideTexto(equipo, q) {
  const texto = [equipo.codigo_activo, equipo.tipo, equipo.marca, equipo.modelo, equipo.caracteristicas]
    .join(' ')
    .toLowerCase();
  return texto.includes(String(q).toLowerCase());
}

async function listEquipos(filtros) {
  const f = filtros || {};
  const st = cargar();
  let lista = st.sigelab_equipos.slice();

  if (f.ambiente_id) lista = lista.filter((e) => e.ambiente_id === Number(f.ambiente_id));
  if (f.estado) lista = lista.filter((e) => e.estado === f.estado);
  if (f.tipo) lista = lista.filter((e) => e.tipo === f.tipo);
  if (f.q) lista = lista.filter((e) => coincideTexto(e, f.q));
  if (f.incluir_baja === 'false' || f.incluir_baja === false) {
    lista = lista.filter((e) => e.estado !== 'DE_BAJA');
  }

  lista.sort((a, b) => a.codigo_activo.localeCompare(b.codigo_activo));
  return clone(lista);
}

async function getEquipo(id) {
  const st = cargar();
  const item = st.sigelab_equipos.find((e) => e.id === Number(id));
  return item ? clone(item) : null;
}

async function createEquipo(datos) {
  const st = cargar();
  const codigo = String(datos.codigo_activo || '').trim().toUpperCase();
  if (st.sigelab_equipos.some((e) => e.codigo_activo.toUpperCase() === codigo)) {
    throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe un equipo con ese código de activo.', 400);
  }
  const item = {
    id: nextId(st, 'sigelab_equipos'),
    ambiente_id: Number(datos.ambiente_id),
    codigo_activo: codigo,
    tipo: datos.tipo,
    marca: datos.marca,
    modelo: datos.modelo,
    caracteristicas: datos.caracteristicas || '',
    estado: datos.estado || 'OPERATIVO',
    fecha_alta: datos.fecha_alta || new Date().toISOString().slice(0, 10),
    eliminado_en: null,
    creado_en: ahora(),
    actualizado_en: ahora(),
  };
  st.sigelab_equipos.push(item);
  guardar();
  return clone(item);
}

async function updateEquipo(id, datos) {
  const st = cargar();
  const item = st.sigelab_equipos.find((e) => e.id === Number(id));
  if (!item) return null;

  if (datos.codigo_activo) {
    const codigo = String(datos.codigo_activo).trim().toUpperCase();
    const dup = st.sigelab_equipos.some(
      (e) => e.id !== item.id && e.codigo_activo.toUpperCase() === codigo
    );
    if (dup) throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe un equipo con ese código de activo.', 400);
    item.codigo_activo = codigo;
  }
  if (datos.ambiente_id !== undefined) item.ambiente_id = Number(datos.ambiente_id);
  for (const campo of ['tipo', 'marca', 'modelo', 'caracteristicas', 'fecha_alta']) {
    if (datos[campo] !== undefined) item[campo] = datos[campo];
  }
  // El estado no se cambia por edición: se cambia por el endpoint de estado.
  item.actualizado_en = ahora();
  guardar();
  return clone(item);
}

async function changeEstadoEquipo(id, cambio) {
  const st = cargar();
  const item = st.sigelab_equipos.find((e) => e.id === Number(id));
  if (!item) return null;

  const estadoNuevo = cambio.estado_nuevo;
  if (estadoNuevo === 'DE_BAJA') {
    throw new StoreError(
      'DATOS_INVALIDOS',
      'Use la acción de baja lógica para pasar un equipo a DE_BAJA.',
      400
    );
  }
  if (item.estado === estadoNuevo) {
    throw new StoreError('DATOS_INVALIDOS', 'El equipo ya se encuentra en ese estado.', 400);
  }

  const estadoAnterior = item.estado;
  item.estado = estadoNuevo;
  item.actualizado_en = ahora();
  if (estadoNuevo !== 'DE_BAJA') item.eliminado_en = null;

  const registro = {
    id: nextId(st, 'sigelab_historial_estados'),
    equipo_id: item.id,
    estado_anterior: estadoAnterior,
    estado_nuevo: estadoNuevo,
    observacion: cambio.observacion || '',
    persona_id: cambio.persona_id,
    fecha_hora: ahora(),
  };
  // Misma "transaccion": se guarda equipo + historial en un solo write.
  st.sigelab_historial_estados.push(registro);
  guardar();
  return { equipo: clone(item), historial: clone(registro) };
}

async function darDeBajaEquipo(id, baja) {
  const st = cargar();
  const item = st.sigelab_equipos.find((e) => e.id === Number(id));
  if (!item) return null;
  if (item.estado === 'DE_BAJA') {
    throw new StoreError('CONFLICTO', 'El equipo ya está dado de baja.', 409);
  }

  const estadoAnterior = item.estado;
  item.estado = 'DE_BAJA';
  item.eliminado_en = ahora();
  item.actualizado_en = ahora();

  const registro = {
    id: nextId(st, 'sigelab_historial_estados'),
    equipo_id: item.id,
    estado_anterior: estadoAnterior,
    estado_nuevo: 'DE_BAJA',
    observacion: baja.observacion || 'Baja lógica del equipo.',
    persona_id: baja.persona_id,
    fecha_hora: ahora(),
  };
  st.sigelab_historial_estados.push(registro);
  guardar();
  return { equipo: clone(item), historial: clone(registro) };
}

async function listHistorial(equipoId) {
  const st = cargar();
  return clone(
    st.sigelab_historial_estados
      .filter((h) => h.equipo_id === Number(equipoId))
      .sort((a, b) => String(a.fecha_hora).localeCompare(String(b.fecha_hora)))
  );
}

// ------------------------------------------------------------------
// Auditoria
// ------------------------------------------------------------------

async function addAuditoria(entrada) {
  const st = cargar();
  const item = {
    id: nextId(st, 'sigelab_auditoria'),
    persona_id: entrada.persona_id,
    accion: entrada.accion,
    entidad: entrada.entidad,
    entidad_id: entrada.entidad_id,
    fecha_hora: ahora(),
  };
  st.sigelab_auditoria.push(item);
  guardar();
  return clone(item);
}

async function listAuditoria(limite) {
  const st = cargar();
  const lista = st.sigelab_auditoria
    .slice()
    .sort((a, b) => String(b.fecha_hora).localeCompare(String(a.fecha_hora)));
  return clone(limite ? lista.slice(0, Number(limite)) : lista);
}

// ------------------------------------------------------------------
// Cache de personas (solo lectura; nunca decide permisos)
// ------------------------------------------------------------------

async function upsertCachePersona(persona) {
  const st = cargar();
  const id = Number(persona.persona_id || persona.id);
  if (!id) return null;
  const existente = st.sigelab_cache_personas.find((p) => p.persona_id === id);
  const item = {
    persona_id: id,
    ci: persona.ci || (existente && existente.ci) || '',
    nombre_completo:
      persona.nombre_completo ||
      [persona.nombres, persona.apellidos].filter(Boolean).join(' ') ||
      (existente && existente.nombre_completo) ||
      '',
    cargo: persona.cargo || (existente && existente.cargo) || '',
    actualizado_en: ahora(),
  };
  if (existente) Object.assign(existente, item);
  else st.sigelab_cache_personas.push(item);
  guardar();
  return clone(item);
}

async function listCachePersonas() {
  const st = cargar();
  return clone(st.sigelab_cache_personas);
}

async function getCachePersona(id) {
  const st = cargar();
  const item = st.sigelab_cache_personas.find((p) => p.persona_id === Number(id));
  return item ? clone(item) : null;
}

// ------------------------------------------------------------------
// Uso de laboratorios (sesiones por turno/horario)
// ------------------------------------------------------------------

async function listUsos(filtros) {
  const st = cargar();
  const f = filtros || {};
  let lista = clone(st.sigelab_usos_ambientes || []);
  if (f.incluir_inactivos !== 'true' && f.incluir_inactivos !== true) {
    lista = lista.filter((u) => u.activo !== false);
  }
  if (f.ambiente_id) lista = lista.filter((u) => u.ambiente_id === Number(f.ambiente_id));
  if (f.persona_id) lista = lista.filter((u) => u.persona_id === Number(f.persona_id));
  if (f.fecha) lista = lista.filter((u) => u.fecha === String(f.fecha));
  if (f.fecha_desde) lista = lista.filter((u) => String(u.fecha || '') >= String(f.fecha_desde));
  if (f.fecha_hasta) lista = lista.filter((u) => String(u.fecha || '') <= String(f.fecha_hasta));
  if (f.turno) lista = lista.filter((u) => u.turno === String(f.turno));
  if (f.estado) lista = lista.filter((u) => u.estado === String(f.estado));
  if (f.carrera_id) lista = lista.filter((u) => String(u.carrera_id || '') === String(f.carrera_id));
  if (f.curso_id) lista = lista.filter((u) => String(u.curso_id || '') === String(f.curso_id));
  return lista.sort((a, b) => {
    const ka = String(a.fecha || '') + ' ' + String(a.hora_inicio || '') + ' ' + String(a.id || '');
    const kb = String(b.fecha || '') + ' ' + String(b.hora_inicio || '') + ' ' + String(b.id || '');
    return kb.localeCompare(ka);
  });
}

async function getUso(id) {
  const st = cargar();
  const item = (st.sigelab_usos_ambientes || []).find((u) => u.id === Number(id));
  return item ? clone(item) : null;
}

async function createUso(datos) {
  const st = cargar();
  if (!Array.isArray(st.sigelab_usos_ambientes)) st.sigelab_usos_ambientes = [];
  const id = nextId(st, 'sigelab_usos_ambientes');
  const item = {
    id,
    ambiente_id: Number(datos.ambiente_id),
    persona_id: Number(datos.persona_id),
    carrera_id: datos.carrera_id ? Number(datos.carrera_id) : null,
    carrera_nombre: datos.carrera_nombre || '',
    curso_id: datos.curso_id ? Number(datos.curso_id) : null,
    curso_nombre: datos.curso_nombre || '',
    fecha: String(datos.fecha),
    turno: String(datos.turno),
    hora_inicio: String(datos.hora_inicio),
    hora_fin: String(datos.hora_fin),
    estado: datos.estado || 'EN_USO',
    observaciones: datos.observaciones || '',
    registrado_por_persona_id: datos.registrado_por_persona_id || null,
    activo: true,
    creado_en: ahora(),
    actualizado_en: ahora(),
  };
  st.sigelab_usos_ambientes.push(item);
  guardar();
  return clone(item);
}

async function updateUso(id, datos) {
  const st = cargar();
  const item = (st.sigelab_usos_ambientes || []).find((u) => u.id === Number(id));
  if (!item) return null;
  const limpio = Object.assign({}, datos, { actualizado_en: ahora() });
  delete limpio.id;
  delete limpio.ambiente_id;
  delete limpio.fecha;
  delete limpio.turno;
  Object.assign(item, limpio);
  guardar();
  return clone(item);
}

// ------------------------------------------------------------------
// Cuentas locales SIGELAB
// ------------------------------------------------------------------

async function getUsuarioLocalPorCorreo(correo) {
  const st = cargar();
  const valor = String(correo || '').trim().toLowerCase();
  if (!valor) return null;
  const item = st.sigelab_usuarios.find((u) => u.correo === valor);
  return item ? clone(item) : null;
}

async function getUsuarioLocalPorTelefono(telefono) {
  const st = cargar();
  const valor = String(telefono || '').trim();
  if (!valor) return null;
  const item = st.sigelab_usuarios.find((u) => u.telefono === valor);
  return item ? clone(item) : null;
}

async function getUsuarioLocal(id) {
  const st = cargar();
  const item = st.sigelab_usuarios.find((u) => u.id === Number(id));
  return item ? clone(item) : null;
}

async function createUsuarioLocal(datos) {
  const st = cargar();
  const correo = String(datos.correo || '').trim().toLowerCase();
  const telefono = String(datos.telefono || '').trim();

  if (st.sigelab_usuarios.some((u) => u.correo === correo)) {
    throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe una cuenta con ese correo.', 400);
  }
  if (telefono && st.sigelab_usuarios.some((u) => u.telefono === telefono)) {
    throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe una cuenta con ese teléfono.', 400);
  }

  const id = nextId(st, 'sigelab_usuarios');
  const item = {
    id,
    nombre_completo: datos.nombre_completo,
    correo,
    telefono,
    password_hash: datos.password_hash,
    rol: datos.rol || 'CONSULTA',
    rol_solicitado: datos.rol_solicitado || datos.rol || 'CONSULTA',
    rol_solicitado_etiqueta: datos.rol_solicitado_etiqueta || null,
    persona_id: Number(datos.persona_id) || 1000000 + id,
    activo: datos.activo === true,
    estado_solicitud: datos.estado_solicitud || 'PENDIENTE',
    solicitud_en: datos.solicitud_en || ahora(),
    aprobado_en: datos.aprobado_en || null,
    aprobado_por_persona_id: datos.aprobado_por_persona_id || null,
    aprobado_por_nombre: datos.aprobado_por_nombre || null,
    rechazado_en: datos.rechazado_en || null,
    rechazado_por_persona_id: datos.rechazado_por_persona_id || null,
    rechazado_por_nombre: datos.rechazado_por_nombre || null,
    motivo_rechazo: datos.motivo_rechazo || null,
    correo_verificado: datos.correo_verificado === true,
    telefono_verificado: datos.telefono_verificado === true,
    token_version: 0,
    creado_en: ahora(),
    actualizado_en: ahora(),
    ultimo_acceso: null,
  };
  st.sigelab_usuarios.push(item);
  guardar();
  return clone(item);
}

async function listUsuariosLocal() {
  const st = cargar();
  return st.sigelab_usuarios.slice().sort((a, b) => Number(b.id) - Number(a.id)).map(clone);
}

async function updateUsuarioLocal(id, cambios) {
  const st = cargar();
  const item = st.sigelab_usuarios.find((u) => u.id === Number(id));
  if (!item) return null;
  const limpio = Object.assign({}, cambios, { actualizado_en: ahora() });
  delete limpio.id;
  Object.assign(item, limpio);
  guardar();
  return clone(item);
}

// ------------------------------------------------------------------
// Codigos de verificacion / recuperacion
// ------------------------------------------------------------------

function claveCodigo(usuarioId, tipo, canal) {
  return String(usuarioId) + ':' + String(tipo) + ':' + String(canal);
}

async function upsertCodigo(datos) {
  const st = cargar();
  const clave = claveCodigo(datos.usuario_id, datos.tipo, datos.canal);
  const item = {
    clave,
    usuario_id: Number(datos.usuario_id),
    tipo: datos.tipo,
    canal: datos.canal,
    destino: datos.destino || '',
    codigo_hash: datos.codigo_hash,
    expira_en: datos.expira_en,
    creado_en: ahora(),
    usado_en: null,
    intentos: 0,
    envios: Number(datos.envios) || 1,
    ultimo_envio_en: ahora(),
  };
  const i = st.sigelab_codigos.findIndex((c) => c.clave === clave);
  if (i >= 0) st.sigelab_codigos[i] = item;
  else st.sigelab_codigos.push(item);
  guardar();
  return clone(item);
}

async function getCodigo(usuarioId, tipo, canal) {
  const st = cargar();
  const clave = claveCodigo(usuarioId, tipo, canal);
  const item = st.sigelab_codigos.find((c) => c.clave === clave);
  return item ? clone(item) : null;
}

async function updateCodigo(usuarioId, tipo, canal, cambios) {
  const st = cargar();
  const clave = claveCodigo(usuarioId, tipo, canal);
  const item = st.sigelab_codigos.find((c) => c.clave === clave);
  if (!item) return null;
  Object.assign(item, cambios);
  guardar();
  return clone(item);
}

async function deleteCodigo(usuarioId, tipo, canal) {
  const st = cargar();
  const clave = claveCodigo(usuarioId, tipo, canal);
  const i = st.sigelab_codigos.findIndex((c) => c.clave === clave);
  if (i >= 0) st.sigelab_codigos.splice(i, 1);
  guardar();
  return { ok: true };
}

// ------------------------------------------------------------------
// Utilidades de mantenimiento
// ------------------------------------------------------------------

async function resetStore() {
  const previos = db
    ? {
        usuarios: clone(db.sigelab_usuarios || []),
        codigos: clone(db.sigelab_codigos || []),
      }
    : { usuarios: [], codigos: [] };

  db = inicializar();
  // Las cuentas locales y sus codigos NO se borran al recargar los datos
  // de laboratorio. Asi el usuario conserva su cuenta entre seeds.
  db.sigelab_usuarios = previos.usuarios;
  db.sigelab_codigos = previos.codigos;
  db.counters.sigelab_usuarios = maxId(previos.usuarios);

  // Volver a crear la cache de nombres de las cuentas locales para que
  // historial y auditoria muestren el nombre correcto.
  for (const u of previos.usuarios) {
    if (!u.persona_id) continue;
    db.sigelab_cache_personas.push({
      persona_id: Number(u.persona_id),
      ci: '',
      nombre_completo: u.nombre_completo || '',
      cargo: 'Cuenta local SIGELAB',
      actualizado_en: ahora(),
    });
  }

  guardar();
  return { ok: true };
}

module.exports = {
  StoreError,
  backend: 'file',
  listAmbientes,
  getAmbiente,
  createAmbiente,
  updateAmbiente,
  countEquiposPorAmbiente,
  listEquipos,
  getEquipo,
  createEquipo,
  updateEquipo,
  changeEstadoEquipo,
  darDeBajaEquipo,
  listHistorial,
  addAuditoria,
  listAuditoria,
  upsertCachePersona,
  listCachePersonas,
  getCachePersona,
  listUsos,
  getUso,
  createUso,
  updateUso,
  getUsuarioLocalPorCorreo,
  getUsuarioLocalPorTelefono,
  getUsuarioLocal,
  createUsuarioLocal,
  updateUsuarioLocal,
  listUsuariosLocal,
  upsertCodigo,
  getCodigo,
  updateCodigo,
  deleteCodigo,
  resetStore,
};
