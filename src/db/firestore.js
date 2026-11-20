'use strict';

/**
 * Almacenamiento en Firebase Firestore.
 * Implementa la misma interfaz que fileStore.
 *
 * Requiere una de estas configuraciones:
 *   - FIREBASE_SERVICE_ACCOUNT (JSON en una variable)
 *   - GOOGLE_APPLICATION_CREDENTIALS (ruta al service account)
 *   - FIRESTORE_EMULATOR_HOST (emulador local)
 */

const path = require('path');
const { StoreError } = require('./fileStore');
const seed = require('./seedData');

const COL = {
  ambientes: 'sigelab_ambientes',
  equipos: 'sigelab_equipos',
  historial: 'sigelab_historial_estados',
  auditoria: 'sigelab_auditoria',
  cachePersonas: 'sigelab_cache_personas',
  contadores: 'sigelab_contadores',
  usuarios: 'sigelab_usuarios',
  codigos: 'sigelab_codigos',
  usos: 'sigelab_usos_ambientes',
};

let admin = null;
let db = null;
let inicializado = false;

function estaConfigurado() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return true;
  if (process.env.FIRESTORE_EMULATOR_HOST) return true;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Solo se considera configurado si el archivo de credenciales existe.
    // Asi, un clon sin la clave usa automaticamente el almacenamiento local
    // (DB_BACKEND=auto) y el demo funciona igual.
    const rutaConfigurada = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const ruta = path.isAbsolute(rutaConfigurada)
      ? rutaConfigurada
      : path.join(__dirname, '..', '..', rutaConfigurada);
    return require('fs').existsSync(ruta);
  }
  return false;
}

function init() {
  if (inicializado) return;
  admin = require('firebase-admin');

  const opciones = {};
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const credenciales = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    opciones.credential = admin.credential.cert(credenciales);
    opciones.projectId = credenciales.project_id || process.env.FIREBASE_PROJECT_ID;
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Resolver rutas relativas contra la raiz del proyecto, sin importar
    // desde que carpeta se lance el proceso.
    const rutaConfigurada = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const ruta = path.isAbsolute(rutaConfigurada)
      ? rutaConfigurada
      : path.join(__dirname, '..', '..', rutaConfigurada);
    const credenciales = JSON.parse(require('fs').readFileSync(ruta, 'utf8'));
    opciones.credential = admin.credential.cert(credenciales);
    opciones.projectId = credenciales.project_id || process.env.FIREBASE_PROJECT_ID;
  } else {
    // Emulador: no requiere credenciales reales.
    opciones.projectId = process.env.FIREBASE_PROJECT_ID || 'demo-sigelab';
  }

  if (!admin.apps.length) {
    admin.initializeApp(opciones);
  }
  db = admin.firestore();
  // America/La_Paz no es una zona soportada por Firestore; se usa la hora del servidor.
  db.settings({ ignoreUndefinedProperties: true });
  inicializado = true;
}

function ahora() {
  return new Date().toISOString();
}

function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function docToObj(doc) {
  const data = doc.data() || {};
  const obj = { id: numero(doc.id), ...data };
  return JSON.parse(JSON.stringify(obj));
}

async function nextIdTx(tx, coleccion) {
  const ref = db.collection(COL.contadores).doc(coleccion);
  const snap = await tx.get(ref);
  const actual = snap.exists ? Number(snap.data().valor || 0) : 0;
  const nuevo = actual + 1;
  tx.set(ref, { valor: nuevo }, { merge: true });
  return nuevo;
}

// ------------------------------------------------------------------
// Ambientes
// ------------------------------------------------------------------

async function listAmbientes() {
  init();
  const snap = await db.collection(COL.ambientes).get();
  return snap.docs
    .map(docToObj)
    .sort((a, b) => String(a.codigo).localeCompare(String(b.codigo)));
}

async function getAmbiente(id) {
  init();
  const snap = await db.collection(COL.ambientes).doc(String(id)).get();
  return snap.exists ? docToObj(snap) : null;
}

async function createAmbiente(datos) {
  init();
  const codigo = String(datos.codigo || '').trim().toUpperCase();
  const existentes = await db
    .collection(COL.ambientes)
    .where('codigo', '==', codigo)
    .limit(1)
    .get();
  if (!existentes.empty) {
    throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe un ambiente con ese código.', 400);
  }
  return db.runTransaction(async (tx) => {
    const id = await nextIdTx(tx, COL.ambientes);
    const item = {
      codigo,
      nombre: datos.nombre,
      tipo: datos.tipo,
      capacidad_maxima: Number(datos.capacidad_maxima) || 0,
      persona_responsable_id: datos.persona_responsable_id || null,
      activo: datos.activo !== false,
      creado_en: ahora(),
      actualizado_en: ahora(),
    };
    tx.set(db.collection(COL.ambientes).doc(String(id)), item);
    return { id, ...item };
  });
}

