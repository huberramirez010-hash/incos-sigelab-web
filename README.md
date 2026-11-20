# SIGELAB-INCOS

**Sistema de laboratorios, ambientes e inventario de equipos** del ecosistema INCOS-BENI.

Demo conforme al **Contrato de Conformidad v1.1.0** (núcleo SIA-INCOS). La autenticación institucional se delega en el SIA y solo se guarda `persona_id`. Como **módulo adicional**, existen cuentas locales SIGELAB con verificación por Gmail/WhatsApp, solicitud con rol y aprobación por el administrador (no reemplaza la identidad del SIA).

> **Repositorio:** <https://github.com/huberangelramireznery-jpg/incos-sigelab-web>

---

## 1. Qué hace

- Registra **ambientes** (laboratorios, datacenter, taller) con un responsable del SIA.
- Registra **equipos** con código de activo único, tipo, marca, modelo y características.
- Mantiene el **inventario** con filtros por ambiente, estado, tipo y texto.
- Permite **cambiar el estado** de un equipo (OPERATIVO / EN_MANTENIMIENTO).
- Aplica **baja lógica** (`DE_BAJA`), conservando el historial y sin reutilizar el código.
- Guarda **historial de estados** (una fila por cambio, con `persona_id`).
- Guarda **auditoría** de altas, ediciones y bajas.
- Muestra un **dashboard** con tarjetas por ambiente y resumen por estado.
- Permite **crear cuentas locales SIGELAB** (Gmail + WhatsApp) con rol solicitado y aprobación/rechazo del Encargado.
- Envía **códigos de 4 dígitos** para verificar la cuenta y para recuperar la contraseña.

---

## 2. Requisitos

- **Node.js 18 o superior**.
- Conexión a internet para usar el SIA de producción o servicios reales de correo/WhatsApp.

---

## 3. Arranque rápido

```bash
npm install
npm start
```

Abrir: <http://127.0.0.1:4100>

`npm start` levanta la **aplicación SIGELAB** en el puerto 4100. Si `API_ACADEMICO_URL` apunta al simulador local (`http://127.0.0.1:3000`), también levanta el **núcleo SIA simulado**. Con la URL de producción solo se levanta SIGELAB.

El archivo `.env` está versionado **sin secretos**:

```env
API_ACADEMICO_URL=https://sia-incos-api-production.up.railway.app
PORT=4100
DB_BACKEND=auto
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
FIREBASE_PROJECT_ID=incos-sigelab-2026
AUTH_DEMO_CODES=true
WHATSAPP_PROVIDER=demo
SIA_SISTEMA=SIGELAB
```

**Almacenamiento automático (`DB_BACKEND=auto`):**
- Si existe `serviceAccountKey.json` → usa **Firebase Firestore**.
- Si no existe → usa el archivo local `data/store.json`.

**Firebase (proyecto creado):** `incos-sigelab-2026`, Firestore `(default)`, región `southamerica-east1`. Credenciales en `serviceAccountKey.json` (ignorado por Git).

### Conectar con el SIA real

El `.env` ya apunta al núcleo de producción:

```env
API_ACADEMICO_URL=https://sia-incos-api-production.up.railway.app
PORT=4100
SIA_SISTEMA=SIGELAB
```

No se cambia código de aplicación (regla del contrato).

- **Header de identificación:** todas las llamadas al SIA (login, JWKS, estado, personas y cargos) envían `X-Sistema: SIGELAB` para que el panel del SIA identifique la conexión (configurable con `SIA_SISTEMA`).
- **JWT/rotación:** el SIA publica su JWKS en `/.well-known/jwks.json`. El cliente selecciona la clave por el `kid` del token (actual `sia-2026-2`), no por posición; si el par RSA rota, se recarga el JWKS y se reintenta la validación una vez. Respaldo: `/api/v1/auth/clave-publica`.
- **Cuenta técnica `INTEGRACION`:** la clave no se guarda en el repo. Para pruebas locales usar `.env.local` (ignorado por Git) o el gestor de secretos del despliegue.

