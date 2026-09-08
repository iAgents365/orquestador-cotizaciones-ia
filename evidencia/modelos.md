# Eleccion de modelo local — medicion, no opinion

Generado por `npx tsx scripts/comparar-modelos.ts`. Cuatro mensajes, campo a campo.
**Omitir un campo ausente cuenta como acierto**: rellenar de mas es el fallo que este
sistema existe para impedir.

| modelo | aciertos | % | tiempo |
|---|---|---|---|
| `llama3.2:3b` | 19/20 | 95% | 34.6s |
| `qwen2.5:3b` | 19/20 | 95% | 34.8s |

## Detalle

### `llama3.2:3b`

```
  canonico del enunciado
    todo correcto
  sin destino (debe quedar incompleto)
    todo correcto
  con bultos explicitos
    x package_count: esperaba 3, dio undefined
  trampa: peso que parece cantidad
    todo correcto
```

### `qwen2.5:3b`

```
  canonico del enunciado
    todo correcto
  sin destino (debe quedar incompleto)
    todo correcto
  con bultos explicitos
    x package_count: esperaba 3, dio undefined
  trampa: peso que parece cantidad
    todo correcto
```
