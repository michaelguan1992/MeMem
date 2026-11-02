declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MEDIA: R2Bucket;
    OAUTH_KV: KVNamespace;
    MCP_RESOURCE_URL: string;
    OAUTH_ISSUER: string;
    OWNER_PASSWORD_HASH: string;
    APP_ENV: string;
  }
}
