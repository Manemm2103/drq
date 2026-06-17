# DRQ Modern

Container-ready package for Git and Portainer deployment, including an optional built-in `coturn` service for WebRTC calls.

## What is persisted

The application stores runtime data in `/app/data`:

- `chat.db`
- uploaded files
- background uploads
- `call-debug.log`

On first start, the app automatically migrates legacy local data from:

- `./chat.db`
- `./public/uploads`
- `./public/backgrounds`

## Required environment variables

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `TURN_PUBLIC_HOST`
- `TURN_REALM`
- `TURN_EXTERNAL_IP`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

## Optional ioBroker integration variables

- `IOBROKER_API_KEY`
- `IOBROKER_SENDER_USERNAME` default: `ioBroker`

## Optional maintenance mail variables

- `SMTP_HOST`
- `SMTP_PORT` default: `587`
- `SMTP_SECURE` set to `true` for SMTPS, otherwise `false`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM` sender address, for example `DRQ <noreply@example.com>`
- `SMTP_REQUIRE_TLS` optional hard TLS requirement
- `SMTP_TLS_REJECT_UNAUTHORIZED` default: `true`
- `MAINTENANCE_PUBLIC_URL` public base URL used in mail links, for example `https://drq.example.com/maintenance.html`
- `MAINTENANCE_MAIL_ENABLED` set to `true` to activate scheduled maintenance mails
- `MAINTENANCE_MAIL_SCHEDULE` default: `nightly`, alternative: `interval`
- `MAINTENANCE_MAIL_HOUR` default: `2`
- `MAINTENANCE_MAIL_MINUTE` default: `0`
- `MAINTENANCE_MAIL_INTERVAL_MINUTES` default: `30`

If `IOBROKER_API_KEY` is set, DRQ enables a protected endpoint for adapter-based message delivery from ioBroker.

If you do not want to use environment variables, you can still provide a local `vapidKeys.json`, but that file should not be committed to a public Git repository.

## Local Docker run

```bash
docker compose up -d --build
```

The web app listens on port `3000` inside the container.

## Portainer stack

Use `portainer-stack.yml` when deploying from Git in Portainer.

### Recommended Portainer settings

- Repository URL: your Git URL
- Reference: `refs/heads/main`
- Compose path: `portainer-stack.yml`

### Environment variables

```text
APP_PORT=3000
VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
TURN_PUBLIC_HOST=yourdomain.de
TURN_REALM=yourdomain.de
TURN_EXTERNAL_IP=yourIP
TURN_USERNAME=your_turn_username
TURN_CREDENTIAL=your_turn_password
IOBROKER_API_KEY=your_shared_secret
IOBROKER_SENDER_USERNAME=ioBroker
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=mailer@example.com
SMTP_PASS=secret
SMTP_FROM=DRQ <mailer@example.com>
SMTP_REQUIRE_TLS=true
SMTP_TLS_REJECT_UNAUTHORIZED=true
MAINTENANCE_PUBLIC_URL=https://drq.example.com/maintenance.html
MAINTENANCE_MAIL_ENABLED=true
MAINTENANCE_MAIL_SCHEDULE=nightly
MAINTENANCE_MAIL_HOUR=2
MAINTENANCE_MAIL_MINUTE=0
MAINTENANCE_MAIL_INTERVAL_MINUTES=30
```

### Reverse proxy

If you publish the web app behind Nginx Proxy Manager or another reverse proxy, point the proxy host to:

- target host: the Docker host running this stack
- target port: the value of `APP_PORT`

That proxy only covers the website and API. TURN still needs its own public ports on the Docker host.

### TURN ports

For iPhone/mobile WebRTC reliability, these ports must be reachable from outside:

- `3478/tcp`
- `3478/udp`
- `49160-49200/udp`

If you run a host firewall or upstream NAT, open or forward the same ports there as well.

### Updating in Portainer

1. Push changes to GitHub.
2. Open the stack in Portainer.
3. Redeploy the stack from repository.

## Notes

- The SQLite database is persisted via the named volume `icq_data`.
- Uploaded files and background assets are persisted in the same volume.
- The app now loads TURN/STUN runtime configuration from the server environment.
- The included `coturn` service is meant for direct host port publishing, not normal HTTP reverse proxying.

## ioBroker API

If `IOBROKER_API_KEY` is configured, DRQ accepts status messages on:

- `POST /api/integrations/iobroker/messages`

If maintenance mail is enabled, users with a stored e-mail address and maintenance-board access also receive due-maintenance notifications with a direct link into the matching plan inside the board.

Headers:

- `x-api-key: <IOBROKER_API_KEY>`

Example payload:

```json
{
  "message": "Waschmaschine fertig",
  "recipients": ["4711", "8159"],
  "title": "Haus",
  "severity": "info",
  "source": "ioBroker"
}
```
