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

**Respuesta** — HTTP 200, 2689 ms

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
    "request_id": "9165d19c-7629-40a8-9a8e-7374e167b9e7",
    "llm_provider": "mock:reglas-deterministas",
    "provider_attempts": 1,
    "duration_ms": 2624
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

**Respuesta** — HTTP 200, 18 ms

```json
{
  "status": "NEEDS_INFO",
  "missing_fields": [
    "destination"
  ],
  "message": "Para continuar necesito la ciudad de destino.",
  "meta": {
    "request_id": "9df0ab90-b5f4-4b5f-ac2d-8b925b237fd9",
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

**Respuesta** — HTTP 503, 1544 ms

```json
{
  "status": "PROVIDER_UNAVAILABLE",
  "message": "No pudimos obtener la cotizacion en este momento. Intenta nuevamente en unos minutos.",
  "meta": {
    "request_id": "1042eb64-7b12-493f-8425-7e3c51bc4efc",
    "llm_provider": "mock:reglas-deterministas",
    "provider_attempts": 3,
    "duration_ms": 1533
  }
}
```
