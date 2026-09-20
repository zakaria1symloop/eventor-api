# Deploying the Eventor API on a Hostinger VPS

Target: a Hostinger KVM VPS running **Ubuntu 22.04 or 24.04**, hosting

- the **Eventor API** (this repo — NestJS 12, Node >= 22.12, pnpm 12.4.1, ESM), and
- the **Next.js admin dashboard** (separate repo, port 3001),

behind nginx with Let's Encrypt TLS.

Two installation paths are described. **Pick one.**

| | Path A — Docker Compose | Path B — Node + PM2 + system MySQL |
|---|---|---|
| MySQL | container (`mysql:8`) | system package |
| Redis | container (`redis:7-alpine`) | system package (optional) |
| Node | inside the image | nvm / NodeSource on the host |
| Rollback | re-tag a previous image | `git checkout` + rebuild |
| Best for | clean, reproducible, easy rollback | 1 GB RAM boxes, simpler debugging |

Files in this directory:

| File | Purpose |
|---|---|
| `Dockerfile` | multi-stage production image (build context = repo root) |
| `.dockerignore` | copy to the repo root before building |
| `docker-compose.yml` | api + mysql + redis stack (path A) |
| `ecosystem.config.cjs` | PM2 process config (path B) |
| `nginx/eventor.conf` | nginx vhosts for `api.` and `admin.` |
| `.env.production.example` | every variable `src/config/env.ts` reads |
| `backup.sh` / `restore.sh` | nightly backup and restore |

Throughout, replace `example.com` with the real domain and `deploy` with the
real deploy username.

---

## 1. Server preparation

SSH in as `root` with the key you gave Hostinger at provisioning.

```bash
# 1.1 Patch everything
apt update && apt -y full-upgrade
apt -y install ca-certificates curl git ufw fail2ban unattended-upgrades

# 1.2 Automatic security updates
dpkg-reconfigure --priority=low unattended-upgrades   # answer "Yes"
systemctl enable --now unattended-upgrades

# 1.3 Timezone: keep the box on UTC. The API stores and compares UTC
#     timestamps and the MySQL server is configured with --default-time-zone=+00:00.
timedatectl set-timezone UTC

# 1.4 Swap (Hostinger's smaller plans have none; `pnpm build` and sharp want it)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 1.5 A non-root deploy user
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# 1.6 Application directories
install -d -o deploy -g deploy /srv/eventor
install -d -o deploy -g deploy /srv/eventor/storage     # STORAGE_ROOT (path B)
install -d -o deploy -g deploy /var/log/eventor
install -d -o deploy -g deploy /var/backups/eventor
```

Then harden SSH (`/etc/ssh/sshd_config`):

```
PermitRootLogin no
PasswordAuthentication no
```

```bash
systemctl restart ssh
```

**Open a second SSH session as `deploy` and confirm it works before closing the
root one.**

---

## 2. Firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
# Explicitly refuse the application and database ports from outside.
ufw deny 3000/tcp
ufw deny 3001/tcp
ufw deny 3306/tcp
ufw deny 6379/tcp
ufw enable
ufw status verbose
```

Notes:

- The API binds `0.0.0.0:3000` (`src/main.ts`), so the firewall is what keeps it
  private. Compose publishes it as `127.0.0.1:3000:3000` for the same reason.
- **Docker bypasses ufw** by writing its own iptables rules. Because
  `docker-compose.yml` binds to `127.0.0.1` only, nothing is exposed — never
  change those port mappings to a bare `3000:3000`.
- The `mysql` service in the compose file publishes **no** host port at all.

---

## 3. Path A — Docker Compose

### 3.1 Install Docker

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy    # log out and back in for it to take effect
```

### 3.2 Get the code and configure

```bash
su - deploy
git clone <repo-url> /srv/eventor/backend
cd /srv/eventor/backend

cp deploy/.env.production.example .env.production
cp deploy/.dockerignore .dockerignore      # Docker reads it from the context root
chmod 600 .env.production
nano .env.production                       # see section 6
```

### 3.3 Build and start

```bash
docker compose -f deploy/docker-compose.yml --env-file .env.production up -d --build
docker compose -f deploy/docker-compose.yml ps
```

Compose overrides `DB_HOST=mysql` and `STORAGE_ROOT=/data/storage` for the
container, so the same `.env.production` works for both paths.

Uploads live in the named volume `storage-data`; the database in `mysql-data`.
Neither is deleted by `docker compose down` — only by `down -v`. **Never run
`down -v` on this server.**

---

