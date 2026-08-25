#!/usr/bin/env bash
# Portainer one-shot deploy for umbra-server.
#
# Standard Portainer deploy pattern:
#   1. cross-compile linux/amd64 binary
#   2. tar Dockerfile + binary
#   3. POST /api/auth -> JWT
#   4. POST /api/endpoints/{id}/docker/build (Content-Type: application/x-tar)
#   5. stop+remove old container
#   6. POST containers/create with Binds/Ports/RestartPolicy/Dns/Env
#   7. POST containers/{id}/start
#   8. for i in 1..N; curl /health; sleep 1
#
# Why API + tar instead of compose stack?
# - NAS / Portainer Stack endpoint won't accept tar build context
# - No outbound registry (or you don't want to push), so local build is the only path
# - Portainer host is the same machine running docker; let it build there
#
# Required env (default in-line below — tweak per environment):
#   PORTAINER_URL, PORTAINER_USER, PORTAINER_PASS
#   ENDPOINT_ID (Portainer endpoint, default 2)
#   IMAGE_TAG (default umbra-server:latest)
#   CONTAINER_NAME (default umbra-1)
#   NETWORK (default umbra_default — must already exist with db + redis on it)
#   API_PORT/WS_PORT/PROXY_PORT (host port mappings; defaults match Node version)
set -euo pipefail

cd "$(dirname "$0")/.."

