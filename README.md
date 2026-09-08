# Orquestador de cotizaciones — prueba técnica de Integración de IA

Recibe una petición en lenguaje natural, extrae datos estructurados con ayuda de un LLM y
consulta un proveedor de cotizaciones inestable sin perder control operativo.

**Proveedor de LLM usado: `mock` por defecto (extractor determinista, sin red ni claves).
Incluye adaptadores reales de `ollama` y `gemini` detrás de la misma interfaz, y ambos se
activan con una variable de entorno.** El porqué de ese default está en
[Decisiones de criterio](#decisiones-de-criterio).

---

## Ejecutar (3 comandos)

```bash
npm install
npm start           # servidor en http://127.0.0.1:3000
npm run evidencia   # ejecuta los 3 escenarios y escribe evidencia/
```

`npm test` corre 34 pruebas unitarias. No hace falta `.env`: todos los valores tienen
default y la solución arranca sin configurar nada.

Requiere Node ≥ 18.18. Probado en Node 24.18.0, Windows 11.

### Probar a mano

Los cuerpos de ejemplo están en `ejemplos/`, con acentos ya codificados en UTF-8:

```bash
curl -X POST http://127.0.0.1:3000/quote \
  -H "Content-Type: application/json" \
  --data-binary @ejemplos/exito.json

curl -X POST http://127.0.0.1:3000/quote \
  -H "Content-Type: application/json" \
  --data-binary @ejemplos/incompleto.json
```

> Se usa `--data-binary @archivo` y no `-d '{...}'` a propósito: en Git Bash sobre Windows,
> pasar acentos en la línea de comandos altera los bytes y `Content-Length` deja de cuadrar,
> así que la petición se rechaza antes de llegar a la aplicación. Con archivo funciona en
> cualquier shell.

---

## Contrato de salida

Tres estados excluyentes, siempre identificables por el campo `status`.

| estado | HTTP | cuándo |
|---|---|---|
| `QUOTED` | 200 | hubo cotización |
| `NEEDS_INFO` | 200 | faltó información; **no se llamó al proveedor** |
| `PROVIDER_UNAVAILABLE` | 503 + `Retry-After` | se llamó y no se pudo |
| `BAD_REQUEST` | 400 | el cuerpo de la petición no cumple el contrato de entrada |

`NEEDS_INFO` va con 200 a propósito: la petición estaba bien formada y el sistema responde
lo que corresponde. Es un turno normal de conversación en un canal de mensajería, no un
error del cliente. `PROVIDER_UNAVAILABLE` va con 503 porque es exactamente lo que
significa y le dice a quien integra que puede reintentar — y **no es "un 500 crudo"**: el
cuerpo es estructurado, sin excepción ni traza.

```jsonc
// QUOTED
{
  "status": "QUOTED",
  "quote": {
    "origin": "Ciudad de México", "destination": "Monterrey",
    "weight_kg": 8, "service_type": "express", "package_count": 1,
    "amount": 560, "currency": "MXN", "provider": "mock-carrier",
    "eta_days": 2, "quote_reference": "MC-000001"   // extras propios, documentados
  },
  "assumptions": [                                   // supuestos DECLARADOS, nunca silenciosos
    { "field": "package_count", "value": 1,
      "reason": "el mensaje no lo especifica; se aplica el valor por defecto declarado del contrato" }
  ],
  "meta": { "request_id": "...", "llm_provider": "mock:reglas-deterministas",
            "provider_attempts": 1, "duration_ms": 2679 }
}
```

`meta.provider_attempts` es la pieza de observabilidad que más se usa al operar: dice si
la respuesta salió a la primera o si el proveedor está degradándose. En `NEEDS_INFO`
siempre vale `0`, y eso **prueba** que el guardrail cortó antes de gastar la llamada.

---

## Arquitectura

```
POST /quote
   │
   ├─ 1. Zod valida el sobre de entrada ─────────────────► 400 si no cumple
   │
   ├─ 2. Adaptador de LLM  (mock | ollama | gemini)
   │        devuelve JSON CRUDO, sin validar
   │
   ├─ 3. GUARDRAIL DETERMINISTA  (src/extractor.ts)
   │        · valida campo a campo
   │        · descarta null, vacíos y marcadores de ausencia
   │        · aplica defaults DECLARADOS
   │        └─ ¿falta un obligatorio? ──────────────────► NEEDS_INFO   (no se llama al carrier)
   │
   └─ 4. Cliente resiliente ──► POST /mock-carrier/quote
            timeout por intento · presupuesto total
            backoff exponencial con full jitter · Retry-After
            └─ agotado ───────────────────────────────► PROVIDER_UNAVAILABLE
            └─ 200 ─► validar cuerpo crudo ─► normalizar ─► QUOTED
```

Un mensaje incompleto **no puede** llegar al carrier ni por accidente: el cliente sólo
acepta el tipo `PeticionCompleta`, y ese tipo únicamente se construye después de pasar la
validación. La garantía la sostiene el compilador, no la disciplina de quien edite.

| archivo | responsabilidad |
|---|---|
| `src/schema.ts` | **fuente única** del modelo de datos |
| `src/config.ts` | **toda** la política operativa, leída una vez al arrancar |
| `src/llm/` | adaptadores; devuelven JSON crudo sin validar |
| `src/extractor.ts` | el guardrail: decide completo vs `NEEDS_INFO` |
| `src/provider/cliente-resiliente.ts` | timeout, reintentos, backoff, clasificación |
| `src/provider/carrier-mock.ts` | el proveedor inestable |
| `src/provider/normalizar.ts` | valida el cuerpo crudo y lo traduce al contrato |
| `src/orquestador.ts` | une las piezas y produce los tres estados |

---

## Configurar el proveedor de LLM

```bash
LLM_PROVIDER=mock      # default. Determinista, sin red, sin claves.
LLM_PROVIDER=ollama    # modelo local. Requiere `ollama serve` y el modelo descargado.
LLM_PROVIDER=gemini    # Google AI Studio. Requiere GEMINI_API_KEY.
```

Con Ollama:

```bash
ollama pull qwen2.5:3b
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:3b npm start
```

Los tres usan **salida estructurada forzada** (`format` en Ollama, `responseSchema` en
Gemini): decodificación restringida, no "responde en JSON, por favor".

**La clave de Gemini nunca se versiona.** Va en `.env` —que está en `.gitignore`— y viaja
en cabecera, no en la URL, porque las URL terminan en logs. Si se pide `gemini` sin clave,
**el proceso no arranca**: falla cerrado, nada de `if (clave && ...)` que degrade en
silencio a un camino sin autenticar.

---

## Reproducir la caída del proveedor

Todo se controla por configuración:

```bash
CARRIER_FAILURE_RATE=1    npm start   # el carrier falla SIEMPRE  -> PROVIDER_UNAVAILABLE
CARRIER_FAILURE_RATE=0    npm start   # nunca falla               -> QUOTED
CARRIER_FAILURE_RATE=0.25 npm start   # default del enunciado
CARRIER_SEED=promass-2026 npm start   # secuencia de fallos reproducible
```

`npm run evidencia` hace justamente eso: levanta el servidor tres veces con tres
configuraciones y guarda las respuestas reales en `evidencia/`.

---

## Límites elegidos, y por qué

| parámetro | valor | razón |
|---|---|---|
| `PROVIDER_MAX_ATTEMPTS` | **3 totales** | Son 3 llamadas, no 1 + 3 reintentos. La ambigüedad de ese número es una fuente clásica de tráfico fantasma. |
| `PROVIDER_TIMEOUT_MS` | **3500** | Por **encima** de la latencia normal del carrier (1000-3000 ms). Con 2500 el timeout cae dentro de la franja sana y aborta ~25% de llamadas que iban bien: el sistema se fabricaría sus propios fallos. Medido: con 2500 el caso de éxito gastaba 2 intentos y 4.8 s; con 3500 gasta 1 intento y 2.7 s. |
| `PROVIDER_TOTAL_BUDGET_MS` | **9000** | Techo de latencia de cara al usuario, esperas incluidas. Corta aunque queden intentos: sin él, `intentos × timeout + backoff` deja al usuario esperando un total que nadie decidió. |
| `PROVIDER_BACKOFF_BASE_MS` / `CAP` | **250 / 4000** | Full jitter: `random(0, min(cap, base · 2^intento))`. |
| Reintentables | 408, 425, 429, 5xx, timeouts, fallos de red | Hay algo que reintentar. |
| No reintentables | resto de 4xx | Un 422 repetido da 422. Reintentarlo sólo gasta latencia del usuario y cuota del proveedor. |
| `Retry-After` | manda sobre el backoff | Si el proveedor dice cuánto esperar, sabe más que nuestra fórmula. |

**Por qué full jitter y no sólo backoff exponencial.** Sin jitter, N clientes que fallan a
la vez reintentan en el *mismo* milisegundo, y otra vez al doble, y otra al cuádruple: el
backoff exponencial solo no dispersa la manada, la sincroniza. Full jitter reparte cada
reintento por toda la ventana. Se eligió sobre *equal jitter* porque en la simulación
publicada por AWS equal jitter hace más trabajo y tarda más, y full jitter no guarda
estado más allá del número de intento.
Referencia: [Exponential Backoff And Jitter, Marc Brooker, AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).

---

## Decisiones de criterio

### 1. Por qué el default es el Mock y por qué eso no es esconderse

La prueba pide que corra **en local, sin costo, en 3 comandos**. Si el arranque por
defecto dependiera de un demonio de Ollama con un modelo de 2 GB descargado, o de una
clave de Gemini, la solución no arrancaría en la máquina de quien evalúa — y se perdería
por algo que no es el código. Además, la evidencia de los tres escenarios debe ser
**reproducible**: un modelo generativo no devuelve lo mismo dos veces.

El mock **no sustituye al guardrail ni cambia el pipeline**. Se conecta por la misma
interfaz, devuelve el mismo JSON crudo sin validar y atraviesa exactamente las mismas
validaciones. Que `LLM_PROVIDER=ollama` no toque una sola línea de lógica de negocio es
justamente la prueba de que la integración está bien separada.

### 2. La contradicción de `package_count`, y cómo se resuelve

El enunciado prohíbe rellenar campos faltantes con "valores inventados o supuestos
silenciosos". Pero su propio caso de éxito muestra `package_count: 1` a partir de un
mensaje que **no menciona ningún paquete**. Las dos cosas no pueden ser ciertas a la vez.

La palabra que decide es **"silenciosos"**. Aquí:

- `origin`, `destination`, `weight_kg` y `service_type` **no tienen default**. Si falta
  uno, el flujo se detiene con `NEEDS_INFO`.
- `package_count` tiene un default **declarado** de 1 — escrito en el registro de campos,
  aplicado por código y **anunciado en la respuesta** dentro de `assumptions[]`, con su
  motivo.

Un supuesto declarado y auditable no es un supuesto silencioso. Devolver `NEEDS_INFO` para
el mensaje canónico habría contradicho el ejemplo del propio enunciado; rellenarlo callando
habría violado la regla. Hacerlo visible cumple las dos.

### 3. El esquema tiene dos niveles, no uno

- `EsquemaCandidato` — estricto en tipos y en claves desconocidas, pero **permite
  omisiones**. Que el usuario no diga el destino es un caso normal del negocio, no un fallo
  del extractor.
- `EsquemaPeticionCompleta` — todo obligatorio. Es lo único que cruza hacia el proveedor.

Y el JSON Schema que se le pasa al modelo **no marca ningún campo como `required`**.
Forzar a un modelo a emitir `destination` cuando el mensaje no lo menciona no consigue el
destino: consigue que se lo invente, porque la decodificación restringida le prohíbe
omitirlo. La obligatoriedad es una regla de negocio y la aplica el guardrail, no el modelo.

**`null` no se acepta.** Ausencia significa "no venía en el mensaje"; un `null` explícito
sería el modelo afirmando un vacío.

### 4. Marcadores de ausencia: una guarda que existe por un fallo medido

Probando con `llama3.2:3b` el mensaje *"Necesito enviar 8 kg desde Ciudad de México por
servicio exprés"* (sin destino), el modelo devolvió:

```json
{ "destination": "(omitiendo este dato)", ... }
```

Obligado por la decodificación restringida a producir un string, escribió su excusa
**dentro del valor**. Esa cadena pasaba la validación de ciudad —tiene más de dos
caracteres— y el sistema habría cotizado un envío a una ciudad llamada
*"(omitiendo este dato)"*.

Restringir la **forma** de la salida no impide que el **contenido** sea una confesión de
ausencia. Por eso los campos de texto libre rechazan además marcadores de ausencia
(`(...)`, `N/A`, `desconocido`, `no especificado`, `null`, `???`…), con pruebas que
comprueban que ninguna ciudad mexicana real cae en la trampa.

### 5. La elección del modelo local es una decisión, no un detalle de instalación

`scripts/comparar-modelos.ts` la convierte en una medición repetible: cuatro mensajes,
campo a campo, contra los modelos que se le pasen. **Omitir un campo ausente cuenta como
acierto** — un modelo que rellena todo saca peor nota que uno que calla.

```bash
npx tsx scripts/comparar-modelos.ts llama3.2:3b qwen2.5:3b
```

Medido en este equipo (Ryzen 5 PRO 4650U, CPU sin aceleración, 4 mensajes):

| modelo | aciertos | tiempo |
|---|---|---|
| `llama3.2:3b` | 19/20 | 34.6 s |
| `qwen2.5:3b` | 19/20 | 34.8 s |

**Y el hallazgo, que fue contraintuitivo: el modelo no era el cuello de botella, el prompt
sí.** La primera corrida de `llama3.2:3b` fue mala —omitió tres campos y devolvió
`package_count: 8` confundiendo el peso con la cantidad de bultos— pero con un prompt sin
ejemplos. Añadiendo dos ejemplos que **demuestran la omisión** y una línea que separa
explícitamente peso de bultos, el mismo modelo pasó a acertar el caso canónico completo.
Cambiar de familia de modelos después no movió la aguja: los dos empatan.

La conclusión operativa vale más que el número: **antes de escalar de modelo, agotar el
prompt**, porque escalar cuesta RAM, latencia y dinero, y el prompt cuesta diez minutos.
Ambos modelos fallan el mismo caso (`"3 cajas de 12 kg"`), que además es genuinamente
ambiguo —¿12 kg en total o cada una?— y donde omitir es defendible: el default declarado
se aplica y se anuncia.

Detalle campo a campo en [`evidencia/modelos.md`](evidencia/modelos.md).

---

## Supuestos

- El carrier es un mock en el mismo proceso, expuesto por HTTP (`POST /mock-carrier/quote`)
  y no como función en memoria: así el timeout, el `AbortSignal` y el `Retry-After` son
  reales y no simulaciones.
- Las tarifas son deterministas (base + peso + bultos, por multiplicador de servicio) para
  que la evidencia sea comprobable.
- Los nombres de ciudad se toman tal cual los escribe el usuario. No hay catálogo de
  ciudades ni geocodificación: validar que "Monterrey" existe es otro problema.
- Un solo idioma de entrada (español). Los sinónimos de servicio están en el registro de
  campos y se amplían ahí.

---

## Qué dejaría listo para producción

**1. Idempotencia de verdad.** El endpoint ya acepta `Idempotency-Key` y no repite el
trabajo, pero el almacén **vive en memoria del proceso**: no sobrevive a un reinicio ni se
comparte entre réplicas, así que con dos instancias detrás de un balanceador dos clics
simultáneos pueden cotizar dos veces. En producción va en base de datos, con la clave
única `(tenant, idempotency_key)` y una máquina de tres estados:

- `claimed` — es tuyo, procesa
- `completed` — ya se hizo, devuelve la respuesta guardada
- `busy` — otro proceso lo tiene en curso ahora mismo → 409/503

Y la pieza que casi siempre falta: **rescate de concesión vencida**. Si el worker muere a
media tarea, sin un `claimed_at < now() - interval '10 minutes'` en la condición del
reclamo, ese evento queda bloqueado para siempre.

**2. Circuit breaker y retry budget.** Hoy cada petición reintenta hasta 3 veces sin saber
nada de las demás. Si el proveedor lleva 30 segundos caído, los intentos 2 y 3 sólo añaden
carga a algo que ya sabemos muerto. Un breaker que abre tras N fallos consecutivos
devuelve `PROVIDER_UNAVAILABLE` de inmediato y deja al proveedor recuperarse; un retry
budget global (p. ej. reintentos ≤ 10% del tráfico) impide que una degradación se convierta
en una avalancha.

**3. Aislamiento de credenciales por cliente (multi-inquilino).** Nunca un mapa de claves
en memoria ni una variable por cliente. Cada tenant resuelve su credencial en el momento
de usarla contra un gestor de secretos (Vault, AWS Secrets Manager, Key Vault) con
identidad de carga de trabajo, cacheada en memoria con TTL corto y **jamás** escrita en
disco ni en logs. El `tenant_id` viaja en el contexto de la petición y el cliente del
proveedor se construye por petición, no una vez al arrancar — que es precisamente el error
que haría que el tenant B usara la conexión del tenant A. Y una guarda que no encuentra la
credencial de un tenant **deniega**, no cae a una credencial por defecto.

**4. Observabilidad.** `request_id` ya viaja en cada respuesta y en los logs. Faltarían
trazas distribuidas (OpenTelemetry) para ver el árbol de reintentos, y métricas por estado,
por intento y por latencia del proveedor — que es la señal que anticipa la caída antes de
que se convierta en `PROVIDER_UNAVAILABLE`.

**5. Lo que falta y no es código.** Límite de tamaño y rate limit por `user_id`, validación
de que la ciudad existe contra un catálogo, y una política de retención para los mensajes
de usuario, que son datos personales en cuanto alguien escribe una dirección.

---

## Estructura

```
src/
  schema.ts                      fuente única del modelo de datos
  config.ts                      toda la política operativa
  extractor.ts                   el guardrail determinista
  orquestador.ts                 une las piezas, produce los 3 estados
  server.ts                      rutas HTTP + el mock del carrier
  llm/{index,mock,ollama,gemini}.ts
  provider/{cliente-resiliente,cliente-cotizacion,carrier-mock,normalizar}.ts
test/                            34 pruebas, sin esperas reales
scripts/
  evidencia.ts                   genera evidencia/ ejecutando los 3 escenarios
  comparar-modelos.ts            mide modelos locales campo a campo
evidencia/                       salida real, nada escrito a mano
```
