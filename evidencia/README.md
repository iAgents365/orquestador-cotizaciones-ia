# Evidencia de los tres escenarios

Generada por `npm run evidencia`. Nada aqui esta escrito a mano: cada bloque es la
respuesta real del servidor a una peticion HTTP real.

Proveedor de LLM: `mock` · semilla del carrier: `promass-2026`

## Caso exitoso — cotizacion procesada

Mensaje completo. El guardrail deja pasar, el carrier responde y la respuesta cruda se normaliza al contrato.

Configuracion del escenario: `CARRIER_FAILURE_RATE=0 CARRIER_MIN_LATENCY_MS=1000 CARRIER_MAX_LATENCY_MS=3000`

**Peticion**

```json
{
  "user_id": "candidate-001",
  "channel": "webchat",
  "message_text": "Necesito enviar 8 kg de Ciudad de México a Monterrey por servicio exprés"
}
```

**Respuesta** — HTTP 200, 2699 ms

```json
{
  "status": "QUOTED",
  "quote": {
    "origin": "Ciudad de México",
    "destination": "Monterrey",
    "weight_kg": 8,
    "service_type": "express",
    "package_count": 1,
    "amount": 560,
    "currency": "MXN",
    "provider": "mock-carrier",
    "eta_days": 2,
    "quote_reference": "MC-000001"
  },
  "assumptions": [
    {
      "field": "package_count",
      "value": 1,
      "reason": "el mensaje no lo especifica; se aplica el valor por defecto declarado del contrato"
    }
  ],
  "meta": {
    "request_id": "43b6745c-0385-458e-99b2-6cf698e420b1",
    "llm_provider": "mock:reglas-deterministas",
    "provider_attempts": 1,
    "duration_ms": 2618
  }
}
```

## Informacion incompleta — clarificacion determinista

Falta la ciudad de destino. El flujo se DETIENE antes de llamar al proveedor: fijate en que `provider_attempts` es 0.

Configuracion del escenario: `CARRIER_FAILURE_RATE=0`

**Peticion**

```json
{
  "user_id": "candidate-001",
  "channel": "webchat",
  "message_text": "Necesito enviar 8 kg desde Ciudad de México por servicio exprés"
}
```

**Respuesta** — HTTP 200, 19 ms

```json
{
  "status": "NEEDS_INFO",
  "missing_fields": [
    "destination"
  ],
  "message": "Para continuar necesito la ciudad de destino.",
  "meta": {
    "request_id": "b909248d-d297-4a44-bc60-dbc4db6e956b",
    "llm_provider": "mock:reglas-deterministas",
    "provider_attempts": 0,
    "duration_ms": 3
  }
}
```

## Caida del proveedor externo — degradacion elegante

El carrier falla el 100% de las veces. Se agotan los 3 intentos con backoff y el usuario recibe un estado accionable, nunca un 500 crudo ni un stack.

Configuracion del escenario: `CARRIER_FAILURE_RATE=1 CARRIER_MIN_LATENCY_MS=50 CARRIER_MAX_LATENCY_MS=150 PROVIDER_TIMEOUT_MS=1000 PROVIDER_TOTAL_BUDGET_MS=8000`

**Peticion**

```json
{
  "user_id": "candidate-001",
  "channel": "webchat",
  "message_text": "Necesito enviar 8 kg de Ciudad de México a Monterrey por servicio exprés"
}
```

**Respuesta** — HTTP 503, 1552 ms

```json
{
  "status": "PROVIDER_UNAVAILABLE",
  "message": "No pudimos obtener la cotizacion en este momento. Intenta nuevamente en unos minutos.",
  "meta": {
    "request_id": "e840369f-3480-4e22-8ae0-c438133f4a2a",
    "llm_provider": "mock:reglas-deterministas",
    "provider_attempts": 3,
    "duration_ms": 1543
  }
}
```