Para volver al simulador local: `API_ACADEMICO_URL=http://127.0.0.1:3000` y `npm start`.

---

## 4. Cuentas de acceso

### 4.1 Cuentas SIA (institucional, principal)

El login se realiza contra `POST /api/v1/auth/ingresar` del SIA. Los permisos salen de `roles.SIGELAB` y de los **cargos** del token (nunca de tablas locales).

**Cuentas de demostración (solo simulador local, `http://127.0.0.1:3000`)**  
Contraseña única: `Demo2026*` (estas cuentas **no** existen en el SIA de producción).

| Cédula | Nombre | Rol SIGELAB | Cargo | Acceso |
|---|---|---|---|---|
| 9000006 | Luis Fernando Añez Rivero | ADMINISTRATIVO | Encargado de Laboratorios | Gestión completa |
| 9000007 | Patricia Gutiérrez Nazareno | SERVICIO | Técnico de Laboratorio | Consultar y cambiar estado |
| 9000001 | Ana María Rojas Vaca | ADMINISTRATIVO | Rector | Solo lectura |
| 9000002 | Carlos Eduardo Méndez Suárez | ADMINISTRATIVO | Académico | Solo lectura |
| 9000005 | Juan Pablo Quiroga Salas | Sin acceso | — | 403 (prueba) |
| 9000003 | María Elena Chávez Ortiz | ADMINISTRATIVO | Administrativo | 403 (sin rol SIGELAB) |

### 4.2 Cuentas locales SIGELAB (módulo adicional)

Registro con **correo Gmail** (`@gmail.com`/`@googlemail.com`), **WhatsApp** con código de país (ej. `+591`) y contraseña (mín. 8 caracteres, con letra y número).

**Flujo:**
1. En `/registro.html` se elige el **rol/cargo solicitado** (`Consulta`, `Técnico de Laboratorio` o `Encargado de Laboratorios`) y se envían códigos de 4 dígitos al correo y al WhatsApp.
2. El código de correo verifica el correo; el de WhatsApp confirma el número. La cuenta queda **`PENDIENTE`**.
3. Un **Encargado** revisa en `/solicitudes.html` y **aprueba** (puede asignar otro rol) o **rechaza** la solicitud.
4. Con la solicitud **aprobada** y el correo verificado, el usuario ingresa en `/login.html` (pestaña **Cuenta SIGELAB**).
5. Recuperación de contraseña en `/recuperar.html` con código por Gmail o WhatsApp.

**Modo demo (por defecto):** `AUTH_DEMO_CODES=true`, `WHATSAPP_PROVIDER=demo` — los códigos se muestran en pantalla y en consola (sin credenciales externas).

