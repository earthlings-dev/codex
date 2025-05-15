import type { Choice } from "./get-api-key-components";
import type { Request, Response } from "express";

import { ApiKeyPrompt, WaitingForAuth } from "./get-api-key-components";
import express from "express";
import { render } from "ink";
import crypto from "node:crypto";
import { URL } from "node:url";
import open from "open";
import React from "react";

function promptUserForChoice(): Promise<Choice> {
  return new Promise<Choice>((resolve) => {
    const instance = render(
      <ApiKeyPrompt
        onDone={(choice: Choice) => {
          resolve(choice);
          instance.unmount();
        }}
      />,
    );
  });
}

interface OidcConfiguration {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

async function getOidcConfiguration(
  issuer: string,
): Promise<OidcConfiguration> {
  const discoveryUrl = new URL(issuer);
  discoveryUrl.pathname = "/.well-known/openid-configuration";

  if (issuer === "https://auth.openai.com") {
    // Account for legacy quirk in production tenant
    discoveryUrl.pathname = "/v2.0" + discoveryUrl.pathname;
  }

  const res = await fetch(discoveryUrl.toString());
  if (!res.ok) {
    throw new Error("Failed to fetch OIDC configuration");
  }
  return (await res.json()) as OidcConfiguration;
}

interface IDTokenClaims {
  "https://api.openai.com/auth": {
    organization_id: string;
    project_id: string;
    completed_platform_onboarding: boolean;
    is_org_owner: boolean;
  };
}

interface AccessTokenClaims {
  "https://api.openai.com/auth": {
    chatgpt_plan_type: string;
  };
}

function generatePKCECodes(): {
  code_verifier: string;
  code_challenge: string;
} {
  const code_verifier = crypto.randomBytes(64).toString("hex");
  const code_challenge = crypto
    .createHash("sha256")
    .update(code_verifier)
    .digest("base64url");
  return { code_verifier, code_challenge };
}

async function handleCallback(
  req: Request,
  res: Response,
  issuer: string,
  oidcConfig: OidcConfiguration,
  codeVerifier: string,
  clientId: string,
  redirectUri: string,
  expectedState: string,
): Promise<string> {
  const state = (req.query as Record<string, string>)["state"] as
    | string
    | undefined;
  if (!state || state !== expectedState) {
    throw new Error("Invalid state parameter");
  }

  const code = (req.query as Record<string, string>)["code"] as
    | string
    | undefined;
  if (!code) {
    throw new Error("Missing authorization code");
  }

  const params = new URLSearchParams();
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", redirectUri);
  params.append("client_id", clientId);
  params.append("code_verifier", codeVerifier);

  oidcConfig.token_endpoint = `${issuer}/oauth/token`;
  const tokenRes = await fetch(oidcConfig.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!tokenRes.ok) {
    throw new Error("Failed to exchange authorization code for tokens");
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
  };

  const idTokenParts = tokenData.id_token.split(".");
  if (idTokenParts.length !== 3) {
    throw new Error("Invalid ID token");
  }
  const accessTokenParts = tokenData.access_token.split(".");
  if (accessTokenParts.length !== 3) {
    throw new Error("Invalid access token");
  }

  const idTokenClaims = JSON.parse(
    Buffer.from(idTokenParts[1]!, "base64url").toString("utf8"),
  ) as IDTokenClaims;

  const accessTokenClaims = JSON.parse(
    Buffer.from(accessTokenParts[1]!, "base64url").toString("utf8"),
  ) as AccessTokenClaims;

  const org_id = idTokenClaims["https://api.openai.com/auth"]?.organization_id;

  if (!org_id) {
    throw new Error("Missing organization in id_token claims");
  }
  const project_id = idTokenClaims["https://api.openai.com/auth"]?.project_id;

  if (!project_id) {
    throw new Error("Missing project in id_token claims");
  }

  const exchangeParams = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: clientId,
    requested_token: "openai-api-key",
    subject_token: tokenData.id_token,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    name: `Codex CLI (auto-generated) (${new Date().toISOString().slice(0, 10)})`,
  });
  const exchangeRes = await fetch(oidcConfig.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: exchangeParams.toString(),
  });
  if (!exchangeRes.ok) {
    throw new Error("Failed to create API key");
  }

  const { key } = (await exchangeRes.json()) as { key: string };

  // Determine whether the organization still requires additional
  // setup (e.g., adding a payment method) based on the ID-token
  // claim provided by the auth service.
  const completedOnboarding = Boolean(
    idTokenClaims["https://api.openai.com/auth"]?.completed_platform_onboarding,
  );
  const chatgptPlanType =
    accessTokenClaims["https://api.openai.com/auth"]?.chatgpt_plan_type;
  let needsSetup = false;
  if (chatgptPlanType === "plus" || chatgptPlanType === "pro") {
    needsSetup = !completedOnboarding;
  }

  // Build the success URL on the same host/port as the callback and
  // include the required query parameters for the front-end page.
  // console.log("Redirecting to success page");
  const successUrl = new URL("/success", redirectUri);
  if (issuer === "https://auth.openai.com") {
    successUrl.searchParams.set("platform_url", "https://platform.openai.com");
  } else {
    successUrl.searchParams.set(
      "platform_url",
      "https://platform.api.openai.org",
    );
  }
  successUrl.searchParams.set("access_token", tokenData.access_token);
  successUrl.searchParams.set("needs_setup", needsSetup ? "true" : "false");
  // TODO figure out what platform needs and pass all the important state in
  // ?with_org=org-abc&project_id=proj_xyz&p=pro
  successUrl.searchParams.set("org_id", org_id);
  successUrl.searchParams.set("project_id", project_id);
  successUrl.searchParams.set("plan_type", chatgptPlanType);
  res.redirect(successUrl.toString());

  return key;
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

