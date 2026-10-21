declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    OAUTH_KV: KVNamespace;
    MCP_RESOURCE_URL: string;
    OAUTH_ISSUER: string;
    OWNER_PASSWORD_HASH: string;
    APP_ENV: string;
  }
}