**Envío real:** configurar en `.env.local` (ignorado por Git). El registro en modo real exige ambos canales configurados (Gmail y WhatsApp).
- Gmail SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (usar contraseña de aplicación).
- WhatsApp: `WHATSAPP_PROVIDER=twilio` (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`) o `WHATSAPP_PROVIDER=meta` (`META_WHATSAPP_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`).
- Activar envío real: `AUTH_DEMO_CODES=false`.

---

## 5. Reglas de permisos

Los permisos salen del **claim `roles`** y de los **cargos** del token del SIA (nunca de tablas locales).

| Rol `roles.SIGELAB` | Cargo | Permisos |
|---|---|---|
| `ADMINISTRATIVO` | Encargado de Laboratorios | Gestión completa (ambientes, equipos, bajas, estado, auditoría, solicitudes) |
| `SERVICIO` | Técnico de Laboratorio | Consultar inventario y cambiar estado |
| `ADMINISTRATIVO` | Otro (Rector, Académico, etc.) | Solo lectura |
| Sin `SIGELAB` en `roles` | — | 403 al ingresar |

> Nota: roles/cargos generales del ecosistema (DOCENTE, ESTUDIANTE, etc.) no otorgan permisos en SIGELAB por sí mismos; se requiere que el token incluya `roles.SIGELAB` y el cargo correspondiente.

---

## 6. Qué consume del SIA y por qué

| Dato / endpoint | Para qué | Motivo |
|---|---|---|
| `POST /api/v1/auth/ingresar` | Login y obtención de JWT | No se validan contraseñas institucionales localmente |
| `GET /.well-known/jwks.json` (+ PEM respaldo) | Validar firma `RS256` (kid rotatorio) | Confiar en tokens emitidos por el SIA |
| Claims (`sub`/`persona_id`, `roles`, `cargos`, `ci`, `nombre`) | Identidad y permisos | Autorización centralizada; solo se guarda `persona_id` |
| `GET /api/v1/personas` | Listar/seleccionar responsables y mostrar nombres | Directorio institucional (caché de lectura) |
| `GET /api/v1/personas/:id/cargos` | Consultar cargos de una persona | Asignación/visualización coherente |
| `GET /api/v1/estado` | Estado del núcleo | `/salud-integracion` y modo lectura si el SIA cae |

**No** se accede a la base MySQL del núcleo ni se duplican contraseñas/identidades institucionales.

---

## 7. Reglas de negocio

- **Código de activo único:** duplicado → `400 REGISTRO_DUPLICADO`.
- **Baja lógica:** estado `DE_BAJA`; se conserva historial y el código no se reutiliza.
- **Ambiente con equipos:** no se puede dar de baja (`409 CONFLICTO`), sin borrado en cascada.
- **Cambio de estado:** inserta fila en `sigelab_historial_estados` con el `persona_id` que lo realizó.
- **Límite de 20 equipos por sala:** informativo (advertencia).

---

## 8. Endpoints principales

Respuestas con sobre: `{ "exito": true/false, "datos": {}, "meta": null, "error": null }`.

**Auth (SIA y local):** `POST /api/auth/login`, `POST /api/auth/login-local`, `POST /api/auth/registro`, `POST /api/auth/verificar-codigo`, `POST /api/auth/reenviar-codigo`, `POST /api/auth/recuperar`, `POST /api/auth/restablecer`, `GET /api/auth/me`, `GET /api/auth/config`, `GET/POST /api/auth/solicitudes*` (aprobación/rechazo, Encargado).

**Negocio:** `/api/dashboard`, `/api/ambientes`, `/api/equipos`, `/api/equipos/:id/estado`, `/api/equipos/:id/historial`, `/api/auditoria`, `/api/personas`.

**Salud (contrato):** `GET /salud-integracion` (público), `GET /health`.

---

## 9. Seguridad e integración

- Login SIA delegado al núcleo; JWT validado en servidor (`RS256`, `kid`, reintento tras rotación).
- Cuentas locales: contraseñas con `scrypt`, JWT propio (`HS256`, `sigelab-local`, `token_version` para invalidar sesiones).
- Códigos (4 dígitos) como HMAC, con vencimiento, límite de intentos y reenvíos.
- Si el SIA no responde: modo lectura con datos/cache y reporte en `/salud-integracion`.
- Solo `persona_id` persistido; nombres como caché. Sin acceso a MySQL del núcleo.

---

## 10. Verificación

```bash
npm run verify
```

- **SIA de producción (sin cuentas demo):** valida endpoints públicos y JWKS. Resultado esperado: **14 pruebas aprobadas, 0 fallidas**. (Opcional: `SIA_TEST_USER`/`SIA_TEST_PASS` en entorno para probar un login real; no guardar la clave en el repo).
- **Simulador local (suite completa):** con `API_ACADEMICO_URL=http://127.0.0.1:3000`, `npm start` y `npm run verify`. Cubre conformidad, login SIA, permisos, cuentas locales (registro/verificación/rol/aprobación/rechazo/recuperación), reglas de equipos/estados/ambientes. Resultado esperado: **77 pruebas aprobadas, 0 fallidas**.

---

## 11. Estructura

`public/` (frontend), `src/` (server, config, `sia/`, `middleware/`, `routes/`, `services/`, `db/`, `utils/`), `mock-sia/` (simulador), `scripts/` (verificación), `firebase.json`, `firestore.rules`, `data/` (local), `.env`/`.env.example`.

---

**Equipo SIGELAB-INCOS · Ecosistema INCOS-BENI · 2026**
