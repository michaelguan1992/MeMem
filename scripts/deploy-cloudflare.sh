#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Complete every local check and build before any remote secret or schema change.
npm run check
npm test
node scripts/wrangler-cloudflare.mjs deploy --dry-run --env production
node scripts/validate-deployment.mjs

# Apply the additive D1 migration before uploading the owner verifier.
node scripts/wrangler-cloudflare.mjs d1 migrations apply memem --remote --env production
node scripts/wrangler-cloudflare.mjs secret put OWNER_PASSWORD_HASH --env production < .secrets/owner-password-hash
node scripts/wrangler-cloudflare.mjs deploy --env production