async function updateAmbiente(id, datos) {
  init();
  const ref = db.collection(COL.ambientes).doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) return null;

  if (datos.codigo) {
    const codigo = String(datos.codigo).trim().toUpperCase();
    const dup = await db
      .collection(COL.ambientes)
      .where('codigo', '==', codigo)
      .get();
    if (dup.docs.some((d) => d.id !== String(id))) {
      throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe un ambiente con ese código.', 400);
    }
    datos.codigo = codigo;
  }

  const cambios = {};
  for (const campo of ['codigo', 'nombre', 'tipo']) {
    if (datos[campo] !== undefined) cambios[campo] = datos[campo];
  }
  if (datos.capacidad_maxima !== undefined) cambios.capacidad_maxima = Number(datos.capacidad_maxima) || 0;
  if (datos.persona_responsable_id !== undefined) {
    cambios.persona_responsable_id = datos.persona_responsable_id || null;
  }
  if (datos.activo !== undefined) cambios.activo = Boolean(datos.activo);
  cambios.actualizado_en = ahora();

  await ref.set(cambios, { merge: true });
  const actualizado = await ref.get();
  return docToObj(actualizado);
}

async function countEquiposPorAmbiente(ambienteId) {
  init();
  const snap = await db
    .collection(COL.equipos)
    .where('ambiente_id', '==', Number(ambienteId))
    .get();
  const equipos = snap.docs.map((d) => d.data());
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
  init();
  const f = filtros || {};
  const snap = await db.collection(COL.equipos).get();
  let lista = snap.docs.map(docToObj);

  if (f.ambiente_id) lista = lista.filter((e) => e.ambiente_id === Number(f.ambiente_id));
  if (f.estado) lista = lista.filter((e) => e.estado === f.estado);
  if (f.tipo) lista = lista.filter((e) => e.tipo === f.tipo);
  if (f.q) lista = lista.filter((e) => coincideTexto(e, f.q));
  if (f.incluir_baja === 'false' || f.incluir_baja === false) {
    lista = lista.filter((e) => e.estado !== 'DE_BAJA');
  }

  lista.sort((a, b) => String(a.codigo_activo).localeCompare(String(b.codigo_activo)));
  return lista;
}

async function getEquipo(id) {
  init();
  const snap = await db.collection(COL.equipos).doc(String(id)).get();
  return snap.exists ? docToObj(snap) : null;
}

async function createEquipo(datos) {
  init();
  const codigo = String(datos.codigo_activo || '').trim().toUpperCase();
  const existentes = await db
    .collection(COL.equipos)
    .where('codigo_activo', '==', codigo)
    .limit(1)
    .get();
  if (!existentes.empty) {
    throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe un equipo con ese código de activo.', 400);
  }
  return db.runTransaction(async (tx) => {
    const id = await nextIdTx(tx, COL.equipos);
    const item = {
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
    tx.set(db.collection(COL.equipos).doc(String(id)), item);
    return { id, ...item };
  });
}

async function updateEquipo(id, datos) {
  init();
  const ref = db.collection(COL.equipos).doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) return null;

  if (datos.codigo_activo) {
    const codigo = String(datos.codigo_activo).trim().toUpperCase();
    const dup = await db
      .collection(COL.equipos)
      .where('codigo_activo', '==', codigo)
      .get();
    if (dup.docs.some((d) => d.id !== String(id))) {
      throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe un equipo con ese código de activo.', 400);
    }
    datos.codigo_activo = codigo;
  }

  const cambios = {};
  if (datos.codigo_activo !== undefined) cambios.codigo_activo = datos.codigo_activo;
  if (datos.ambiente_id !== undefined) cambios.ambiente_id = Number(datos.ambiente_id);
  for (const campo of ['tipo', 'marca', 'modelo', 'caracteristicas', 'fecha_alta']) {
    if (datos[campo] !== undefined) cambios[campo] = datos[campo];
  }
  cambios.actualizado_en = ahora();

  await ref.set(cambios, { merge: true });
  const actualizado = await ref.get();
  return docToObj(actualizado);
}