const LOGIN_SUCCESS_HTML = String.raw`
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sign into Codex CLI</title>

    <style>
      .container {
        margin: 0 auto;
        width: 1280px;
        height: 100vh;
        position: relative;
        background: white;
        overflow: hidden;
        border-bottom-right-radius: 10px;
        border-bottom-left-radius: 10px;
        font-family: 'SF Pro';
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
      .close-button,
      .redirect-button {
        height: 28px;
        padding: 8px 16px;
        background: var(--interactive-bg-primary-default, #0D0D0D);
        border-radius: 999px;
        justify-content: center;
        align-items: center;
        gap: 4px;
        display: flex;
      }
      .close-button,
      .redirect-text {
        color: var(--interactive-label-primary-default, white);
        font-size: 14px;
        font-family: SF Pro;
        font-weight: 510;
        line-height: 20px;
        word-wrap: break-word;
        text-decoration: none;
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
        <div class="close-box" style="display: none;">
          <a href="javascript:window.close()" data-hasendicon="false" data-hasstarticon="false" data-ishovered="false" data-isinactive="false" data-ispressed="false" data-size="large" data-type="primary" class="close-button">
            <div class="close-text">Close this tab</div>
          </a>
        </div>
        <div class="setup-box" style="display: none;">
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
        const platformUrl = params.get('platform_url');
        const orgId = params.get('org_id');
        const projectId = params.get('project_id');
        const planType = params.get('plan_type');
        const accessToken = params.get('access_token');

        
        // Show different message and optional redirect when setup is required
        if (needsSetup) {
          const setupBox = document.querySelector('.setup-box');
          setupBox.style.display = 'flex';
          const redirectUrlObj = new URL('/org-setup', platformUrl);
          redirectUrlObj.searchParams.set('p', planType);
          redirectUrlObj.searchParams.set('with_org', orgId);
          redirectUrlObj.searchParams.set('project_id', projectId);
          redirectUrlObj.searchParams.set('access_token', accessToken);
          const redirectUrl = redirectUrlObj.toString();
          const message = document.querySelector('.redirect-text');

          let countdown = 3;
          function tick() {
            message.textContent =
              'Redirecting in ' + countdown + 's…';
            if (countdown === 0) {
              window.location.replace(redirectUrl);
            } else {
              countdown -= 1;
              setTimeout(tick, 1000);
            }
          }
          tick();
        } else {
          const closeBox = document.querySelector('.close-box');
          closeBox.style.display = 'flex';
        }
      })();
    </script>
  </body>
</html>`;

