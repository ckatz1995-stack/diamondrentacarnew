# HTML Bridge Contract (v2026-04-06.1)

This document defines the common cross-frame message contract used by page controllers and embedded HTML components.

## Protocol
- **Version field:** `protocolVersion`
- **Current value:** `2026-04-06.1`
- **Shared constants/source:** `src/public/bridgeUtils.js`

## Core message types

### Inbound to page
- `wix-booking-nav`
  - Payload: `{ type, path }`
  - Action: navigate page via `wixLocation.to(path)`.

- `request-booking-context`
  - Payload: `{ type }`
  - Action: return context message (`booking-context`).

- `request-pricing-catalog-data`
  - Payload: `{ type }`
  - Action: return pricing catalog payload (`pricing-catalog-data`).

### Outbound from page
- `booking-context`
  - Payload:
    - `type: "booking-context"`
    - `protocolVersion: "2026-04-06.1"`
    - `query: object`
    - `url: string`
    - `path: string[]`

- `pricing-catalog-data`
  - Payload: `{ type, catalog }`

## Compatibility rules
1. New fields should be additive (non-breaking).
2. Consumers must ignore unknown fields.
3. Producers should keep existing keys stable.
4. On contract changes, bump `BRIDGE_PROTOCOL_VERSION` and update this file.

## Security notes
- Global `window.message` handlers should validate `event.origin` before processing payloads.
- Never include secrets (e.g. plaintext passwords) in bridge payloads.

## Telemetry hooks
- Runtime bridge telemetry lives in `src/public/bridgeUtils.js`.
- Available counters:
  - `parseFailures`
  - `postFallbacks`
  - `postFailures`
  - `untrustedOriginDrops`
- Access helpers:
  - `getBridgeTelemetrySnapshot()`
  - `resetBridgeTelemetry()`
