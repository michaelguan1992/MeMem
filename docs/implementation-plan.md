# MeMem Cloudflare MCP implementation plan

The service keeps `MemoryStore` and `createMemoryService` as the database boundary. A platform-independent MCP tool layer calls that core; the Cloudflare Worker composes D1, stateless Streamable HTTP, and OAuth 2.1. No model API is used.

## Status

- [x] Confirm project rules, the existing nine core tests, and the `MemoryStore` boundary.
- [x] Inspect installed Cloudflare Agents MCP v2, the MCP server/client SDKs, OAuth Provider consent helpers, and their type declarations.
- [x] Implement strict record/search/get/correct/forget tools, per-tool OAuth schemes, annotations, and descriptions that preserve wording, timezones, sources, relationship lookup, and current-vs-historical text behavior.
- [x] Compose stateless `/mcp` over the existing memory core and D1. Owner and scope data come only from `OAuthResourceContext` after provider validation.
- [x] Add generated high-entropy owner passphrase, salted verifier, browser-bound explicit consent, same-origin protection, bounded form-body parsing, OAuth discovery, PKCE S256, DCR, resource audience validation, and refresh tokens.
- [x] Add Wrangler JSON template, D1 migration wiring, separate OAuth KV binding, secret setup and deployment preflight scripts, and ignored mode-0600 local credential files.
- [x] Add Miniflare D1 + KV integration acceptance with a real MCP protocol client: metadata/DCR/PKCE/refresh, cross-client lookup, CRUD, conflicts, read-only token, invalid audience/verifier, and consent rejection cases.
- [x] Run TypeScript checks, the original nine core tests, and Worker integration tests; inspect the production Worker bundle against the dependency advisory.
- [x] Deploy the production Worker and configure the authorized D1/KV bindings.
- [x] Verify protected-resource metadata returns HTTP 200 and ChatGPT discovers the production endpoint.
- [x] Run the one-time production acceptance script: OAuth DCR/PKCE/consent, MCP CRUD, second-client reconnection, and test-record cleanup passed.
- [x] Deploy the consent referrer/CSP fix and verify Chrome OAuth returns to ChatGPT with “Primary is now connected.”
- [x] Verify real ChatGPT web memory write and cross-conversation search using the configured production connection.
- [x] Delete the single ChatGPT acceptance fixture using its exact record ID, owner, and marker; D1 reported one deletion and zero matching rows remain.
- [x] Advertise `memory:read memory:write` in the 401 challenge and protected-resource metadata so Claude custom connectors request write access up front (local tests pass).
- [x] Deploy that change as version `5cfcee9a-1501-40d9-8b35-be462543309f`; curl confirmed the 401 challenge and resource metadata list `memory:read memory:write`.
- [x] Verify a Claude custom connector end to end: record, search, get, correct (v1→v2), and forget all succeeded through the connected Claude tools; a marker search afterwards returned zero matches.
- [x] Translate the consent page and authorization error pages to English (local tests pass).
- [x] Deploy the English consent page as version `01b77180-dd4e-4f05-9cc4-7514f46bf660`; curl confirmed the English error page and `/mcp` still returns 401 without a token.

## Next: diary and recall

Design: `docs/diary-recall-design.md`. Implementation followed AGENTS.md roles: the main agent split Phase 1 into four bounded briefs, each implemented by a Claude Haiku subagent (effort=max) and reviewed before the next.