## 4. Path B — Node + PM2 + system MySQL

### 4.1 Node 22 and pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs build-essential python3
node -v                               # must be >= 22.12
sudo corepack enable
corepack prepare pnpm@12.4.1 --activate
sudo npm i -g pm2
```

> `pnpm` is the only supported package manager here (`packageManager` is pinned
> to `pnpm@12.4.1` and the repo ships `pnpm-lock.yaml`). Do not use npm.
> `sharp` and `argon2` are native modules; on Ubuntu they install from prebuilt
> glibc binaries, which is why `build-essential` is only a fallback.

### 4.2 MySQL 8

```bash
sudo apt -y install mysql-server
sudo mysql_secure_installation
```

Add to `/etc/mysql/mysql.conf.d/mysqld.cnf` under `[mysqld]`:

```ini
default-time-zone           = '+00:00'
character-set-server        = utf8mb4
collation-server            = utf8mb4_unicode_ci
bind-address                = 127.0.0.1
```

```bash
sudo systemctl restart mysql
sudo mysql <<'SQL'
CREATE DATABASE eventor_admin CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'eventor'@'127.0.0.1' IDENTIFIED BY 'PUT-THE-DB_PASSWORD-HERE';
GRANT ALL PRIVILEGES ON eventor_admin.* TO 'eventor'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
```

> The user needs DDL rights, not just DML: TypeORM migrations create and alter
> tables.

### 4.3 Redis (optional — only if you want BullMQ; see section 12)

```bash
sudo apt -y install redis-server
sudo systemctl enable --now redis-server
```

### 4.4 Code, build, PM2

```bash
git clone <repo-url> /srv/eventor/backend
cd /srv/eventor/backend
cp deploy/.env.production.example .env.production && chmod 600 .env.production
nano .env.production                  # STORAGE_ROOT=/srv/eventor/storage

pnpm install --frozen-lockfile
pnpm build                            # -> dist/

# The migration CLI reads process.env, so export the file for this shell.
# (The API itself does not need this: ecosystem.config.cjs starts node with
#  --env-file=.env.production, so PM2 never has to hold the secrets.)
set -a; . ./.env.production; set +a
pnpm migration:run:prod

pm2 start deploy/ecosystem.config.cjs --env production
pm2 save
pm2 startup systemd -u deploy --hp /home/deploy   # run the printed command with sudo
```

`ecosystem.config.cjs` runs **one** process in fork mode on purpose — see
section 11 (Socket.IO) for why, and what it would take to cluster.

---

## 5. nginx and TLS

### 5.1 DNS

Point both records at the VPS IPv4 (and AAAA if you have IPv6):

```
api.example.com    A   <vps-ip>
admin.example.com  A   <vps-ip>
```

Wait for propagation (`dig +short api.example.com`) before running certbot.

### 5.2 nginx

```bash
sudo apt -y install nginx
sudo mkdir -p /var/www/certbot
sudo cp deploy/nginx/eventor.conf /etc/nginx/sites-available/eventor.conf
sudo sed -i 's/example\.com/YOURDOMAIN.tld/g' /etc/nginx/sites-available/eventor.conf
sudo ln -s /etc/nginx/sites-available/eventor.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

The `:443` blocks reference certificates that do not exist yet, so nginx will
fail `-t` until certbot has run. Either comment the two `:443` server blocks out
for the first `nginx -t`, or use `certbot certonly --webroot` first:

```bash
sudo apt -y install certbot python3-certbot-nginx
sudo certbot certonly --webroot -w /var/www/certbot \
  -d api.example.com -d admin.example.com --agree-tos -m ops@example.com
sudo nginx -t && sudo systemctl reload nginx
```

Or, with the plain `:80` blocks live and the `:443` blocks removed, let certbot
write them:

```bash
sudo certbot --nginx -d api.example.com -d admin.example.com
```

### 5.3 Renewal

certbot installs a systemd timer; verify it:

```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

Add a reload hook so nginx picks up new certificates:

```bash
echo -e '#!/bin/sh\nsystemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

### 5.4 Body size

`client_max_body_size` is **26m**. That comes from the code: the largest
per-route multipart cap is `uploadLimits(25)` — 25 MB — in
`src/common/http/upload-limits.ts`, used by photo/document upload routes. The
app then applies a smaller, admin-editable cap from the `settings` table
(`max_photo_upload_mb`, default 10; `max_document_upload_mb`, default 5), so
nginx only has to stay above the hard ceiling. If you raise the `uploadLimits()`
argument in code, raise nginx to match.

