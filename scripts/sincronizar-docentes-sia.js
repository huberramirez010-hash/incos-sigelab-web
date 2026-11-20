'use strict';

/**
 * Sincroniza docentes desde el SIA a la caché local (sigelab_cache_personas).
 *
 * Uso:
 *   $env:SIA_SYNC_USER='INTEGRACION'
 *   $env:SIA_SYNC_PASS='<clave>'
 *   node scripts/sincronizar-docentes-sia.js
 *
 * No guarda la clave en archivos. Requiere que el proyecto tenga acceso
 * al almacenamiento configurado (Firestore o archivo local).
 */

const config = require('../src/config');
const store = require('../src/db');

const BASE = config.siaUrl;

async function fetchJson(url, opciones, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...(opciones || {}), signal: controller.signal });
    const texto = await res.text();
    let data = null;
    if (texto) {
      try { data = JSON.parse(texto); } catch (e) { data = texto; }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

function extraerLista(cuerpo) {
  if (!cuerpo) return [];
  const datos = cuerpo.datos !== undefined ? cuerpo.datos : cuerpo;
  if (Array.isArray(datos)) return datos;
  if (datos && Array.isArray(datos.docentes)) return datos.docentes;
  if (datos && Array.isArray(datos.personas)) return datos.personas;
  if (datos && Array.isArray(datos.items)) return datos.items;
  return [];
}

function normalizar(p) {
  const id = p.id || p.persona_id || p.personaId;
  const nombre =
    p.nombre_completo ||
    p.nombre ||
    [p.nombres, p.apellidos].filter(Boolean).join(' ') ||
    String(id || '');
  let cargo = p.cargo || '';
  if (!cargo && Array.isArray(p.cargos)) {
    cargo = p.cargos.map((c) => (typeof c === 'string' ? c : (c && (c.nombre || c.cargo)) || '')).filter(Boolean).join(', ');
  }
  if (!cargo) cargo = 'Docente';
  return {
    persona_id: id,
    ci: p.ci || '',
    nombres: p.nombres || '',
    apellidos: p.apellidos || '',
    nombre_completo: nombre,
    cargo,
  };
}

async function main() {
  const usuario = (process.env.SIA_SYNC_USER || 'INTEGRACION').trim();
  const clave = (process.env.SIA_SYNC_PASS || '').trim();
  if (!clave) {
    console.error('Falta SIA_SYNC_PASS. Ejemplo (PowerShell):');
    console.error("  $env:SIA_SYNC_PASS='<clave>'; node scripts/sincronizar-docentes-sia.js");
    process.exit(1);
  }

  console.log('SIA:', BASE);
  console.log('Autenticando como', usuario, '...');
  const login = await fetchJson(BASE + '/api/v1/auth/ingresar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sistema': config.siaSistema },
    body: JSON.stringify({ identificador: usuario, clave }),
  });
  if (!login.ok) {
    console.error('Error de login:', login.status, JSON.stringify(login.data && login.data.error ? login.data.error : login.data));
    process.exit(1);
  }
  const token = login.data && login.data.datos && login.data.datos.token;
  if (!token) {
    console.error('No se recibió token.');
    process.exit(1);
  }
  console.log('Login OK. Descargando docentes...');

  const todos = [];
  const vistos = new Set();
  // El SIA documenta /api/v1/docentes, pero en producción la lista de docentes
  // está disponible en /api/v1/personas?tipo=DOCENTE.
  const rutas = [
    (p) => BASE + '/api/v1/personas?tipo=DOCENTE&pagina=' + p + '&limite=100',
    (p) => BASE + '/api/v1/docentes?pagina=' + p + '&limite=100',
  ];
  let rutaIdx = 0;

  let pagina = 1;
  let totalPaginas = 1;

  while (pagina <= totalPaginas) {
    const url = rutas[rutaIdx](pagina);
    const r = await fetchJson(url, {
      headers: { Authorization: 'Bearer ' + token, 'X-Sistema': config.siaSistema },
    });
    if (!r.ok) {
      // Si la ruta principal no existe, intentar la alternativa.
      if (pagina === 1 && r.status === 404 && rutaIdx + 1 < rutas.length) {
        console.log('  Ruta no encontrada, probando alternativa...');
        rutaIdx += 1;
        continue;
      }
      console.error('Error al consultar docentes (página ' + pagina + '):', r.status, JSON.stringify(r.data && r.data.error ? r.data.error : r.data));
      if (pagina === 1) process.exit(1);
      break;
    }
    const lista = extraerLista(r.data).map(normalizar).filter((p) => p.persona_id);
    for (const p of lista) {
      const k = String(p.persona_id);
      if (vistos.has(k)) continue;
      vistos.add(k);
      todos.push(p);
    }
    const meta = r.data && r.data.meta ? r.data.meta : {};
    const tp = Number(meta.total_paginas || meta.paginas || meta.totalPages || 0);
    const tot = Number(meta.total || meta.total_registros || 0);
    if (tp > 0) totalPaginas = tp;
    else if (tot > 0) totalPaginas = Math.ceil(tot / 100);
    else totalPaginas = pagina; // sin paginación
    console.log('  Página ' + pagina + ': ' + lista.length + ' docentes (acumulado ' + todos.length + ')');
    if (lista.length === 0) break;
    pagina += 1;
    if (pagina > 200) break; // seguridad
  }

  console.log('Guardando en caché...');
  let guardados = 0;
  for (const p of todos) {
    await store.upsertCachePersona(p);
    guardados++;
  }

  console.log('Listo. Docentes sincronizados:', guardados);
  console.log('Almacenamiento:', store.backend || 'desconocido');
}

main().catch((e) => {
  console.error('Error:', e && e.message ? e.message : e);
  process.exit(1);
});