PORTAINER_URL=${PORTAINER_URL:-http://127.0.0.1:9000}
PORTAINER_USER=${PORTAINER_USER:-admin}
PORTAINER_PASS=${PORTAINER_PASS:?PORTAINER_PASS env required}
ENDPOINT_ID=${ENDPOINT_ID:-2}
IMAGE_TAG=${IMAGE_TAG:-umbra-server:latest}
CONTAINER_NAME=${CONTAINER_NAME:-umbra-1}
NETWORK=${NETWORK:-umbra_default}
HOST_API_PORT=${HOST_API_PORT:-8118}
HOST_WS_PORT=${HOST_WS_PORT:-4343}
HOST_PROXY_PORT=${HOST_PROXY_PORT:-8119}
DB_HOST=${DB_HOST:-db}
REDIS_HOST=${REDIS_HOST:-redis}

TAR=/tmp/umbra-go-build.tar
JWT_FILE=/tmp/umbra-go.jwt

step() { printf '\n[deploy] %s\n' "$*"; }

step "1/8 cross-compile linux/amd64 ..."
mkdir -p deploy
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath -ldflags="-s -w" \
    -o deploy/umbra-server ./cmd/umbra-server
ls -lh deploy/umbra-server

step "2/8 pack tar ..."
# Refresh GUI bundle so the image contains the latest dist.
rm -rf deploy/gui-dist
cp -R ../gui/dist deploy/gui-dist
# Refresh extensions bundle (main + embed targets + cookie-sync).
rm -rf deploy/extensions
mkdir -p deploy/extensions
cp -R ../extension deploy/extensions/main
cp -R ../embed-targets/* deploy/extensions/
cp -R ../cookie-sync-extension deploy/extensions/cookie-sync
[ -d ../bypass-paywalls-chrome ] && cp -R ../bypass-paywalls-chrome deploy/extensions/bypass-paywalls
( cd deploy && tar -cf "$TAR" Dockerfile umbra-server gui-dist extensions )
ls -lh "$TAR"

step "3/8 POST /api/auth ..."
JWT=$(curl -sS -X POST -H 'Content-Type: application/json' \
    -d "{\"Username\":\"$PORTAINER_USER\",\"Password\":\"$PORTAINER_PASS\"}" \
    "$PORTAINER_URL/api/auth" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['jwt'])")
echo "$JWT" > "$JWT_FILE"
echo "  ok"

step "4/8 build $IMAGE_TAG ..."
curl -sS -X POST \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/x-tar" \
    --data-binary @"$TAR" \
    "$PORTAINER_URL/api/endpoints/$ENDPOINT_ID/docker/build?t=$IMAGE_TAG&dockerfile=Dockerfile" \
    -o /tmp/build.log
python3 -c "
import json,sys
errs=[]
for line in open('/tmp/build.log'):
    line=line.strip()
    if not line: continue
    try:
        d=json.loads(line)
        if 'errorDetail' in d: errs.append(d['errorDetail'])
    except: pass
if errs:
    print('BUILD FAILED:');
    for e in errs: print(' ',e)
    sys.exit(2)
print('  build OK')
"

step "5/8 stop + remove old $CONTAINER_NAME (if exists) ..."
OLD_CID=$(curl -sS -H "Authorization: Bearer $JWT" \
    "$PORTAINER_URL/api/endpoints/$ENDPOINT_ID/docker/containers/json?all=true" \
    | python3 -c "
import json,sys
for c in json.load(sys.stdin):
    if any('/$CONTAINER_NAME' == n or '/$CONTAINER_NAME'.lstrip('/') in n for n in c['Names']):
        print(c['Id']); break
")
if [[ -n "$OLD_CID" ]]; then
    curl -sS -X POST -H "Authorization: Bearer $JWT" \
        "$PORTAINER_URL/api/endpoints/$ENDPOINT_ID/docker/containers/$OLD_CID/stop?t=10" -o /dev/null
    curl -sS -X DELETE -H "Authorization: Bearer $JWT" \
        "$PORTAINER_URL/api/endpoints/$ENDPOINT_ID/docker/containers/$OLD_CID?force=true" -o /dev/null
    echo "  removed $OLD_CID"
else
    echo "  no existing container"
fi

step "6/8 create new container ..."
cat > /tmp/create.json <<EOF
{
  "Image": "$IMAGE_TAG",
  "Hostname": "$CONTAINER_NAME",
  "Env": [
    "DATABASE_HOST=$DB_HOST",
    "DATABASE_PORT=5432",
    "DATABASE_NAME=${DATABASE_NAME:-umbra}",
    "DATABASE_USER=${DATABASE_USER:-umbra}",
    "DATABASE_PASSWORD=${DATABASE_PASSWORD:?DATABASE_PASSWORD env var is required}",
    "REDIS_HOST=$REDIS_HOST",
    "REDIS_PORT=6379",
    "BCRYPT_ROUNDS=10",
    "API_PORT=8118",
    "WS_PORT=4343",
    "PROXY_PORT=8080",
    "TZ=${TZ:-UTC}"
  ],
  "ExposedPorts": {
    "8118/tcp": {},
    "4343/tcp": {},
    "8080/tcp": {}
  },
  "HostConfig": {
    "NetworkMode": "$NETWORK",
    "PortBindings": {
      "8118/tcp": [{"HostIp":"","HostPort":"$HOST_API_PORT"}],
      "4343/tcp": [{"HostIp":"","HostPort":"$HOST_WS_PORT"}],
      "8080/tcp": [{"HostIp":"","HostPort":"$HOST_PROXY_PORT"}]
    },
    "RestartPolicy": {"Name":"unless-stopped","MaximumRetryCount":0},
    "Dns": ["8.8.8.8","1.1.1.1"]
  },
  "Labels": {
    "com.docker.compose.project": "umbra",
    "com.docker.compose.service": "umbra"
  }
}
EOF
NEW_CID=$(curl -sS -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
    --data-binary @/tmp/create.json \
    "$PORTAINER_URL/api/endpoints/$ENDPOINT_ID/docker/containers/create?name=$CONTAINER_NAME" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['Id'])")
echo "  $NEW_CID"

step "7/8 start ..."
curl -sS -X POST -H "Authorization: Bearer $JWT" \
    "$PORTAINER_URL/api/endpoints/$ENDPOINT_ID/docker/containers/$NEW_CID/start" -o /dev/null

step "8/8 health check (up to 90s) ..."
HOST=${PORTAINER_URL#http://}; HOST=${HOST%%:*}
for i in $(seq 1 90); do
    if curl -fsS "http://$HOST:$HOST_API_PORT/health" 2>/dev/null | grep -q '"success":true'; then
        echo "  HEALTH OK after ${i}s"
        echo "[deploy] DONE"
        exit 0
    fi
    sleep 1
done
echo "  HEALTH TIMEOUT — investigate via Portainer UI"
exit 1
