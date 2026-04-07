# Bridge Regression Checklist

Use this checklist before merging bridge-related page changes or protocol updates.

## 1) Automated checks
- Run `npm run check:smoke` and confirm success.
- Confirm no unresolved TODO/FIXME markers are introduced.

## 2) Security checks
- Verify every `onMessage` handler validates origin (prefer `isTrustedBridgeOrigin`).
- Verify inbound payloads are normalized/validated before branching on `type`.
- Confirm no secrets/passwords/tokens are posted back to HTML components.

## 3) Contract compatibility
- If payload shape changed, ensure changes are additive.
- Ensure consumers tolerate unknown keys.
- If contract behavior changed, bump `BRIDGE_PROTOCOL_VERSION` and update `docs/BRIDGE_CONTRACT.md`.

## 4) Page flow sanity checks
- Home Login: login/recovery/resize paths still work.
- Myroom Home: auth-state refresh and menu navigation still work.
- Daily View / Fleet Chart / Booking Board: load/reload actions and navigation hand-offs work.
- Account Settings admin bridge: telemetry snapshot/reset actions still work.

## 5) Telemetry sanity checks
- Trigger at least one trusted and one untrusted origin event in a safe test environment.
- Verify `getBridgeTelemetrySnapshot()` returns:
  - aggregate counters,
  - per-minute counters,
  - `rates` and `windowRates`,
  - `lastEventAt` / `lastEventType`.

## 6) Rollout notes
- Include impacted pages in PR description.
- Include smoke command output in PR validation section.
- If a fallback path changed (`postMessageSafe`/parsing/origin checks), mention expected operational impact.
