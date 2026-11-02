# Project Rules

## Roles
- The main agent owns requirements, architecture, acceptance criteria, review, and Cloudflare account actions. The main agent runs on a stronger model, plans the code, and splits it into concrete, bounded task briefs (files, interfaces, acceptance checks). Coding agents implement those briefs and report commands and observable results.
- The implementation agent for this service is `gpt-6-luna` with `reasoning_effort=max`. When the main agent runs in Claude (Claude Code), the implementation agent is instead a Claude Haiku subagent with `effort=max`. If the required model or effort is unavailable, report the limitation and wait for direction.

## Architecture
- Keep the database adapter independent from the deployment platform. `MemoryStore` in `src/core/contracts.ts` is the stable boundary; platform entrypoints compose a store with the core.
- Each person deploys their own Worker and database.
- Keep AI and client integrations outside the memory core. The core has no AI provider or API key dependency.
- D1 stores memory data, photo metadata, and hashed web sessions; the private R2 binding `MEDIA` stores photo files. The dedicated `OAUTH_KV` binding stores OAuth clients, grants, consent handles, and tokens; never put memory records in OAuth storage.
- Derive owner identity only from the provider-verified OAuth context. MCP tool input must not accept an owner or user identity.

## Current implementation status
- The Cloudflare Worker, stateless Streamable HTTP MCP tools, OAuth 2.1 PKCE/S256, protected-resource and authorization-server metadata, DCR, browser-bound consent, owner passphrase verification, refresh flow, Wrangler template, D1 migration, and secret setup scripts are implemented.
- Local validation uses Miniflare D1, KV, and R2 plus an official MCP protocol client. Run `npm run check` and `npm test`; `npm test` includes the original nine core tests, the photo/capture core tests, and the Worker integration suites.
- The Worker is deployed at `https://memem.michaelguan1992.workers.dev` (version `01b77180-dd4e-4f05-9cc4-7514f46bf660`, English consent page). Protected-resource metadata returned HTTP 200; the production acceptance script completed OAuth and MCP CRUD with cleanup; Chrome OAuth returned to ChatGPT. Real ChatGPT web acceptance also saved a memory in one conversation and found it in a separate conversation. The ChatGPT acceptance fixture was deleted with an owner/ID/marker-scoped query (one deletion, zero remaining matches). The local deployment-token file was deleted, and Cloudflare confirmed that the deployment token has been revoked. Production deployment and ChatGPT web end-to-end acceptance are complete. iPhone native app and Safari web are unverified. The 401 challenge and resource metadata now advertise `memory:read memory:write` for Claude custom connectors; this is deployed in version `5cfcee9a-1501-40d9-8b35-be462543309f` and verified by curl; a real Claude custom connector completed record/search/get/correct/forget against production with the marked fixture deleted (zero remaining matches); Claude cross-conversation lookup was not separately tested.
- Photo diary Phase 1 (R2 photo storage, `/capture` page with owner-passphrase sessions, `/api/*` upload endpoints) is implemented and verified locally only (`npm test` and a local browser run against `wrangler dev`); it is not deployed. See `docs/implementation-plan.md`.
- A current dependency-tree audit still reports GHSA-6qxp-vccf-f47h through Agents' pinned MCP client/SDK peer versions. The reviewed Worker bundle does not contain either client package or its OAuth-client code. Record both facts; do not describe the advisory as patched.

## Change requirements
- Update `docs/implementation-plan.md` when implementation status changes.
- Keep README and this file aligned with current code and test results; do not describe local integration tests as proof of cloud deployment.
- Run focused checks for each change, then `npm run check` and `npm test` before reporting completion.