- [x] Phase 1, task 1: `MediaStore`/`BlobStore` contracts, `0002_media.sql` (media + web_sessions), core photo service (magic-byte type check, size limits, SHA-256 verification, per-owner dedup, blob cleanup on failure, CAS edits, unlink), D1 and R2 adapters, core tests.
- [x] Phase 1, task 2: `/capture` owner-passphrase login with hashed D1 sessions, `__Host-` HttpOnly SameSite=Strict cookie, CSRF token, logout.
- [x] Phase 1, task 3: session-protected `/api/entries`, `/api/related`, `/api/media` upload/list/patch/delete/read; deleting a memory (including via MCP `forget_memory`) unlinks its photos best-effort.
- [x] Phase 1, task 4: capture page, browser EXIF time prefill, client-side display/thumbnail generation, per-photo status and retry, web app manifest, strict CSP.
- [x] Local checks: `npm run check` passes; `npm test` passes (42 core tests, 24 Worker integration tests across 3 files).
- [x] Local browser check against `wrangler dev` (Miniflare D1/R2): sign-in, entry creation, photo upload, all three R2 variants read back with correct sizes, mobile/dark layout, logout. This found and fixed a bug the integration tests missed: `Referrer-Policy: no-referrer` made the browser send `Origin: null`, so the capture pages now use `same-origin`.
- [x] Refactor: the `/capture` browser script is TypeScript in `src/client/` (EXIF reader split into small functions) and is built by `npm run build:client` (esbuild) into the gitignored `src/generated/`; `check`, `test`, `coverage`, `dev`, and `deploy` run it automatically. Verified with `npm run check`, `npm test` (66 tests), and a local browser upload against `wrangler dev` (all three variants read back at the expected sizes).
- [x] Idempotent writes: `POST /api/entries` replays a client-chosen `id` that the capture page keeps across retries of unchanged content (edited content gets a new `id`); verified in a local browser run with a simulated lost response; photo blobs are content-addressed (`{owner}/{sha256}/{variant}`), and uploads never delete blobs; a photo delete removes blobs before its row, so a retry finishes an interrupted delete and a repeat succeeds; a failed photo unlink now fails the memory forget, and the retry finishes it. No migration is needed because photo storage is not deployed; a local test photo saved before this change keeps its bytes under the old per-ID keys and no longer serves them. `npm run check` and `npm test` pass (83 tests, up from 66).
- [x] Refactor: one zod schema module (`src/core/schema.ts`) now holds every memory and photo rule, limit, and message; IDs, digests, timestamps, and versions are branded values that only the schemas produce; the MCP tool inputs and the web API bodies are built from those schemas, and storage rows are parsed through them (a corrupt row is a storage error, never data). The MCP `tools/list` wire JSON is byte-identical to the previous release, checked by a fixture test. `npm run check` and `npm test` pass (91 tests, up from 83).
- [ ] Not verified: iPhone Safari/home-screen install, HEIC photos, real EXIF photos in a browser, large photos' memory use. Not deployed: needs the R2 bucket `memem-media`, an R2 permission on the deployment token, the `0002` migration, a decision on login rate limiting, and a read-only check that every existing production `memories` row passes the stored-row schema (rows are now parsed on read, and a row that fails makes that read an error).
- [ ] Phase 2: recall pages and MCP tools (`list_media`, `create_recall`, …).

## Verification and remaining advisory

`npm run check` and `npm test` pass locally after the consent regression fix. The production dry-run `wrangler deploy --dry-run --env production --outdir /tmp/memem-final-review` also exited successfully before deployment. The production bundle was 1,473.72 KiB (266.35 KiB gzip); its source map had 182 sources and listed neither `@modelcontextprotocol/client` nor `@modelcontextprotocol/sdk`. The dependency tree still reports GHSA-6qxp-vccf-f47h through `agents@0.28.0`'s pinned peer versions (`@modelcontextprotocol/client@2.0.0` and `@modelcontextprotocol/sdk@1.30.0`). The report remains open; the build evidence indicates those client packages are not included in the deployed Worker bundle.

## Deployment status

The parent agent first deployed Worker version `77fe6ade-e499-420b-b57d-6e1f5fda012a` (later superseded by `5cfcee9a-1501-40d9-8b35-be462543309f` for advertised scopes and `01b77180-dd4e-4f05-9cc4-7514f46bf660` for the English consent page) at `https://memem.michaelguan1992.workers.dev` and configured production D1/KV bindings. Protected-resource metadata returned HTTP 200; the production acceptance script passed OAuth DCR/PKCE/consent and MCP create/search/correct/reconnect/delete with test-record cleanup. The deployed consent page uses `Referrer-Policy: same-origin` and limits CSP `form-action` to self plus the origin (including port) from OAuthProvider’s validated redirect URI, while retaining `default-src 'none'` and rejecting null/missing Origin. Chrome OAuth returned to ChatGPT and showed “Primary is now connected.” Real ChatGPT web testing then saved a fictional marked memory in one conversation and found the same record in a separate conversation with the expected related-person, date, and restaurant details. The fixture was then deleted by the parent agent with the owner/ID/marker-scoped SQL command; D1 reported one deletion and zero matching rows. The local deployment-token file was deleted, and Cloudflare confirmed that the deployment token has been revoked. Production deployment and ChatGPT web end-to-end acceptance are complete. iPhone native app and Safari web have not been tested. The implementation agent did not run remote commands or read production credentials.
