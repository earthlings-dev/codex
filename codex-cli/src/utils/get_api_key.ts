import type { Request, Response } from "express";

import chalk from "chalk";
import express from "express";
import crypto from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { URL, URLSearchParams } from "node:url";
import open from "open";

interface OidcConfiguration {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

// Helper: Retrieve OIDC configuration from an issuer.
async function getOidcConfiguration(
  issuer: string,
): Promise<OidcConfiguration> {
  const discoveryUrl = new URL(issuer);
  discoveryUrl.pathname = "/.well-known/openid-configuration";
  if (issuer === "https://auth.openai.com") {
    // this should be fixed at some point
    // https://openai.slack.com/archives/C04F7LKA95K/p1744405048509179?thread_ts=1744402916.883479&cid=C04F7LKA95K
    discoveryUrl.pathname = "/v2.0" + discoveryUrl.pathname;
  }
  const res = await fetch(discoveryUrl.toString());
  if (!res.ok) {
    throw new Error("Failed to fetch OIDC configuration");
  }
  return (await res.json()) as OidcConfiguration;
}

interface Org {
  /**
   * Org ID.
   */
  id: string;
  /**
   * Human-readable name for org.
   */
  title: string;
  /**
   * Role user has in org.
   */
  role: string;
  /**
   * Whether this is the user's default org.
   */
  is_default: boolean;
}

interface IDTokenClaims {
  "https://api.openai.com/auth": {
    /**
     * @see https://github.com/openai/openai/blob/874ab35a4c221888c35962bea280a2539dde76f4/api/primaryapi/primaryapi/api/oauth_api.py#L869-L880
     */
    organizations?: Array<Org>;
  };
}

export async function selectOrganization(orgs: Array<Org>): Promise<Org> {
  if (orgs.length === 0) {
    throw new Error("No organizations to choose from");
  }
  if (orgs.length === 1) {
    return orgs[0]!;
  }

  const defaultIdx = orgs.findIndex((o) => o.is_default === true) ?? -1;

  const rl = readline.createInterface({ input, output });
  try {
    // eslint-disable-next-line no-console
    console.log("\nChoose an organization (press <return> for the default):");
    orgs.forEach((o, i) => {
      const def = i === defaultIdx ? " (default)" : "";
      // eslint-disable-next-line no-console
      console.log(`${i + 1}) ${o.title} – ${o.role}${def} — ${o.id}`);
    });

    for (let tries = 0; tries < 10; tries++) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await rl.question("\nSelect organization by number: ");

      if (answer.trim() === "") {
        if (defaultIdx >= 0) {
          return orgs[defaultIdx]!;
        }
        // eslint-disable-next-line no-console
        console.log("No default org; please choose a number.");
        continue;
      }

      const idx = Number.parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < orgs.length) {
        // eslint-disable-next-line no-console
        console.log(
          `Selected ${idx + 1}: ${orgs[idx]!.title} – ${orgs[idx]!.id}`,
        );
        return orgs[idx]!;
      }

      // eslint-disable-next-line no-console
      console.log("Invalid selection, try again.");
    }
    throw new Error("Unable to pick org.");
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Minimal single-page UI that is shown in the browser once authentication
// completes. The page is completely self-contained: inline CSS/JS, no external
// dependencies.
//
// It expects two query parameters in the URL:
//   1. access_token – the ephemeral API key that was just created.
//   2. needs_setup  – "true" if the user must finish setting up their OpenAI
//                      organization (e.g. add a payment method). When this flag
//                      is true, the page will display a short message and
//                      automatically redirect to
//                      https://platform.api.openai.org/org-setup after a 3-second
//                      countdown.
//
// Otherwise the page simply confirms that the user is signed in and lets them
// close the tab.
// ---------------------------------------------------------------------------

const LOGIN_SUCCESS_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sign into Codex CLI</title>

