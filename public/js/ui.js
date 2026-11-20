'use strict';

/* Utilidades de interfaz compartidas por todas las pantallas. */

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function q(sel, root) {
  return (root || document).querySelector(sel);
}

function qa(sel, root) {
  return Array.from((root || document).querySelectorAll(sel));
}

function fmtFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  try {
    return d.toLocaleString('es-BO', {
      timeZone: 'America/La_Paz',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (e) {
    return String(iso);
  }
}

function estadoBadge(estado) {
  const mapa = { OPERATIVO: 'ok', EN_MANTENIMIENTO: 'warn', DE_BAJA: 'danger' };
  const clase = mapa[estado] || 'neutral';
  const texto = String(estado || '').replace(/_/g, ' ');
  return '<span class="badge badge-' + clase + '">' + esc(texto) + '</span>';
}

function tipoBadge(tipo) {
  return '<span class="badge badge-neutral">' + esc(tipo || '—') + '</span>';
}

function montarNavegacion(activo) {
  const cont = q('#topbar');
  if (!cont) return;

  cont.className = 'topbar';

  const u = API.usuario() || {};
  const permisos = API.permisos() || {};
  const cargo = (permisos.cargos || []).join(', ');

  const enlaces = [
    { id: 'dashboard', href: '/index.html', texto: 'Dashboard' },
    { id: 'inventario', href: '/inventario.html', texto: 'Inventario' },
    { id: 'equipos', href: '/equipos.html', texto: 'Equipos' },
    { id: 'ambientes', href: '/ambientes.html', texto: 'Ambientes' },
    { id: 'reportes', href: '/reportes.html', texto: 'Reportes' },
  ];

  // Enlaces exclusivos del Encargado (canManage).
  if (permisos.canManage) {
    enlaces.splice(1, 0, { id: 'solicitudes', href: '/solicitudes.html', texto: 'Solicitudes' });
    enlaces.push({ id: 'usos', href: '/usos.html', texto: 'Uso de labs' });
  }

  cont.innerHTML =
    '<div class="inner">' +
    '<a class="brand" href="/index.html"><span class="dot"></span>SIGELAB <small>INCOS</small></a>' +
    '<nav class="nav">' +
    enlaces
      .map(
        (e) =>
          '<a href="' + e.href + '"' + (e.id === activo ? ' class="active"' : '') + '>' + e.texto + '</a>'
      )
      .join('') +
    '</nav>' +
    '<div class="user">' +
    '<div class="user-info">' +
    '<span class="user-name">' + esc(u.nombre || 'Usuario') + '</span>' +
    '<span class="user-role">' + esc(cargo || permisos.rol || '') + '</span>' +
    '</div>' +
    '<button class="btn btn-ghost btn-sm" id="logoutBtn" type="button">Salir</button>' +
    '<a class="topbar-logo" href="/index.html" title="INCOS-BENI" aria-label="Ir al inicio">' +
    '<img src="/img/logo-sia.jpeg" alt="Logo INCOS-BENI" />' +
    '</a>' +
    '</div>' +
    '</div>';

  const btn = q('#logoutBtn');
  if (btn) btn.addEventListener('click', salir);
}

async function montarEstadoSia() {
  const cont = q('#siaStatus');
  if (!cont) return;

  try {
    const s = await API.salud();
    const conectado = s.siaEstado === 'CONECTADO';
    cont.className = 'status-strip ' + (conectado ? 'ok' : 'off');
    const clave = s.jwt && s.jwt.claveCacheada ? 'clave pública en caché' : 'clave no disponible';
    cont.innerHTML =
      '<span class="dot"></span>' +
      '<span>Núcleo SIA: <strong>' + (conectado ? 'CONECTADO' : 'SIN CONEXIÓN') + '</strong></span>' +
      '<span class="small">' + esc(s.siaUrl || '') + '</span>' +
      (conectado ? '' : '<span class="badge badge-warn">Modo lectura</span>') +
      '<span class="spacer"></span>' +
      '<span class="small">JWT: ' + esc(clave) + '</span>';
  } catch (e) {
    cont.className = 'status-strip off';
    cont.innerHTML = '<span class="dot"></span><span>No se pudo consultar el estado del demo.</span>';
  }
}

function mostrarAlerta(contenedor, mensaje, tipo) {
  const el = typeof contenedor === 'string' ? q(contenedor) : contenedor;
  if (!el) return;
  el.innerHTML = '<div class="alert alert-' + (tipo || 'danger') + '">' + esc(mensaje) + '</div>';
}

function limpiarAlerta(contenedor) {
  const el = typeof contenedor === 'string' ? q(contenedor) : contenedor;
  if (el) el.innerHTML = '';
}

/**
 * Modal reutilizable.
 * opciones: { titulo, html, textoConfirmar, peligro, onConfirmar(modal) }
 * onConfirmar puede lanzar un Error para mostrar el mensaje sin cerrar.
 */
function abrirModal(opciones) {
  const o = opciones || {};
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true">' +
    '<div class="modal-head"><h3>' + esc(o.titulo || '') + '</h3>' +
    '<button class="modal-close" type="button" aria-label="Cerrar">&times;</button></div>' +
    '<div class="modal-body">' + (o.html || '') + '</div>' +
    '<div class="modal-foot">' +
    '<button class="btn btn-outline" type="button" data-cancelar>Cancelar</button>' +
    '<button class="btn ' + (o.peligro ? 'btn-danger' : 'btn-primary') + '" type="button" data-confirmar>' +
    esc(o.textoConfirmar || 'Guardar') +
    '</button></div></div>';

  document.body.appendChild(wrap);

  function cerrar() {
    wrap.remove();
  }

  wrap.querySelector('.modal-close').addEventListener('click', cerrar);
  wrap.querySelector('[data-cancelar]').addEventListener('click', cerrar);
  wrap.addEventListener('click', function (ev) {
    if (ev.target === wrap) cerrar();
  });

  const boton = wrap.querySelector('[data-confirmar]');
  boton.addEventListener('click', async function () {
    const textoOriginal = boton.textContent;
    boton.disabled = true;
    boton.textContent = 'Procesando...';
    try {
      const resultado = await o.onConfirmar(wrap);
      if (resultado !== false) cerrar();
    } catch (e) {
      let err = wrap.querySelector('.modal-error');
      if (!err) {
        err = document.createElement('div');
        err.className = 'alert alert-danger modal-error';
        wrap.querySelector('.modal-body').prepend(err);
      }
      err.textContent = e.message || 'Ocurrió un error.';
      boton.disabled = false;
      boton.textContent = textoOriginal;
    }
  });

  return { wrap: wrap, cerrar: cerrar, cuerpo: wrap.querySelector('.modal-body') };
}

function opcionesSelect(lista, seleccionado) {
  return lista
    .map(function (v) {
      const valor = typeof v === 'string' ? v : v.valor;
      const texto = typeof v === 'string' ? v.replace(/_/g, ' ') : v.texto;
      return (
        '<option value="' + esc(valor) + '"' +
        (String(valor) === String(seleccionado) ? ' selected' : '') +
        '>' + esc(texto) + '</option>'
      );
    })
    .join('');
}
