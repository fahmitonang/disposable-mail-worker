# disposable-mail-worker

A self-hosted, receive-only disposable email server built **100% on Cloudflare Workers** — no R2, no KV, and no external database required.

Powered by **Cloudflare Email Routing**, **SQLite-backed Durable Objects**, and **Workers Static Assets**, it runs completely on the **Cloudflare Workers Free Plan**.

## Features

- **100% Cloudflare Workers** — single Worker bundle with built-in SQLite Durable Objects and static web UI.
- **Per-Inbox Isolation & Auto-Expiration** — each email address gets its own Durable Object (`MailboxDO`) with a 5-hour auto-delete alarm. When an inbox becomes empty, `deleteAll()` reclaims storage back to 0 bytes.
- **Zero-Write Empty Inboxes** — checking an unused address allocates zero SQLite tables and zero storage.
- **Handles Up to 5 MB Emails** — stores full MIME messages, raw `.eml` source, and binary attachments inside Durable Object SQLite (8 MB row limit) without requiring R2.
- **Automatic OTP / Verification Code Detection** — detects verification codes (English & Indonesian) with one-click copy.
- **Security-First Email Reader** — server-side HTML sanitization combined with a strict `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` and CSP that blocks remote images/tracking pixels by default (with an explicit opt-in toggle).
- **Inline `cid:` Images & Safe Attachments** — raster `cid:` images render inline as data URIs; dangerous attachment types (HTML, SVG, XML, JS) are forced to `application/octet-stream` with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- **Reserved Username Protection** — protects critical addresses (`admin`, `postmaster`, `abuse`, etc.) from public inbox access and inbound catch-all ingestion.
- **Responsive Web UI** — random username generator, recent inbox history, deep-link URLs (`/username`), configurable auto-refresh (10s / 15s / 30s / 1m), browser notifications, live expiry countdown, and raw RFC 5322 `.eml` viewer/download.

## Architecture

```text
Incoming Email (*@example.com)
  └─► Cloudflare Email Routing (Catch-All Rule)
        └─► Worker email() handler
              ├─ Validates recipient, reserved usernames & 5 MB size cap
              ├─ Parses MIME via postal-mime, sanitizes HTML, extracts OTP
              └─► MailboxDO (SQLite Durable Object keyed by address)
                    ├─ Stores messages, raw_eml, and attachments
                    └─ Schedules 5h Alarm → purges expired mail & deleteAll()

Browser (https://mail.example.com)
  ├─► Workers Static Assets (SPA UI + /username deep links)
  └─► Worker fetch() handler (/api/*) ──► MailboxDO RPC
```

## Tech Stack

- **Runtime**: Cloudflare Workers + SQLite Durable Objects + Workers Static Assets
- **CLI & Build**: Cloudflare CLI (`cf`), Vite+, `@cloudflare/vite-plugin`
- **MIME Parsing**: `postal-mime`
- **Testing**: Vitest + `@cloudflare/vitest-plugin` (`workerd`)
- **Language**: TypeScript

## Prerequisites

- A Cloudflare account (Free Plan works out of the box)
- A domain managed by Cloudflare DNS with **Email Routing** enabled
- Node.js `>= 22.18` and `npm`

## Configuration

Edit `cloudflare.config.ts` to configure your Worker name, custom web domain, email domain, retention window, and reserved usernames:

```ts
domains: ["mail.example.com"],
env: {
	MAILBOX: bindings.durableObject({
		worker: mailboxWorker,
		exportName: "MailboxDO",
	}),
	EMAIL_DOMAIN: bindings.text("example.com"),
	EMAIL_DOMAINS: bindings.text("example.com"),
	APP_NAME: bindings.text("Temp Mail"),
	SITE_URL: bindings.text("https://mail.example.com"),
	DECLINE_URL: bindings.text("https://example.com/"),
	RETENTION_HOURS: bindings.text("5"),
	MAX_EMAIL_BYTES: bindings.text("5242880"),
	MAX_MESSAGES_PER_INBOX: bindings.text("50"),
	RESERVED_USERNAMES: bindings.text(
		"admin,administrator,postmaster,abuse,hostmaster,webmaster,root,security,mailer-daemon,noreply,no-reply",
	),
}
```

> **Tip:** Specific Email Routing rules (for example, forwarding `admin@example.com` to your personal mailbox) are evaluated before the catch-all rule and continue to work normally. Keeping those names in `RESERVED_USERNAMES` ensures they cannot be opened via the public UI.

## Local Development

```bash
# Install dependencies
npm install

# Start local development server (Cloudflare Workers runtime)
npm run dev

# Run unit and Workers runtime integration tests
npm test -- --run

# Format, lint, and typecheck
npm run check

# Build Worker bundle and static assets
npm run build
```

## Deployment

1. Authenticate with the Cloudflare CLI:

   ```bash
   npx cf auth login
   ```

2. Deploy the Worker (provisions the `MailboxDO` SQLite Durable Object, uploads static assets, and attaches your custom domain):

   ```bash
   npm run deploy
   ```

3. Enable the **Catch-All** Email Routing rule in the Cloudflare Dashboard:
   - Go to **Your Domain → Email → Email Routing → Routing rules**
   - Edit **Catch-all address** → set Action to **Send to a Worker** → select your deployed Worker → **Enable**

4. Open `https://mail.example.com` and send a test email to `hello@example.com`.

## HTTP API

| Method   | Endpoint                                               | Description                                                        |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `GET`    | `/api/config`                                          | Public app configuration (domains, retention, size limit)          |
| `GET`    | `/api/health`                                          | Health check                                                       |
| `GET`    | `/api/inbox/:username/messages`                        | List active messages in an inbox (`?domain=example.com` optional)  |
| `DELETE` | `/api/inbox/:username/messages`                        | Clear all messages in an inbox                                     |
| `GET`    | `/api/inbox/:username/messages/:id`                    | Get sanitized message detail, OTP code, and attachment metadata    |
| `DELETE` | `/api/inbox/:username/messages/:id`                    | Delete a single message immediately                                |
| `GET`    | `/api/inbox/:username/messages/:id/raw`                | View raw RFC 5322 source (append `?download=1` to download `.eml`) |
| `GET`    | `/api/inbox/:username/messages/:id/attachments/:attId` | Download an attachment                                             |

## Project Structure

```text
├── cloudflare.config.ts   # Worker, Durable Object, domain, assets & observability config
├── index.html             # Web UI entry point
├── client/                # Frontend SPA (TypeScript + CSS)
├── public/                # Static icons, pre-paint consent script & security _headers
├── src/
│   ├── index.ts           # Worker fetch() API router & email() inbound handler
│   ├── mailbox-do.ts      # SQLite Durable Object with lazy schema & expiry alarms
│   └── lib/               # Config, validation, MIME parsing, HTML sanitizer, OTP extractor
└── test/                  # Unit tests and workerd integration tests
```

## Security Notice

- **Inboxes are public**: anyone who knows or guesses a username can read emails sent to that address. Do not use disposable inboxes for sensitive personal, banking, or recovery accounts.
- **Receive-only**: outbound email sending is intentionally not enabled.

## License

[MIT](LICENSE)
