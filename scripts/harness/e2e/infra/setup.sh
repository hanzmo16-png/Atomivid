#!/usr/bin/env bash
# Prepara el arnés E2E local DESDE UN CHECKOUT LIMPIO (T-20261019-1553). USD 0, todo en 127.0.0.1.
# Todo lo generado (binarios, BD, secretos aleatorios, logs) vive en $E2E_HOME (por defecto <repo>/.e2e-local, ignorado
# por git). Ningún secreto se versiona: el secreto JWT se genera aquí con openssl y sólo existe en $E2E_HOME/secrets.
# Requisitos del sistema: PostgreSQL 17 (initdb/pg_ctl; PG_BIN o pg_config), psql, ffmpeg/ffprobe, curl, xz, openssl,
# git, npm. Node 22 y PostgREST v12.2.3 se descargan si faltan. Uso: scripts/harness/e2e/infra/setup.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(git -C "$HERE" rev-parse --show-toplevel)
E2E_HOME=${E2E_HOME:-$REPO/.e2e-local}; PGPORT=${E2E_PGPORT:-55432}
mkdir -p "$E2E_HOME"/{bin,deps,secrets,logs,storage,run,synth,out}; chmod 700 "$E2E_HOME/secrets"
PG_BIN=${PG_BIN:-$( (pg_config --bindir 2>/dev/null) || ls -d /usr/lib/postgresql/17/bin 2>/dev/null || true)}
[ -x "$PG_BIN/initdb" ] || { echo "Falta PostgreSQL 17 (define PG_BIN)"; exit 1; }
for t in psql ffmpeg ffprobe curl openssl git npm xz; do command -v $t >/dev/null || { echo "Falta $t"; exit 1; }; done