`BODY_LIMIT=1mb` in `.env.production` is a separate thing — it caps JSON and
urlencoded bodies only, not multipart uploads.

---

## 6. First deploy: `.env.production`

Copy `deploy/.env.production.example` and fill it in. It lists **every**
variable `src/config/env.ts` reads; nothing else is consulted.

Generate the two signing secrets on the server:

```bash
openssl rand -hex 32   # -> JWT_ACCESS_SECRET
openssl rand -hex 32   # -> FILES_SIGNING_SECRET
```

`validateEnv()` refuses to boot in production if:

- either secret is shorter than 32 characters or is still a dev default;
- `JWT_ACCESS_SECRET` equals `FILES_SIGNING_SECRET`;
- `CORS_ORIGINS` is `*` or empty — list `https://admin.example.com`.

Other must-sets: `NODE_ENV=production`, `SWAGGER_ENABLED=false`,
`LOG_REQUESTS=false`, `API_URL` / `ADMIN_URL` / `APP_PUBLIC_URL` as the real
https URLs, `STORAGE_ROOT` as an absolute path outside any web root, and the
`DB_*` credentials.

Then run the migrations:

```bash
# Path A
docker compose -f deploy/docker-compose.yml exec api pnpm migration:run:prod
# Path B
cd /srv/eventor/backend && set -a; . ./.env.production; set +a && pnpm migration:run:prod
```

`migration:run:prod` runs the compiled TypeORM CLI against
`dist/database/data-source.js`, so **`pnpm build` must have run first**.
(`migration:run` — without `:prod` — uses `tsx` and dev sources; do not use it on
the server.)

Smoke test:

```bash
curl -fsS https://api.example.com/api/v1/health/live      # {"status":"ok"}
curl -fsS https://api.example.com/api/v1/health/ready     # {"status":"ok","database":"up","queue":"inline"}
```

`queue` reports `inline` or `bullmq` — a quick way to confirm whether Redis is
actually in use.

---

## 7. Seeding the first admin

The first admin is created by the **`SeedV1` migration**
(`src/database/migrations/1789552455600-SeedV1.ts`), not by a separate script.
The same migration also inserts the wilayas, the default `settings` rows and the
number sequences.

It reads three environment variables **at migration time**:

| Variable | Notes |
|---|---|
| `SEED_ADMIN_EMAIL` | trimmed and lower-cased |
| `SEED_ADMIN_PASSWORD` | hashed with argon2id |
| `SEED_ADMIN_NAME` | trimmed; used as `full_name` |

Behaviour, exactly as implemented:

- If **any** of the three is empty or missing, the admin insert is silently
  skipped — the rest of the seed still runs.
- If a user with that email already exists, nothing is inserted.
- The user is created with `role='admin'`, `status='active'`,
  `verification_status='not_required'`, `email_verified_at` = now, `language='en'`.
- **There is no "must change password at first login" flag.** The code stores the
  argon2id hash and nothing else. Treat `SEED_ADMIN_PASSWORD` as a real
  password: give it a strong value, and change it from the dashboard right after
  the first sign-in.

Because migrations only run once, **set these three variables before the first
`pnpm migration:run:prod`.** If you forgot, the cleanest recovery on a fresh
install is to drop the schema and re-run; on a live database, create the admin
with a small one-off SQL insert using an argon2id hash you generate yourself.

After the first login you can clear `SEED_ADMIN_PASSWORD` from
`.env.production` — it is not read at runtime.

`seed:demo` (`pnpm seed:demo`) exists too, but it is a **development fixture
loader**. Do not run it in production.

---

## 8. Updating

```bash
cd /srv/eventor/backend
./deploy/backup.sh                    # ALWAYS back up before migrating
git pull --ff-only
```

**Path A**

```bash
docker compose -f deploy/docker-compose.yml --env-file .env.production build api
docker compose -f deploy/docker-compose.yml --env-file .env.production up -d
docker compose -f deploy/docker-compose.yml exec api pnpm migration:run:prod
```

**Path B**

```bash
pnpm install --frozen-lockfile
pnpm build
set -a; . ./.env.production; set +a
pnpm migration:run:prod
pm2 reload eventor-api
```

Zero downtime, honestly: **you do not have it today.**

- `pm2 reload` is only graceful in cluster mode; with `instances: 1` in fork
  mode it is a stop/start, so expect a few seconds of 502s.
- Compose `up -d` recreates the container — same story.
- Even with clustering, Socket.IO clients would be disconnected on restart (they
  reconnect automatically, but the gap is real).