    <style>
      .container {
        width: 1280px;
        height: 800px;
        position: relative;
        background: white;
        overflow: hidden;
        border-bottom-right-radius: 10px;
        border-bottom-left-radius: 10px;
      }
      .inner-container {
        width: 400px;
        left: 440px;
        top: 292px;
        position: absolute;
        flex-direction: column;
        justify-content: flex-start;
        align-items: center;
        gap: 28px;
        display: inline-flex;
      }
      .content {
        align-self: stretch;
        flex-direction: column;
        justify-content: flex-start;
        align-items: center;
        gap: 20px;
        display: flex;
      }
      .svg-wrapper {
        position: relative;
      }
      .title {
        text-align: center;
        color: var(--text-primary, #0D0D0D);
        font-size: 28px;
        font-family: OpenAI Sans Variable;
        font-weight: 400;
        line-height: 36.40px;
        word-wrap: break-word;
      }
      .setup-box {
        width: 600px;
        padding: 16px 20px;
        background: var(--bg-primary, white);
        box-shadow: 0px 4px 16px rgba(0, 0, 0, 0.05);
        border-radius: 16px;
        outline: 1px var(--border-default, rgba(13, 13, 13, 0.10)) solid;
        outline-offset: -1px;
        justify-content: flex-start;
        align-items: center;
        gap: 16px;
        display: inline-flex;
      }
      .setup-content {
        flex: 1 1 0;
        justify-content: flex-start;
        align-items: center;
        gap: 24px;
        display: flex;
      }
      .setup-text {
        flex: 1 1 0;
        flex-direction: column;
        justify-content: flex-start;
        align-items: flex-start;
        gap: 4px;
        display: inline-flex;
      }
      .setup-title {
        align-self: stretch;
        color: var(--text-primary, #0D0D0D);
        font-size: 14px;
        font-family: SF Pro;
        font-weight: 510;
        line-height: 20px;
        word-wrap: break-word;
      }
      .setup-description {
        align-self: stretch;
        color: var(--text-secondary, #5D5D5D);
        font-size: 14px;
        font-family: SF Pro;
        font-weight: 400;
        line-height: 20px;
        word-wrap: break-word;
      }
      .redirect-box {
        justify-content: flex-start;
        align-items: center;
        gap: 8px;
        display: flex;
      }
      .redirect-button {
        height: 38px;
        padding: 8px 16px;
        background: var(--interactive-bg-primary-default, #0D0D0D);
        border-radius: 999px;
        justify-content: center;
        align-items: center;
        gap: 4px;
        display: flex;
      }
      .redirect-text {
        color: var(--interactive-label-primary-default, white);
        font-size: 14px;
        font-family: SF Pro;
        font-weight: 510;
        line-height: 20px;
        word-wrap: break-word;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="inner-container">
        <div class="content">
          <div data-svg-wrapper class="svg-wrapper">
            <svg width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4.6665 28.0003C4.6665 15.1137 15.1132 4.66699 27.9998 4.66699C40.8865 4.66699 51.3332 15.1137 51.3332 28.0003C51.3332 40.887 40.8865 51.3337 27.9998 51.3337C15.1132 51.3337 4.6665 40.887 4.6665 28.0003ZM37.5093 18.5088C36.4554 17.7672 34.9999 18.0203 34.2583 19.0742L24.8508 32.4427L20.9764 28.1808C20.1095 27.2272 18.6338 27.1569 17.6803 28.0238C16.7267 28.8906 16.6565 30.3664 17.5233 31.3199L23.3566 37.7366C23.833 38.2606 24.5216 38.5399 25.2284 38.4958C25.9353 38.4517 26.5838 38.089 26.9914 37.5098L38.0747 21.7598C38.8163 20.7059 38.5632 19.2504 37.5093 18.5088Z" fill="var(--green-400, #04B84C)"/>
            </svg>
          </div>
          <div class="title">Signed in to Codex CLI</div>
        </div>
        <div class="setup-box">
          <div class="setup-content">
            <div class="setup-text">
              <div class="setup-title">Finish setting up your API organization</div>
              <div class="setup-description">Add a payment method to use your organization.</div>
            </div>
            <div class="redirect-box">
              <div data-hasendicon="false" data-hasstarticon="false" data-ishovered="false" data-isinactive="false" data-ispressed="false" data-size="large" data-type="primary" class="redirect-button">
                <div class="redirect-text">Redirecting in 3s...</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script>
      (function () {
        const params = new URLSearchParams(window.location.search);
        const needsSetup = params.get('needs_setup') === 'true';

        // Show different message and optional redirect when setup is required
        if (needsSetup) {
          const redirectUrl = 'https://platform.api.openai.org/org-setup';
          const title = document.getElementById('title');
          const message = document.getElementById('message');

          title.textContent = 'Signed in to Codex CLI';

          let countdown = 3;
          function tick() {
            message.textContent =
              'Finish setting up your API organization. Redirecting in ' + countdown + 's…';
            if (countdown === 0) {
              window.location.replace(redirectUrl);
            } else {
              countdown -= 1;
              setTimeout(tick, 1000);
            }
          }
          tick();
        }
      })();
    </script>
  </body>
</html>`;

// Helper: Generate PKCE codes using S256.
function generatePKCECodes(): {
  code_verifier: string;
  code_challenge: string;
} {
  const code_verifier = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(code_verifier).digest();
  const code_challenge = hash
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { code_verifier, code_challenge };
}

async function handleCallback(
  req: Request,
  res: Response,
  oidcConfig: OidcConfiguration,
  code_verifier: string,
  clientId: string,
  redirectUri: string,
  stateChallenge: string,
): Promise<string> {
  if (req.query["state"] !== stateChallenge) {
    res.type("text/plain").status(400).send("State mismatch");
    throw new Error("State mismatch");
  }

  let replied = false; // ensure we don't try to write twice
  try {
    const code = req.query["code"] as string | undefined;
    if (!code) {
      res.type("text/plain").status(400).send("Missing authorization code");
      throw new Error("Missing authorization code");
    }

    /* 1. Exchange the authorization code for tokens */
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier,
    });
    const tokenRes = await fetch(oidcConfig.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams.toString(),
    });
    const tokenData = await tokenRes.json();
    const id_token: string | undefined = tokenData.id_token;
    if (!id_token) {
      res.type("text/plain").status(400).send("No id_token received");
      throw new Error("No id_token received");
    }

    if (process.env["DEBUG"]) {
      // eslint-disable-next-line no-console
      console.log(id_token);
    }

    /* 2. Retrieve org information and exchange tokens */
    const claims: IDTokenClaims = JSON.parse(
      Buffer.from(id_token.split(".")[1]!, "base64url").toString(),
    );

    const orgs = claims["https://api.openai.com/auth"]?.organizations;
    if (!orgs?.length) {
      throw new Error("Missing organizations in id_token claims");
    }
    const org = await selectOrganization(orgs);

    const exchangeParams = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: clientId,
      requested_token: "openai-api-key",
      subject_token: id_token,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    });
    const exchangeRes = await fetch(oidcConfig.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-openai-organization": org.id,
      },
      body: exchangeParams.toString(),
    });
    const exchangeJson = await exchangeRes.json();
    if (process.env["DEBUG"]) {
      // eslint-disable-next-line no-console
      console.log(`Got OpenAI token:\n${exchangeJson}`);
    }
    const apiKey: string | undefined = exchangeJson.access_token;
    if (!apiKey) {
      if ("error" in exchangeJson && "message" in exchangeJson.error) {
        throw new Error(`Token exchange failed: ${exchangeJson.error.message}`);
      }
      throw new Error("Token exchange failed");
    }

    // Determine whether additional org setup is required. The OpenAI token
    // exchange endpoint may include a `needs_setup` boolean field. We treat
    // any truthy value as meaning the user still has to finish the org
    // onboarding flow (e.g. add a payment method).
    const needsSetup: boolean = Boolean(
      // Prefer an explicit field if present; otherwise fall back to any
      // matching query parameter passed along from the IdP.
      (exchangeJson as { needs_setup?: boolean }).needs_setup ??
        req.query["needs_setup"] === "true",
    );

    // Redirect the browser to the local success page, passing along the token
    // and the setup-required flag. The success page itself will display the
    // appropriate message and, if needed, forward the user to the platform
    // org-setup URL after a short delay.
    const successUrl = new URL("/success", redirectUri);
    successUrl.searchParams.set("access_token", apiKey);
    successUrl.searchParams.set("needs_setup", String(needsSetup));

    res.redirect(successUrl.toString());
    replied = true;

    return apiKey;
  } catch (err) {
    if (!replied) {
      res.type("text/plain").status(500).send("Server error");
    }
    throw err;
  }
}

/**
 * getApiKey - Performs OIDC discovery on the provided issuer, generates a login URL,
 * and starts a temporary Express server on a random port to wait for the OAuth callback.
 * When the user completes the flow, the function exchanges tokens and returns an ephemeral API key.
 *
 * @param issuer - The OIDC issuer URL.
 * @param clientId - The OAuth client ID.
 * @param clientSecret - Optional client secret if required.
 * @returns A promise that resolves to the ephemeral API key.
 */
export async function getApiKey(
  issuer: string,
  clientId: string,
): Promise<string> {
  const app = express();

  let codeVerifier: string;
  let codeChallenge: string;
  let redirectUri: string;
  let server: ReturnType<typeof app.listen>;
  const state = crypto.randomBytes(256).toString("hex");

  const apiKeyPromise = new Promise<string>((resolve, reject) => {
    // ---------------------------------------------------------------------
    // Serve the success page at /success. The page itself handles showing a
    // confirmation message and, when required, redirects the user to finish
    // setting up their organization.
    // ---------------------------------------------------------------------

    app.get("/success", (_req: Request, res: Response) => {
      res.type("text/html").send(LOGIN_SUCCESS_HTML);
    });

    // Register the callback route.
    app.get("/auth/callback", async (req: Request, res: Response) => {
      try {
        const oidcConfig = await getOidcConfiguration(issuer);
        const apiKey = await handleCallback(
          req,
          res,
          oidcConfig,
          codeVerifier,
          clientId,
          redirectUri,
          state,
        );
        resolve(apiKey);
      } catch (err) {
        reject(err);
      }
    });

    // Start the Express server on a random available port.
    server = app.listen(1455, "127.0.0.1", async () => {
      const address = server.address();
      if (typeof address === "string" || !address) {
        reject(new Error("Failed to obtain server address"));
        return;
      }
      const port = address.port;
      // Build the redirect URI using the assigned random port.
      redirectUri = `http://localhost:${port}/auth/callback`;

      try {
        const oidcConfig = await getOidcConfiguration(issuer);
        // console.log("oidcConfig", oidcConfig);
        const pkce = generatePKCECodes();
        codeVerifier = pkce.code_verifier;
        codeChallenge = pkce.code_challenge;

        // Build the authorization URL.
        // oidcConfig.authorization_endpoint = "http://localhost:3000/oauth/authorize"; // TODO(raju) remove this
        const authUrl = new URL(oidcConfig.authorization_endpoint);
        // console.log("authUrl", authUrl);
        authUrl.searchParams.append("response_type", "code");
        authUrl.searchParams.append("client_id", clientId);
        authUrl.searchParams.append("redirect_uri", redirectUri);
        authUrl.searchParams.append("scope", "openid profile email");
        authUrl.searchParams.append("code_challenge", codeChallenge);
        authUrl.searchParams.append("code_challenge_method", "S256");
        authUrl.searchParams.append("id_token_add_organizations", "true");
        authUrl.searchParams.append("state", state);

        // eslint-disable-next-line no-console
        console.log(
          `Welcome to ${chalk.bold(
            "codex",
          )}! It looks like you're missing: ${chalk.red("`OPENAI_API_KEY`")}`,
        );
        // eslint-disable-next-line no-console
        console.log(
          "1) Create an API key (https://platform.openai.com) and export as an environment variable",
        );
        // eslint-disable-next-line no-console
        console.log(
          "2) Or in three seconds, we will open the login page for you...",
        );
        setTimeout(() => {
          open(authUrl.toString());
          // eslint-disable-next-line no-console
          console.log("\nOpening login page: " + authUrl.toString());
        }, 3 * 1000);
      } catch (err) {
        reject(err);
      }
    });
  });

  // Attach a finally handler after the promise is defined, so the server is closed when done.
  return apiKeyPromise.finally(() => {
    if (server) {
      server.close();
    }
  });
}
