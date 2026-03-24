# tix
Trouble ticket system built with Claude Code
See .env.example for configuration options.

Email transports supported:
- mailgun
- smtp (direct)
- Google mail API

Incoming message transports:
- mailgun API endpoint
- direct SMTP (listener)

To set up auto-versioning:
One-time setup note: The git config command is already done, but if you clone the repo fresh on another machine, run: git config core.hooksPath .githooks && chmod +x .githooks/pre-commit

Git commit steps:
git add .
git commit -m "comment"
git push origin main

---

## Deployment (Digital Ocean / Docker)

### Prerequisites

- A domain with MX record pointing to your droplet (for inbound email)
- Port 25 open in your DO cloud firewall (Networking → Firewalls)
- Port 3000 open, or a reverse proxy (nginx/caddy) on port 443

### 1. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Clone the repo

```bash
git clone https://github.com/youruser/yourrepo.git /opt/tix
cd /opt/tix
```

### 3. Configure

```bash
cp .env.example .env
nano .env
```

Required values to set:

| Variable | Description |
|----------|-------------|
| `APP_URL` | Public URL, e.g. `https://tickets.yourcompany.com` |
| `JWT_SECRET` | Long random string — generate with `openssl rand -hex 32` |
| `TICKET_EMAIL` | Inbound address, e.g. `tickets@yourcompany.com` |
| `ADMIN_EMAIL` | First user with this email gets admin role |
| `MAIL_TRANSPORT` | `smtp`, `mailgun`, or `gmail` |
| `SMTP_PORT` | Set to `2525` (mapped from port 25 via iptables) |

Set mail transport credentials (`SMTP_RELAY_*`, `MAILGUN_*`, or `GMAIL_*`) as needed.

### 4. Start the container

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Data (database, uploads, logs) persists in `./data/` on the host.

### 5. SMTP port redirect

The container listens on port 2525. Redirect inbound port 25 to it:

```bash
sudo iptables -t nat -A PREROUTING -p tcp --dport 25 -j REDIRECT --to-port 2525
sudo apt install iptables-persistent -y
sudo netfilter-persistent save
```

Verify with:

```bash
sudo iptables -t nat -L PREROUTING -n -v
```

---

## Updating

```bash
cd /opt/tix
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The `--build` flag rebuilds the image with the latest code. Downtime is a few seconds during container restart.

---

## Local development

```bash
npm install
npm run dev        # auto-restarts on changes; app on http://localhost:3000
```