# Production provider adapters

The owner chose configurable integrations until production. SMS, WhatsApp, weather, and accounting have no vendor selected and are disabled by default. The API and worker use the same configuration; the release Compose file forwards it to both. Configuration is server-side only.

For each `SMS`, `WHATSAPP`, `WEATHER`, or `ACCOUNTING` service, set `PROVIDER_<SERVICE>_ENABLED=true`, an HTTPS `PROVIDER_<SERVICE>_URL`, and `PROVIDER_<SERVICE>_TOKEN`. The URL identifies your vendor adapter. The adapter translates the contract below into the production vendor's API. Never put these tokens in a web or mobile public environment variable. Redirects are refused, requests time out after 10 seconds, and responses are bounded to 1 MiB. `/api/v1/integrations` exposes connection status without credentials; it does not claim the remote service is healthy.

## Gateway protocol

Requests use `POST`, JSON, `Authorization: Bearer <token>`, and a stable `Idempotency-Key`. The body is `{ "schema_version": 1, "provider": "sms|whatsapp|weather|accounting", "payload": {...} }`.

| Service | Payload |
| --- | --- |
| SMS / WhatsApp | `operation: "send"`, `recipient`, `template: "silverline_update"`, and generic `parameters.message`. Map the template to the vendor's approved template and normalize the telephone number according to your production dialing policy. |
| Accounting | `operation: "send"`, `invoices`: approved operational invoice fields, including decimal amounts represented as strings. Your adapter owns the target chart-of-accounts and tax mappings. |
| Delivery receipt | `operation: "receipt"`, `id`: the provider ID returned by the send request. |
| Weather | `latitude`, `longitude`. Coordinates come from an authorized project query. |

Send responses must contain `{ "accepted": true, "id": "provider-reference", "delivered": false }`. Return `delivered: true` only when the operation has completed, including on subsequent receipt requests. `accepted: false` is a permanent rejection. The adapter must retain idempotency receipts: a lost HTTP response must not cause another message or accounting posting on retry.

Weather returns `observed_at` (ISO timestamp), `summary`, `temperature_c`, `precipitation_probability` (0–1), and `alerts` containing `severity` (`INFO`, `WATCH`, `WARNING`) and `message`. Unconfigured or unavailable weather is explicitly reported; no forecast is invented.

## Delivery and permissions

SMS and WhatsApp require the employee's explicit channel opt-in in notification preferences. Only active employees with active accounts qualify. Only generic update text is transmitted; attendance, salary, evidence, and comment contents are excluded. Queued payloads are encrypted. The worker rechecks account status and opt-in before each attempt. Enable the service only after consent and template configuration are complete.

Accounting export is an explicit action in Inventory → Invoices. It requires organization-wide inventory management permission, and the worker rechecks that authority before posting. A batch contains at most 100 invoice IDs. Neither provider enablement nor running the worker automatically exports historical invoices.

Transient transport failures, HTTP 408/429, and server errors retry with bounded backoff. Permanent rejection or eight unsuccessful attempts end in `FAILED`; revoked authority ends in `CANCELLED`. Receipt polling does not resend an accepted operation. Automation → Provider delivery history exposes status, attempts, and a sanitized failure code.

Expo push remains separately configurable through `PUSH_ENABLED` and `EXPO_ACCESS_TOKEN`. It uses device registrations, ticket and receipt tracking, and removes invalid tokens. ClamAV is separately required for production file uploads. The integration tests use mock gateways and a local test scanner; they do not validate production vendor contracts or send real messages.