async function changeEstadoEquipo(id, cambio) {
  init();
  const eqRef = db.collection(COL.equipos).doc(String(id));
  if (cambio.estado_nuevo === 'DE_BAJA') {
    throw new StoreError(
      'DATOS_INVALIDOS',
      'Use la acción de baja lógica para pasar un equipo a DE_BAJA.',
      400
    );
  }

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(eqRef);
    if (!snap.exists) return null;
    const equipo = snap.data();
    if (equipo.estado === cambio.estado_nuevo) {
      throw new StoreError('DATOS_INVALIDOS', 'El equipo ya se encuentra en ese estado.', 400);
    }
    const estadoAnterior = equipo.estado;
    const idHistorial = await nextIdTx(tx, COL.historial);

    const registro = {
      equipo_id: Number(id),
      estado_anterior: estadoAnterior,
      estado_nuevo: cambio.estado_nuevo,
      observacion: cambio.observacion || '',
      persona_id: cambio.persona_id,
      fecha_hora: ahora(),
    };

    tx.set(eqRef, { estado: cambio.estado_nuevo, actualizado_en: ahora() }, { merge: true });
    tx.set(db.collection(COL.historial).doc(String(idHistorial)), registro);

    return {
      equipo: { id: Number(id), ...equipo, estado: cambio.estado_nuevo },
      historial: { id: idHistorial, ...registro },
    };
  });
}

async function darDeBajaEquipo(id, baja) {
  init();
  const eqRef = db.collection(COL.equipos).doc(String(id));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(eqRef);
    if (!snap.exists) return null;
    const equipo = snap.data();
    if (equipo.estado === 'DE_BAJA') {
      throw new StoreError('CONFLICTO', 'El equipo ya está dado de baja.', 409);
    }
    const estadoAnterior = equipo.estado;
    const idHistorial = await nextIdTx(tx, COL.historial);
    const marcaTiempo = ahora();

    const registro = {
      equipo_id: Number(id),
      estado_anterior: estadoAnterior,
      estado_nuevo: 'DE_BAJA',
      observacion: baja.observacion || 'Baja lógica del equipo.',
      persona_id: baja.persona_id,
      fecha_hora: marcaTiempo,
    };

    tx.set(
      eqRef,
      { estado: 'DE_BAJA', eliminado_en: marcaTiempo, actualizado_en: marcaTiempo },
      { merge: true }
    );
    tx.set(db.collection(COL.historial).doc(String(idHistorial)), registro);

    return {
      equipo: { id: Number(id), ...equipo, estado: 'DE_BAJA', eliminado_en: marcaTiempo },
      historial: { id: idHistorial, ...registro },
    };
  });
}

async function listHistorial(equipoId) {
  init();
  const snap = await db
    .collection(COL.historial)
    .where('equipo_id', '==', Number(equipoId))
    .get();
  return snap.docs
    .map(docToObj)
    .sort((a, b) => String(a.fecha_hora).localeCompare(String(b.fecha_hora)));
}

// ------------------------------------------------------------------
// Auditoria
// ------------------------------------------------------------------

async function addAuditoria(entrada) {
  init();
  return db.runTransaction(async (tx) => {
    const id = await nextIdTx(tx, COL.auditoria);
    const item = {
      persona_id: entrada.persona_id,
      accion: entrada.accion,
      entidad: entrada.entidad,
      entidad_id: entrada.entidad_id,
      fecha_hora: ahora(),
    };
    tx.set(db.collection(COL.auditoria).doc(String(id)), item);
    return { id, ...item };
  });
}

async function listAuditoria(limite) {
  init();
  const snap = await db.collection(COL.auditoria).get();
  const lista = snap.docs
    .map(docToObj)
    .sort((a, b) => String(b.fecha_hora).localeCompare(String(a.fecha_hora)));
  return limite ? lista.slice(0, Number(limite)) : lista;
}

// ------------------------------------------------------------------
// Cache de personas
// ------------------------------------------------------------------

async function upsertCachePersona(persona) {
  init();
  const id = Number(persona.persona_id || persona.id);
  if (!id) return null;
  const ref = db.collection(COL.cachePersonas).doc(String(id));
  const snap = await ref.get();
  const existente = snap.exists ? snap.data() : {};

  const item = {
    persona_id: id,
    ci: persona.ci || existente.ci || '',
    nombre_completo:
      persona.nombre_completo ||
      [persona.nombres, persona.apellidos].filter(Boolean).join(' ') ||
      existente.nombre_completo ||
      '',
    cargo: persona.cargo || existente.cargo || '',
    actualizado_en: ahora(),
  };
  await ref.set(item, { merge: true });
  return item;
}

