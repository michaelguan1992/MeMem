#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
SECRET_DIR="$ROOT_DIR/.secrets"
TOKEN_FILE="$SECRET_DIR/cloudflare-api-token"

if [[ ! -t 0 || ! -t 1 ]]; then
  printf 'Run this helper from Terminal so the token can be entered without being shown.\n' >&2
  exit 1
fi
if [[ -L "$SECRET_DIR" || ( -e "$SECRET_DIR" && ! -d "$SECRET_DIR" ) ]]; then
  printf 'Refusing to use an unsafe .secrets path.\n' >&2
  exit 1
fi
if [[ -e "$TOKEN_FILE" || -L "$TOKEN_FILE" ]]; then
  printf 'Refusing to overwrite .secrets/cloudflare-api-token. Remove it deliberately first.\n' >&2
  exit 1
fi

mkdir -p -m 700 "$SECRET_DIR"
chmod 700 "$SECRET_DIR"

TOKEN=''
if ! IFS= read -r -s -p 'Paste the short-lived Cloudflare API token (input is hidden): ' TOKEN; then
  printf '\nNo token was saved.\n' >&2
  exit 1
fi
printf '\n'
if [[ -z "$TOKEN" ]]; then
  printf 'Empty token; nothing was saved.\n' >&2
  exit 1
fi

umask 077
if ! (set -o noclobber; : > "$TOKEN_FILE") 2>/dev/null; then
  printf 'Refusing to overwrite .secrets/cloudflare-api-token.\n' >&2
  exit 1
fi
cleanup() { rm -f "$TOKEN_FILE"; }
trap cleanup EXIT HUP INT TERM
if ! printf '%s' "$TOKEN" > "$TOKEN_FILE"; then
  printf 'Could not save the token.\n' >&2
  exit 1
fi
chmod 600 "$TOKEN_FILE"
trap - EXIT HUP INT TERM
unset TOKEN
printf 'Saved locally with mode 0600. The token was not displayed.\n'
