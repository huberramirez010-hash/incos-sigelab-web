'use strict';

/**
 * Sincroniza carreras y cursos desde el SIA a la caché local (data/cache-academico.json).
 *
 * Uso:
 *   $env:SIA_SYNC_USER='INTEGRACION'
 *   $env:SIA_SYNC_PASS='<clave>'
 *   node scripts/sincronizar-academico-sia.js
 */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const BASE = config.siaUrl;
const CACHE_FILE = path.join(__dirname, '..', 'data', 'cache-academico.json');

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
  if (datos && Array.isArray(datos.carreras)) return datos.carreras;
  if (datos && Array.isArray(datos.cursos)) return datos.cursos;
  if (datos && Array.isArray(datos.items)) return datos.items;
  return [];
}

async function fetchAll(token, rutaBase) {
  const todos = [];
  let pagina = 1;
  let totalPaginas = 1;
  while (pagina <= totalPaginas) {
    const sep = rutaBase.includes('?') ? '&' : '?';
    const url = BASE + rutaBase + sep + 'pagina=' + pagina + '&limite=200';
    const r = await fetchJson(url, {
      headers: { Authorization: 'Bearer ' + token, 'X-Sistema': config.siaSistema },
    });
    if (!r.ok) {
      if (pagina === 1) {
        // intentar sin paginación
        const r2 = await fetchJson(BASE + rutaBase, {
          headers: { Authorization: 'Bearer ' + token, 'X-Sistema': config.siaSistema },
        });
        if (!r2.ok) throw new Error('Error ' + r2.status + ' al consultar ' + rutaBase);
        return extraerLista(r2.data);
      }
      break;
    }
    const lista = extraerLista(r.data);
    todos.push(...lista);
    const meta = r.data && r.data.meta ? r.data.meta : {};
    const tp = Number(meta.total_paginas || meta.paginas || meta.totalPages || 0);
    const tot = Number(meta.total || meta.total_registros || 0);
    if (tp > 0) totalPaginas = tp;
    else if (tot > 0) totalPaginas = Math.ceil(tot / 200);
    else totalPaginas = pagina;
    if (lista.length === 0) break;
    pagina += 1;
    if (pagina > 100) break;
  }
  return todos;
}

async function main() {
  const usuario = (process.env.SIA_SYNC_USER || 'INTEGRACION').trim();
  const clave = (process.env.SIA_SYNC_PASS || '').trim();
  if (!clave) {
    console.error('Falta SIA_SYNC_PASS. Ejemplo (PowerShell):');
    console.error("  $env:SIA_SYNC_PASS='<clave>'; node scripts/sincronizar-academico-sia.js");
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
  console.log('Login OK. Descargando carreras y cursos...');

  const carreras = await fetchAll(token, '/api/v1/carreras');
  console.log('  Carreras:', carreras.length);
  const cursos = await fetchAll(token, '/api/v1/cursos');
  console.log('  Cursos:', cursos.length);

  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = { carreras, cursos, actualizado_en: new Date().toISOString() };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');

  console.log('Listo. Caché guardada en', CACHE_FILE);
}

main().catch((e) => {
  console.error('Error:', e && e.message ? e.message : e);
  process.exit(1);
});
