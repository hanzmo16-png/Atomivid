/** Compatibility facade for the existing Drive connection. Verifier is shared, not an executor. */
export { bearer, verifyGithubOidc, GITHUB_OIDC_ISSUER, GITHUB_OIDC_JWKS, type OidcPolicy, type OidcResult } from "../security/github-oidc";
export const DRIVE_TOKEN_AUDIENCE = "atomivid-drive-token";
export const ALLOWED_WORKFLOWS = ["orchestrator.yml", "drive-oauth.yml", "mystery-shopper.yml"] as const;