Mitigations that need no code change: run the update in a low-traffic window,
and keep migrations **backward compatible** (add columns before the code needs
them; drop columns one release *after* the code stopped using them) so the old
process can survive briefly against the new schema.

---

## 9. Rollback

Roll back the code first, the database only if you must.

**Path A** — tag images before every deploy, so you have something to go back to:

```bash
docker tag eventor-api:latest eventor-api:$(date -u +%Y%m%d-%H%M)
# ...deploy...
# to roll back:
docker tag eventor-api:20260101-1200 eventor-api:latest
docker compose -f deploy/docker-compose.yml up -d --no-build api
```

**Path B**

```bash
git log --oneline -n 10
git checkout <previous-commit>
pnpm install --frozen-lockfile && pnpm build && pm2 reload eventor-api
```

**Database**: if the failed release added a migration, revert exactly one step:

```bash
set -a; . ./.env.production; set +a
pnpm migration:revert          # one migration per invocation; run it again for the next
```

`migration:revert` uses `tsx` against `src/database/data-source.ts`, so it needs
the dev dependencies present (path B, or `docker compose run` in a build-stage
container). Check `pnpm migration:show` first to see where you are.

If a `down()` is destructive or missing, **restore from the pre-deploy backup
instead** (section 10). That is why section 8 starts with `backup.sh`.

---

## 10. Backups

```bash
sudo install -m 750 -o deploy -g deploy deploy/backup.sh  /usr/local/bin/eventor-backup
sudo install -m 750 -o deploy -g deploy deploy/restore.sh /usr/local/bin/eventor-restore
```

`backup.sh` writes two timestamped files into `/var/backups/eventor`:

- `eventor-db-YYYYmmdd-HHMMSS.sql.gz` — `mysqldump --single-transaction
  --routines --triggers`, gzipped;
- `eventor-storage-YYYYmmdd-HHMMSS.tar.gz` — a tar of `STORAGE_ROOT`.

Anything older than 14 days is deleted. **Both halves matter**: the database
holds file metadata, `STORAGE_ROOT` holds the bytes; restoring one without the
other leaves broken images and documents.

Cron (as `deploy`, `crontab -e`):

```
15 3 * * * /usr/local/bin/eventor-backup >> /var/log/eventor/backup.log 2>&1
```

For path A, point the script at the container:

```
15 3 * * * DOCKER_MYSQL=mysql /usr/local/bin/eventor-backup >> /var/log/eventor/backup.log 2>&1
```

**Copy the backups off the VPS.** A snapshot on the same disk is not a backup —
use `rclone`/`rsync` to object storage or another host, and Hostinger's own VPS
snapshots as a second layer.

### Restore drill

Do this once before go-live and once a quarter, ideally on a scratch VPS:

```bash
pm2 stop eventor-api        # or: docker compose -f deploy/docker-compose.yml stop api
eventor-restore /var/backups/eventor/eventor-db-<stamp>.sql.gz \
                /var/backups/eventor/eventor-storage-<stamp>.tar.gz
# it asks you to type the database name; --yes skips that
pnpm migration:run:prod     # apply anything newer than the dump
pm2 start eventor-api
curl -fsS https://api.example.com/api/v1/health/ready
```

`restore.sh` drops and recreates the schema and moves the existing
`STORAGE_ROOT` aside as `storage.replaced-<stamp>` rather than deleting it.

---

## 11. Logs and monitoring

| What | Where |
|---|---|
| API (path B) | `pm2 logs eventor-api`, `/var/log/eventor/api.out.log`, `api.err.log` |
| API (path A) | `docker compose -f deploy/docker-compose.yml logs -f api` |
| MySQL (path A) | `docker compose -f deploy/docker-compose.yml logs mysql` |
| MySQL (path B) | `/var/log/mysql/error.log`, `journalctl -u mysql` |
| nginx | `/var/log/nginx/eventor-api.{access,error}.log`, `eventor-admin.*` |
| certbot | `/var/log/letsencrypt/letsencrypt.log` |
| backups | `/var/log/eventor/backup.log` |
| System | `journalctl -u nginx -u ssh --since '1 hour ago'` |

Log volume:

- Docker logs are capped at 10 MB × 5 files per service in the compose file.
- PM2 logs are **not** rotated by default — install `pm2 install pm2-logrotate`.
- nginx logs rotate via the distro's logrotate config.
- Every API response carries an `x-request-id`; with `LOG_REQUESTS=true` the same
  id appears in the app log, which is how you correlate an nginx access line with
  an application error. Keep it `false` normally and flip it on temporarily when
  debugging.