async function listCachePersonas() {
  init();
  const snap = await db.collection(COL.cachePersonas).get();
  return snap.docs.map(docToObj);
}

async function getCachePersona(id) {
  init();
  const snap = await db.collection(COL.cachePersonas).doc(String(id)).get();
  return snap.exists ? docToObj(snap) : null;
}

// ------------------------------------------------------------------
// Cuentas locales SIGELAB
// ------------------------------------------------------------------

async function getUsuarioLocalPorCorreo(correo) {
  init();
  const valor = String(correo || '').trim().toLowerCase();
  if (!valor) return null;
  const snap = await db.collection(COL.usuarios).where('correo', '==', valor).limit(1).get();
  return snap.empty ? null : docToObj(snap.docs[0]);
}

async function getUsuarioLocalPorTelefono(telefono) {
  init();
  const valor = String(telefono || '').trim();
  if (!valor) return null;
  const snap = await db.collection(COL.usuarios).where('telefono', '==', valor).limit(1).get();
  return snap.empty ? null : docToObj(snap.docs[0]);
}

async function getUsuarioLocal(id) {
  init();
  const snap = await db.collection(COL.usuarios).doc(String(id)).get();
  return snap.exists ? docToObj(snap) : null;
}

async function createUsuarioLocal(datos) {
  init();
  const correo = String(datos.correo || '').trim().toLowerCase();
  const telefono = String(datos.telefono || '').trim();

  const dupCorreo = await db
    .collection(COL.usuarios)
    .where('correo', '==', correo)
    .limit(1)
    .get();
  if (!dupCorreo.empty) {
    throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe una cuenta con ese correo.', 400);
  }

  if (telefono) {
    const dupTelefono = await db
      .collection(COL.usuarios)
      .where('telefono', '==', telefono)
      .limit(1)
      .get();
    if (!dupTelefono.empty) {
      throw new StoreError('REGISTRO_DUPLICADO', 'Ya existe una cuenta con ese teléfono.', 400);
    }
  }

  return db.runTransaction(async (tx) => {
    const id = await nextIdTx(tx, COL.usuarios);
    const item = {
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
    tx.set(db.collection(COL.usuarios).doc(String(id)), item);
    return { id, ...item };
  });
}

async function listUsuariosLocal() {
  init();
  const snap = await db.collection(COL.usuarios).get();
  return snap.docs.map(docToObj);
}

async function updateUsuarioLocal(id, cambios) {
  init();
  const ref = db.collection(COL.usuarios).doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const limpio = Object.assign({}, cambios, { actualizado_en: ahora() });
  delete limpio.id;
  await ref.set(limpio, { merge: true });
  const actualizado = await ref.get();
  return docToObj(actualizado);
}

// ------------------------------------------------------------------
// Uso de laboratorios (sesiones por turno/horario)
// ------------------------------------------------------------------

async function listUsos(filtros) {
  init();
  const f = filtros || {};
  const snap = await db.collection(COL.usos).get();
  let lista = snap.docs.map(docToObj);
  if (f.incluir_inactivos !== 'true' && f.incluir_inactivos !== true) {
    lista = lista.filter((u) => u.activo !== false);
  }
  if (f.ambiente_id) lista = lista.filter((u) => u.ambiente_id === Number(f.ambiente_id));
  if (f.persona_id) lista = lista.filter((u) => u.persona_id === Number(f.persona_id));
  if (f.fecha) lista = lista.filter((u) => String(u.fecha) === String(f.fecha));
  if (f.turno) lista = lista.filter((u) => String(u.turno) === String(f.turno));
  if (f.estado) lista = lista.filter((u) => String(u.estado) === String(f.estado));
  return lista.sort((a, b) => {
    const ka = String(a.fecha || '') + ' ' + String(a.hora_inicio || '') + ' ' + String(a.id || '');
    const kb = String(b.fecha || '') + ' ' + String(b.hora_inicio || '') + ' ' + String(b.id || '');
    return kb.localeCompare(ka);
  });
}

async function getUso(id) {
  init();
  const snap = await db.collection(COL.usos).doc(String(id)).get();
  return snap.exists ? docToObj(snap) : null;
}

async function createUso(datos) {
  init();
  return db.runTransaction(async (tx) => {
    const id = await nextIdTx(tx, COL.usos);
    const item = {
      ambiente_id: Number(datos.ambiente_id),
      persona_id: Number(datos.persona_id),
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
    tx.set(db.collection(COL.usos).doc(String(id)), item);
    return { id, ...item };
  });
}

async function updateUso(id, datos) {
  init();
  const ref = db.collection(COL.usos).doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const limpio = Object.assign({}, datos, { actualizado_en: ahora() });
  delete limpio.id;
  delete limpio.ambiente_id;
  delete limpio.fecha;
  delete limpio.turno;
  await ref.set(limpio, { merge: true });
  const actualizado = await ref.get();
  return docToObj(actualizado);
}

// ------------------------------------------------------------------
// Codigos de verificacion / recuperacion (uno activo por usuario+tipo+canal)
// ------------------------------------------------------------------

function claveCodigo(usuarioId, tipo, canal) {
  return String(usuarioId) + ':' + String(tipo) + ':' + String(canal);
}

async function upsertCodigo(datos) {
  init();
  const clave = claveCodigo(datos.usuario_id, datos.tipo, datos.canal);
  const item = {
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
  await db.collection(COL.codigos).doc(clave).set(item);
  return { clave: clave, ...item };
}

async function getCodigo(usuarioId, tipo, canal) {
  init();
  const clave = claveCodigo(usuarioId, tipo, canal);
  const snap = await db.collection(COL.codigos).doc(clave).get();
  return snap.exists ? { clave: clave, ...snap.data() } : null;
}

async function updateCodigo(usuarioId, tipo, canal, cambios) {
  init();
  const clave = claveCodigo(usuarioId, tipo, canal);
  const ref = db.collection(COL.codigos).doc(clave);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.set(cambios, { merge: true });
  const actualizado = await ref.get();
  return { clave: clave, ...actualizado.data() };
}

async function deleteCodigo(usuarioId, tipo, canal) {
  init();
  const clave = claveCodigo(usuarioId, tipo, canal);
  await db.collection(COL.codigos).doc(clave).delete();
  return { ok: true };
}

function maxId(lista) {
  return (lista || []).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
}

async function resetStore() {
  init();
  const colecciones = [COL.ambientes, COL.equipos, COL.historial, COL.auditoria, COL.cachePersonas, COL.usos, COL.contadores];

  // 1) Borrar todo.
  for (const nombre of colecciones) {
    const snap = await db.collection(nombre).get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  // 2) Sembrar los datos de demostracion.
  const batch = db.batch();

  for (const a of seed.ambientes) {
    batch.set(db.collection(COL.ambientes).doc(String(a.id)), a);
  }
  for (const e of seed.equipos) {
    batch.set(db.collection(COL.equipos).doc(String(e.id)), e);
  }
  for (const h of seed.historial) {
    batch.set(db.collection(COL.historial).doc(String(h.id)), h);
  }
  for (const p of seed.cachePersonas) {
    batch.set(db.collection(COL.cachePersonas).doc(String(p.persona_id)), p);
  }

  // Las cuentas locales no se borran al recargar el seed. Conservar su
  // contador y volver a crear su entrada de cache para historial/auditoria.
  const usuariosSnap = await db.collection(COL.usuarios).get();
  const maxUsuario = usuariosSnap.docs.reduce((m, d) => Math.max(m, Number(d.id) || 0), 0);
  for (const doc of usuariosSnap.docs) {
    const u = doc.data() || {};
    if (!u.persona_id) continue;
    batch.set(db.collection(COL.cachePersonas).doc(String(u.persona_id)), {
      persona_id: Number(u.persona_id),
      ci: '',
      nombre_completo: u.nombre_completo || '',
      cargo: 'Cuenta local SIGELAB',
      actualizado_en: ahora(),
    });
  }

  batch.set(db.collection(COL.contadores).doc(COL.ambientes), { valor: maxId(seed.ambientes) });
  batch.set(db.collection(COL.contadores).doc(COL.equipos), { valor: maxId(seed.equipos) });
  batch.set(db.collection(COL.contadores).doc(COL.historial), { valor: maxId(seed.historial) });
  batch.set(db.collection(COL.contadores).doc(COL.auditoria), { valor: maxId(seed.auditoria) });
  batch.set(db.collection(COL.contadores).doc(COL.cachePersonas), { valor: 0 });
  batch.set(db.collection(COL.contadores).doc(COL.usos), { valor: 0 });
  batch.set(db.collection(COL.contadores).doc(COL.usuarios), { valor: maxUsuario });

  await batch.commit();
  return { ok: true };
}

module.exports = {
  StoreError,
  backend: 'firestore',
  estaConfigurado,
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
