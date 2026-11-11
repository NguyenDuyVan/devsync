#!/bin/sh
set -eu

TLS_DIR="${DATA_DIR:-/data}/tls"
if [ ! -f "$TLS_DIR/cert.pem" ]; then
  mkdir -p "$TLS_DIR"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=devsync" \
    -addext "subjectAltName=IP:${PUBLIC_HOST:-127.0.0.1}" \
    -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem"
  chmod 600 "$TLS_DIR/key.pem"
fi

exec node src/server.ts