# Node 22 (supabase-js del worker necesita WebSocket nativo, igual que render.yml)
NODE_DIR="$E2E_HOME/bin/node-v22.12.0-linux-x64"
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null && [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz | tar -xJ -C "$E2E_HOME/bin"; fi
[ -x "$NODE_DIR/bin/node" ] && export PATH="$NODE_DIR/bin:$PATH"
# PostgREST real
[ -x "$E2E_HOME/bin/postgrest" ] || curl -fsSL https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz | tar -xJ -C "$E2E_HOME/bin"
# Dependencias del arnés (fuera del package.json del producto)
[ -d "$E2E_HOME/deps/node_modules/playwright" ] || npm install --silent --no-audit --no-fund --prefix "$E2E_HOME/deps" playwright@1.48.2 pg@8.13.1
[ -d "$REPO/node_modules" ] || (cd "$REPO" && npm ci --no-audit --no-fund)
# Chrome headless shell con H.264 (el de Playwright no reproduce MP4): el que usa Remotion
(cd "$REPO" && npx remotion browser ensure >/dev/null)
CHROME=$(ls "$REPO"/node_modules/.remotion/chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell | head -1)

# Secretos locales aleatorios (nunca versionados)
if [ ! -f "$E2E_HOME/secrets/jwt.env" ]; then (umask 077; echo "GW_JWT_SECRET=$(openssl rand -hex 32)" > "$E2E_HOME/secrets/jwt.env"); fi
set -a; . "$E2E_HOME/secrets/jwt.env"; set +a
eval "$(node "$HERE/mint.mjs" | sed 's/^/export /')"   # ANON / SERVICE
(umask 077
cat > "$E2E_HOME/secrets/pgrst.conf" <<CONF
db-uri = "postgres://authenticator:local-auth@localhost:$PGPORT/atomivid"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$GW_JWT_SECRET"
server-host = "127.0.0.1"
server-port = 3001
db-pool = 20
CONF
OWNER_ID=$(node -e 'console.log(require(process.argv[1])[0].id)' "$HERE/users.json"); OWNER_EMAIL=$(node -e 'console.log(require(process.argv[1])[0].email)' "$HERE/users.json")
COMMON="NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON
SUPABASE_SERVICE_ROLE_KEY=$SERVICE
VOICE_PROVIDER=fixture
FOOTAGE_PROVIDER=fixture
MUSIC_PROVIDER=fixture
PREMIUM_CLIPS_ENABLED=false
IMAGE_GENERATION_ENABLED=false
SUPPLY_GUARD_ENFORCED=true
CINEMATIC_DIRECTOR_RENDER_ENABLED=1
CINEMATIC_DIRECTOR_PILOT_EMAILS=$OWNER_EMAIL
GH_WORKER_TOKEN=local-fake-token
GH_WORKER_REPO=local/test"
printf '%s\n' "$COMMON" "SCRIPT_PROVIDER=anthropic" "ANTHROPIC_API_KEY=local-fake-anthropic" "ANTHROPIC_BASE_URL=http://127.0.0.1:54500" \
  "INTERNAL_PRODUCTION_OWNER_USER_ID=$OWNER_ID" "IMAGE_PROVIDER=openai" "OPENAI_API_KEY=local-fake-openai" > "$E2E_HOME/secrets/next.env"
printf '%s\n' "$COMMON" "SCRIPT_PROVIDER=fixture" "IMAGE_PROVIDER=fixture" "ATOMIVID_WORKER_LOCAL_FIXTURE=1" \
  "REMOTION_BROWSER_EXECUTABLE=$CHROME" "REMOTION_CHROME_MODE=headless-shell" "PATH=$PATH" "HOME=$HOME" \
  | node -e 'const l=require("fs").readFileSync(0,"utf8").trim().split("\n");console.log(JSON.stringify(Object.fromEntries(l.map(x=>[x.slice(0,x.indexOf("=")),x.slice(x.indexOf("=")+1)]))))' > "$E2E_HOME/secrets/worker-env.json"
)
echo "CHROME=$CHROME" > "$E2E_HOME/paths.env"; echo "PG_BIN=$PG_BIN" >> "$E2E_HOME/paths.env"; echo "PGPORT=$PGPORT" >> "$E2E_HOME/paths.env"

# Postgres local propio
PGDATA="$E2E_HOME/pg"; PSQL="psql -h $E2E_HOME/run -p $PGPORT -U postgres -v ON_ERROR_STOP=1 -q"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  "$PG_BIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
  "$PG_BIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k $E2E_HOME/run -c listen_addresses=localhost" -l "$E2E_HOME/logs/pg.log" -w start >/dev/null
  $PSQL -d postgres -c "create database atomivid"
  $PSQL -d atomivid -f "$HERE/stubs.sql"
  # Migraciones del árbol en orden + 0023 (production intelligence, numeric(12,4)) desde 9dccd68, verificada por sha256
  git -C "$REPO" cat-file -e 9dccd68c3b06bffab2dc91ab415de6c2a73062bd 2>/dev/null || git -C "$REPO" fetch -q origin 9dccd68c3b06bffab2dc91ab415de6c2a73062bd
  git -C "$REPO" show 9dccd68c3b06bffab2dc91ab415de6c2a73062bd:supabase/migrations/0023_production_intelligence.sql > "$E2E_HOME/run/0023.sql"
  echo "0b49d9a4752d19c1b6f6f24df6c3f0c6fbdbd39136a41832f5a6189aa7fa8131  $E2E_HOME/run/0023.sql" | sha256sum -c --quiet
  # Fallos conocidos y aceptados (no afectan al Reel): pg_net no existe en PG local; podcast image slot (json) — ver cierre.
  KNOWN="20261011020000_pilot_scheduler.sql 20261014183400_finished_podcast_image_slot.sql"
  for f in $(ls "$REPO"/supabase/migrations/*.sql | sort); do
    b=$(basename "$f"); [ "$b" \> "0019_long_form_production_plan.sql" ] && [ ! -f "$E2E_HOME/run/0023.done" ] && { $PSQL -d atomivid -f "$E2E_HOME/run/0023.sql"; touch "$E2E_HOME/run/0023.done"; }
    if ! $PSQL -d atomivid -f "$f" > "$E2E_HOME/logs/mig-$b.log" 2>&1; then
      case " $KNOWN " in *" $b "*) echo "AVISO migración conocida no aplicable en local: $b";; *) echo "FALLO migración $b"; cat "$E2E_HOME/logs/mig-$b.log"; exit 1;; esac
    fi
  done
  node -e 'for (const u of require(process.argv[1])) console.log(`insert into auth.users(id,email,email_confirmed_at) values (${"\x27"+u.id+"\x27"},${"\x27"+u.email+"\x27"},now()) on conflict do nothing;`)' "$HERE/users.json" | $PSQL -d atomivid
  $PSQL -d atomivid -f "$HERE/seed-config.sql"
fi
# Imágenes sintéticas texturizadas (mock de OpenAI Images y QA de movimiento)
if [ ! -f "$E2E_HOME/synth/img5.png" ]; then
  G="drawgrid=w=64:h=64:t=2:c=white@0.5,noise=alls=25:allf=u"; S="$E2E_HOME/synth"
  ffmpeg -v error -y -f lavfi -i "testsrc2=s=1024x1536:r=1" -vf "$G" -frames:v 1 "$S/img0.png"
  ffmpeg -v error -y -f lavfi -i "mandelbrot=s=1024x1536:start_scale=1.5:inner=period" -vf "$G" -frames:v 1 "$S/img1.png"
  ffmpeg -v error -y -f lavfi -i "cellauto=s=1024x1536:rule=110:random_seed=7:full=1" -vf "format=rgb24,geq=r='255*p(X,Y)/255':g='X/4':b='Y/6',$G" -frames:v 1 "$S/img2.png"
  ffmpeg -v error -y -f lavfi -i "life=s=1024x1536:seed=3:ratio=0.3:mold=10:life_color=#ff8800:death_color=#002244" -vf "$G" -frames:v 1 "$S/img3.png"
  ffmpeg -v error -y -f lavfi -i "color=c=black:s=1024x1536" -vf "format=rgb24,geq=r='128+127*sin(X/23)*cos(Y/31)':g='128+127*sin((X+Y)/17)':b='128+127*cos(hypot(X-512,Y-768)/19)',$G" -frames:v 1 "$S/img4.png"
  ffmpeg -v error -y -f lavfi -i "smptehdbars=s=1024x1536" -vf "rotate=0.35:fillcolor=gray,$G" -frames:v 1 "$S/img5.png"
fi
echo "OK: arnés listo en $E2E_HOME. Siguiente: scripts/harness/e2e/infra/start.sh y run-e2e.sh <salida> [RED]"
