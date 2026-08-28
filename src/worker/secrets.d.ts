// Wrangler cannot infer secret names because their values are intentionally absent from wrangler.jsonc.
interface Env {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
}
