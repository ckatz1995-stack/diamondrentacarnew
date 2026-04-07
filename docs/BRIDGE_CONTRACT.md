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
- Available aggregate counters:
  - `parseAttempts`
  - `parseSuccesses`
  - `parseFailures`
  - `postAttempts`
  - `postSuccesses`
  - `postFallbacks`
  - `postFailures`
  - `originChecks`
  - `trustedOriginPasses`
  - `untrustedOriginDrops`
- Access helpers:
  - `getBridgeTelemetrySnapshot()`
  - `resetBridgeTelemetry()`

### Snapshot shape (example)
```json
{
  "parseAttempts": 42,
  "parseSuccesses": 39,
  "parseFailures": 3,
  "postAttempts": 120,
  "postSuccesses": 119,
  "postFallbacks": 5,
  "postFailures": 1,
  "originChecks": 84,
  "trustedOriginPasses": 80,
  "untrustedOriginDrops": 4,
  "perMinute": {
    "parseAttempts": 8,
    "parseSuccesses": 8,
    "parseFailures": 0,
    "postAttempts": 16,
    "postSuccesses": 16,
    "postFallbacks": 1,
    "postFailures": 0,
    "originChecks": 14,
    "trustedOriginPasses": 13,
    "untrustedOriginDrops": 1
  },
  "rates": {
    "parseFailurePct": 7.14,
    "postFailurePct": 0.83,
    "untrustedOriginPct": 4.76
  },
  "windowRates": {
    "parseFailurePct": 0,
    "postFailurePct": 0,
    "untrustedOriginPct": 7.14
  },
  "historyWindowMs": 60000,
  "historySize": 235,
  "lastEventAt": 1775512800000,
  "lastEventType": "postSuccesses"
}
```