Socket.IO note (relevant to both nginx and PM2): the gateway is on namespace
`/admin` at the **default `/socket.io` path — it is NOT under `/api/v1`**,
because `setGlobalPrefix` only affects HTTP controllers. `nginx/eventor.conf`
has a dedicated `location /socket.io/` block with the upgrade headers and a
1-hour read timeout.

---

## 12. Switching queues to Redis (BullMQ)

`src/queue/queue.service.ts` picks its driver from `REDIS_URL` **at construction
time**:

- **`REDIS_URL` empty → `inline`.** `queue.add()` calls the handler immediately,
  in the same process, inside the caller's async flow, retrying up to `attempts`
  (default 3). Failures are logged, never thrown back at the HTTP caller. Jobs
  are not persisted: a restart loses whatever was in flight, and `delay` is
  ignored (jobs run right away).
- **`REDIS_URL` set → `bullmq`.** A `Queue` and a `Worker` are created on the
  `eventor` queue. Jobs are persisted in Redis, retried with exponential backoff
  (5 s base), deduplicated by `jobId` when given, kept for 1000 completed / 5000
  failed, and consumed with `concurrency: 4`. `delay` works.

To switch:

```bash
# Path A: the redis service already runs.
sed -i 's|^REDIS_URL=.*|REDIS_URL=redis://redis:6379|' .env.production
docker compose -f deploy/docker-compose.yml --env-file .env.production up -d api

# Path B:
sudo apt -y install redis-server && sudo systemctl enable --now redis-server
sed -i 's|^REDIS_URL=.*|REDIS_URL=redis://127.0.0.1:6379|' .env.production
pm2 restart eventor-api --update-env

# Verify either way:
curl -fsS https://api.example.com/api/v1/health/ready   # "queue":"bullmq"
```

What changes in practice: image processing (sharp → WebP thumb/medium variants),
outbound mail and notification fan-out stop blocking the request that triggered
them, survive restarts, and get real retries. Photo `processingStatus` will
briefly show as pending where it used to be done by the time the response came
back — the dashboard already handles that.

**Important:** there is currently **no standalone worker entrypoint**. The worker
is created inside the API process. A separate worker container/PM2 app is
sketched (commented out) in `docker-compose.yml` and `ecosystem.config.cjs`, but
it would be a second full API process that happens to also consume jobs. If you
want a real worker, add a `NestFactory.createApplicationContext` bootstrap first.

**Scaling / clustering:** do not raise `instances` past 1 without (a) sticky
sessions in nginx and (b) a Socket.IO Redis adapter wired into `CorsIoAdapter`.
Neither exists in the codebase. Without them, the engine.io polling handshake
breaks and live events only reach clients connected to the emitting process. A
BullMQ Redis connection does **not** solve this — it is a different layer.

---

## 13. What the client must still provide

None of this can be invented on our side:

1. **Domains & DNS** — the real domain, plus access to change DNS records.
   Suggested: `api.<domain>` and `admin.<domain>`. These become `API_URL`,
   `ADMIN_URL`, `APP_PUBLIC_URL`, `CORS_ORIGINS` and the certbot arguments.
2. **SMTP credentials** — Google Workspace relay (or equivalent): host, port,
   username, app password, and a sender address the relay is allowed to send as
   (`MAIL_FROM`; the default placeholder is `no-reply@eventor.dz`). Plus SPF,
   DKIM and DMARC records on the domain, or the mail will land in spam.
   Until this is set, `SMTP_HOST` stays empty and mails are only logged.
3. **Invoice issuer details** — legal company name, address, RC / NIF / NIS / AI
   identifiers, VAT treatment, bank details, and a logo, for the generated PDF
   invoices and the number sequences (`invoice_<year>`).
4. **Support contacts** — the support email / phone shown to users, and an
   operations address to receive certbot expiry warnings and backup alerts.
5. **Legal URLs** — Terms of Service and Privacy Policy pages (and their Arabic
   versions), which the apps link to.
6. **Firebase / FCM project** — service-account JSON and project id, when push
   notifications go live (`FCM_PROJECT_ID`, `FCM_CREDENTIALS_PATH`; both stubs
   for now).
7. **First admin identity** — the real name and email for `SEED_ADMIN_EMAIL` /
   `SEED_ADMIN_NAME`, and a secure channel to hand over the initial password.
8. **Hostinger access** — VPS plan sized for MySQL + Node (2 GB RAM minimum),
   panel access for snapshots, and confirmation of where off-site backups go.
