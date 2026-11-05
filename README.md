# Handshake

Pagos por hitos para trabajo freelance: el cliente deja el dinero retenido en PayPal y un agente de IA revisa la entrega antes de liberarlo.

Proyecto para el PayPal AI Hackathon (noviembre 2026). En desarrollo.

<!-- Captura de la app: agregar aquí cuando exista la interfaz -->

## Cómo funciona

1. Cliente y freelancer acuerdan un hito con criterios de aceptación.
2. El cliente paga con PayPal en modo `AUTHORIZE`: el dinero queda retenido, no cobrado.
3. El freelancer entrega una URL.
4. Un agente de IA abre la URL con Playwright, prueba cada criterio y genera un reporte con evidencia.
5. Si todo pasa, se captura el pago y el freelancer cobra. Si no, ve qué falta y puede volver a entregar. El cliente puede anular la retención.

## Estado

- [x] Paso 1: prueba en sandbox de PayPal (crear orden → aprobar → autorizar → capturar / anular)
- [ ] Paso 2: aplicación completa

## Tecnologías

Node.js 24, PayPal Orders API v2 y Payments API v2 (sandbox).

## Ejecutar la prueba de PayPal

Necesitas una app REST de sandbox en [developer.paypal.com](https://developer.paypal.com) y una cuenta sandbox personal (comprador).

```bash
cp .env.example .env      # completa PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET
npm run spike
```

El script imprime dos enlaces. Ábrelos e inicia sesión con la cuenta sandbox personal. Al final debe mostrar `CAPTURE: COMPLETED` y `VOID: VOIDED`.

## Licencia

MIT