async function signInFlow(issuer: string, clientId: string): Promise<string> {
  const app = express();

  let codeVerifier = "";
  let redirectUri = "";
  let server: ReturnType<typeof app.listen>;
  const state = crypto.randomBytes(32).toString("hex");

  const apiKeyPromise = new Promise<string>((resolve, reject) => {
    app.get("/success", (_req: Request, res: Response) => {
      res.type("text/html").send(LOGIN_SUCCESS_HTML);
    });

    // Callback route -------------------------------------------------------
    app.get("/auth/callback", async (req: Request, res: Response) => {
      try {
        const oidcConfig = await getOidcConfiguration(issuer);
        oidcConfig.token_endpoint = `${issuer}/oauth/token`;
        oidcConfig.authorization_endpoint = `${issuer}/oauth/authorize`;
        const apiKey = await handleCallback(
          req,
          res,
          issuer,
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

    server = app.listen(1455, "127.0.0.1", async () => {
      const address = server.address();
      if (typeof address === "string" || !address) {
        reject(new Error("Failed to obtain server address"));
        return;
      }
      const port = address.port;
      redirectUri = `http://localhost:${port}/auth/callback`;

      try {
        const oidcConfig = await getOidcConfiguration(issuer);
        oidcConfig.token_endpoint = `${issuer}/oauth/token`;
        oidcConfig.authorization_endpoint = `${issuer}/oauth/authorize`;
        const pkce = generatePKCECodes();
        codeVerifier = pkce.code_verifier;

        const authUrl = new URL(oidcConfig.authorization_endpoint);
        authUrl.searchParams.append("response_type", "code");
        authUrl.searchParams.append("client_id", clientId);
        authUrl.searchParams.append("redirect_uri", redirectUri);
        authUrl.searchParams.append("scope", "openid profile email");
        authUrl.searchParams.append("code_challenge", pkce.code_challenge);
        authUrl.searchParams.append("code_challenge_method", "S256");
        authUrl.searchParams.append("id_token_add_organizations", "true");
        authUrl.searchParams.append("state", state);

        // Open the browser immediately.
        open(authUrl.toString());

        setTimeout(() => {
          // eslint-disable-next-line no-console
          console.log(
            `\nOpening login page in your browser: ${authUrl.toString()}\n`,
          );
        }, 500);
      } catch (err) {
        reject(err);
      }
    });
  });

  // Ensure the server is closed afterwards.
  return apiKeyPromise.finally(() => {
    if (server) {
      server.close();
    }
  });
}

export async function getApiKey(
  issuer: string,
  clientId: string,
): Promise<string> {
  // // 1. If the user already provided an API key we can exit early.
  // if (process.env["OPENAI_API_KEY"]) {
  //   return process.env["OPENAI_API_KEY"]!;
  // }

  // 2. Let the user pick between the two options described above.
  const choice = await promptUserForChoice();

  if (choice.type === "apikey") {
    // Persist choice for subsequent code that relies on the env-var.
    process.env["OPENAI_API_KEY"] = choice.key;
    return choice.key;
  }

  // 3. Sign-in flow with spinner.
  const spinner = render(<WaitingForAuth />);
  try {
    const key = await signInFlow(issuer, clientId);
    spinner.unmount();
    process.env["OPENAI_API_KEY"] = key;
    return key;
  } catch (err) {
    spinner.unmount();
    throw err;
  }
}
