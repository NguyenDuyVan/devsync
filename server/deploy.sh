#!/usr/bin/env bash
set -euo pipefail

HOST_ALIAS="${HOST_ALIAS:-HappyFinate}"
PUBLIC_HOST="${PUBLIC_HOST:-76.13.184.246}"
REMOTE_DIR=/opt/devsync

cd "$(dirname "$0")"
ssh "$HOST_ALIAS" "mkdir -p $REMOTE_DIR/data && chown 1000:1000 $REMOTE_DIR/data && chmod 700 $REMOTE_DIR/data"
rsync -a --delete --exclude data ./ "$HOST_ALIAS:$REMOTE_DIR/"
ssh "$HOST_ALIAS" "cd $REMOTE_DIR && printf 'PUBLIC_HOST=%s\n' '$PUBLIC_HOST' > .env && docker compose up -d --build && sleep 3 && docker compose ps && docker compose logs --tail 5"
echo
echo "Tạo chuỗi kết nối cho máy đầu tiên:"
echo "  ssh $HOST_ALIAS 'docker exec devsync node src/admin.ts invite'"
