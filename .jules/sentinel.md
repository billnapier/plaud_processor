## 2024-07-24 - [CRITICAL] Authentication Bypass via Negative Environment Checks
**Vulnerability:** The `verifyOidcToken` function was completely bypassed in production due to a negative check: `if (process.env.NODE_ENV !== 'production')`. Since Docker/Terraform environments didn't explicitly set `NODE_ENV='production'`, it defaulted to undefined, making the condition true and skipping authentication for all internal webhooks and workers.
**Learning:** Checking what an environment variable *isn't* (`!== 'production'`) fails open (insecure) if the variable is missing. It bypasses security controls in environments where `NODE_ENV` is just undefined.
**Prevention:** Always use positive checks for development bypasses (e.g., `=== 'development'`). Fail securely by default if variables are missing.

## 2024-07-24 - [CRITICAL] Authentication Bypass via OIDC Audience Forgery
**Vulnerability:** The `verifyOidcToken` function used the user-controlled `req.get('host')` HTTP header to construct the expected audience for OIDC token verification. An attacker could bypass authentication by providing a valid Google-issued token meant for a different service they control, and then manipulating the `Host` header to match that service's audience.
**Learning:** Never trust the `Host` header or other user-controlled input when constructing security-critical values like the expected audience for token verification.
**Prevention:** Always use a trusted source (e.g., a static configuration value or a trusted environment variable) for the expected audience when verifying OIDC tokens.

## 2024-07-24 - [CRITICAL] Host Header Injection in OAuth Redirect URI
**Vulnerability:** The `getGmailOAuth2Client` function constructed the OAuth `redirectUri` using user-controlled HTTP headers (`Host` and `X-Forwarded-Host`) from incoming requests. An attacker could provide a malicious Host header to hijack the OAuth flow, directing the authorization code to their own server.
**Learning:** This is the second instance of a vulnerability caused by using user-controlled headers for security-critical URL construction (the first being OIDC expected audience). There is a pattern of relying on the incoming request to build URLs rather than trusted, static configuration.
**Prevention:** Never trust HTTP headers (`Host`, `X-Forwarded-Host`, etc.) to construct URLs used for authentication, authorization, or redirects. Always use trusted configuration variables (like `process.env.DOMAIN_NAME`).
