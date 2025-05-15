import type { Choice } from "./get-api-key-components";
import type { Request, Response } from "express";

import { ApiKeyPrompt, WaitingForAuth } from "./get-api-key-components";
import express from "express";
import { render } from "ink";
import crypto from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
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

interface Org {
  id: string;
  title: string;
  role: string;
  is_default: boolean;
}

interface IDTokenClaims {
  "https://api.openai.com/auth": {
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

  const payload = JSON.parse(
    Buffer.from(idTokenParts[1]!, "base64url").toString("utf8"),
  ) as IDTokenClaims;

  let organization: Org | undefined;
  const orgs = payload["https://api.openai.com/auth"].organizations ?? [];
  if (orgs.length > 0) {
    organization = await selectOrganization(orgs);
  }

  const createKeyRes = await fetch("https://api.openai.com/v1/oauth/key", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      organization_id: organization?.id,
    }),
  });

  if (!createKeyRes.ok) {
    throw new Error("Failed to create API key");
  }

  const { key } = (await createKeyRes.json()) as { key: string };

  res.redirect("/success");

  return key;
}

const LOGIN_SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sign into Codex CLI</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; padding-top: 80px; }
    </style>
  </head>
  <body>
    <h2>Authentication successful!</h2>
    <p>You can close this tab and return to your terminal.</p>
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

    server = app.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      if (typeof address === "string" || !address) {
        reject(new Error("Failed to obtain server address"));
        return;
      }
      const port = address.port;
      redirectUri = `http://localhost:${port}/auth/callback`;

      try {
        const oidcConfig = await getOidcConfiguration(issuer);
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
  // 1. If the user already provided an API key we can exit early.
  if (process.env["OPENAI_API_KEY"]) {
    return process.env["OPENAI_API_KEY"]!;
  }

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
