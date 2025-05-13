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
  issuer: string
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
          `Selected ${idx + 1}: ${orgs[idx]!.title} – ${orgs[idx]!.id}`
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
  stateChallenge: string
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

    /* 2. Let the user close the page ASAP */
    res
      .type("text/plain")
      .send(
        "Login complete – you can close this window and return to the terminal."
      );
    replied = true;

    /* 3. Continue locally: pick org and exchange for API key */
    const claims: IDTokenClaims = JSON.parse(
      Buffer.from(id_token.split(".")[1]!, "base64url").toString()
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
  clientId: string
): Promise<string> {
  const app = express();

  let codeVerifier: string;
  let codeChallenge: string;
  let redirectUri: string;
  let server: ReturnType<typeof app.listen>;
  const state = crypto.randomBytes(256).toString("hex");

  const apiKeyPromise = new Promise<string>((resolve, reject) => {
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
          state
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
        console.log("oidcConfig", oidcConfig)
        const pkce = generatePKCECodes();
        codeVerifier = pkce.code_verifier;
        codeChallenge = pkce.code_challenge;

        // Build the authorization URL.
        // oidcConfig.authorization_endpoint = "http://localhost:3000/oauth/authorize"; // TODO(raju) remove this
        const authUrl = new URL(oidcConfig.authorization_endpoint);
        console.log("authUrl", authUrl);
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
            "codex"
          )}! It looks like you're missing: ${chalk.red("`OPENAI_API_KEY`")}`
        );
        // eslint-disable-next-line no-console
        console.log(
          "1) Create an API key (https://platform.openai.com) and export as an environment variable"
        );
        // eslint-disable-next-line no-console
        console.log(
          "2) Or in three seconds, we will open the login page for you..."
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