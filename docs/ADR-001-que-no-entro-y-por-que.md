# ADR-001 — Tres patrones de resiliencia que NO entraron, y por qué

**Fecha:** 2026-09-08
**Estado:** aceptado
**Alcance:** el cliente del proveedor de cotizaciones (`src/provider/`)

---

## Contexto

Antes de entregar hice una revisión de qué patrones de resiliencia usan hoy los equipos
que operan esto en serio —Google SRE, Netflix, la literatura de *Release It!*— y comparé
contra lo que este orquestador tiene.

**Lo que sí tiene**, y está en el README con sus valores y su razón:

- timeout por intento, puesto **por encima** de la latencia normal del proveedor
- 3 intentos totales
- backoff exponencial con **full jitter**
- `Retry-After` del proveedor por encima del backoff propio
- clasificación entre errores reintentables y no reintentables
- presupuesto total de latencia que corta aunque queden intentos
- degradación elegante a `PROVIDER_UNAVAILABLE`, nunca un 500 crudo
- validación del cuerpo crudo del proveedor **antes** de normalizarlo

**Lo que le falta**, y es el objeto de este documento: circuit breaker, retry budget
*per-client*, y deadline propagation.

## Decisión

**Ninguno de los tres entra en esta entrega.** Se documentan aquí con su diseño para que
la ausencia sea una decisión declarada y no un descuido.

## Los tres, por orden de valor

### 1. Circuit breaker — el que más falta hace

**El problema:** hoy cada petición reintenta hasta tres veces **sin memoria** de cómo les
fue a las anteriores. Si el proveedor lleva treinta segundos caído, los intentos 2 y 3 de
cada nueva petición sólo añaden carga a algo que ya sabemos muerto, y le quitan al
proveedor el respiro que necesita para levantarse.

**El diseño, si entrara:**

| pieza | valor |
|---|---|
| ventana | últimas 10 **operaciones lógicas** (no intentos) |
| apertura | mínimo 10 muestras y ≥60% de fallos reintentables |
| estado abierto | 15 s, fallando rápido sin tocar al proveedor |
| medio abierto | **exactamente una** sonda; el resto falla rápido |
| sonda OK | cerrar y limpiar la ventana |
| sonda con fallo reintentable | reabrir otros 15 s |
| error **no** reintentable | no cuenta como fallo del breaker — un 400 demuestra que hay conectividad |

**El error clásico que habría que evitar: contar cada intento.** Una petición que agota
sus tres intentos debe aportar **un** fallo a la ventana, no tres. Contar intentos hace
que el breaker se abra tres veces más rápido de lo que su configuración dice, y entonces
nadie entiende por qué corta tanto.

**Por qué no entró:** su valor depende de umbrales calibrados con telemetría real, y aquí
no hay ninguna. Además el estado viviría en memoria de un proceso: no coordina entre
réplicas y se pierde al reiniciar. Añadirlo la víspera de la entrega, apagado por
defecto, habría sido una casilla marcada más que una capacidad — y código nuevo puede
romper el arranque aunque esté desactivado.

### 2. Deadline propagation — el arquitectónicamente más correcto

**El problema:** este servicio fija su propio presupuesto de latencia (9 s) sin saber
cuánto tiempo le queda a quien lo llamó. Si el canal de mensajería ya se rindió a los 5 s,
nosotros seguimos trabajando cuatro segundos más para nadie. El libro de Google SRE lo
nombra explícitamente como defensa contra fallos en cascada: **el plazo se fija arriba en
la pila y se propaga hacia abajo**, en vez de que cada capa invente el suyo.

**El diseño, si entrara:** aceptar una cabecera de plazo (`X-Request-Deadline` o el
estándar `Deadline`), tomar el mínimo entre ese plazo y el presupuesto propio, y pasarlo
hacia abajo en cada llamada al proveedor.

**Por qué no entró:** obliga a definir contrato, unidades, reloj de referencia, qué hacer
con un plazo no confiable del cliente, y cancelación real de lo que ya está en vuelo. Es
más superficie nueva que valor para un ejercicio con un solo cliente.

### 3. Retry budget *per-client* — el que menos aporta **aquí**

**La distinción, que es fina y vale la pena:** el libro de Google SRE describe **dos**
sabores de presupuesto de reintentos.

- *Per-request* — tope de intentos para una petición lógica. **Esto sí está** (3 intentos).
- *Per-client* — el cliente vigila la **proporción** de reintentos sobre el total de
  peticiones y deja de reintentar cuando cruza un umbral (p. ej. 10%). **Esto no está.**

Es lo que impide que una degradación se convierta en avalancha: sin él, cuando el
proveedor empieza a fallar, el tráfico total contra él se **triplica** justo en el peor
momento.

**Por qué no entró:** con un solo cliente y un proveedor simulado en el mismo proceso, no
hay avalancha que prevenir. El patrón resuelve un problema de flota, y aquí no hay flota.

## Consecuencias

- Bajo carga real y con un proveedor degradado, este servicio **amplificaría** el problema
  en lugar de contenerlo. Es una limitación conocida, no una sorpresa.
- El orden de implementación en producción sería el de este documento: breaker, deadline,
  budget.
- Los umbrales del breaker de arriba son un **punto de partida documentado**, no un valor
  medido. La primera semana con telemetría real los cambiaría.

## Lo que sí se hizo con ese tiempo

- Ensayo completo **desde un clon limpio** del repositorio: `npm install` (5.7 s),
  `npm start`, `npm run evidencia` (3/3) y `npm test` (62/62). Verificar que arranca en
  una máquina que no es la mía vale más que una capacidad nueva sin telemetría.
- Una batería adversarial contra el propio guardrail (`npx tsx scripts/adversario.ts`),
  que encontró siete defectos y produjo tres guardas nuevas. Está en el README.
