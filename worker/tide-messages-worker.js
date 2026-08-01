// Cloudflare Worker — backend for the "Messages to the Tide" form.
// Holds a GitHub token as a secret and commits each new message into
// data/messages.json in the site's repo. Deploy via the Cloudflare
// dashboard or `wrangler deploy`; see worker/README.md for setup.
//
// Required env vars (set as secrets/vars in the Worker, never in this file):
//   GITHUB_TOKEN    - fine-grained PAT scoped to this repo, Contents: Read+Write
//   GITHUB_OWNER    - e.g. "daonhathaibannha"
//   GITHUB_REPO     - e.g. "RunwayWebsite"
//   GITHUB_BRANCH   - e.g. "main"
//   ALLOWED_ORIGIN  - e.g. "https://daonhathaibannha.github.io"
// Optional:
//   GITHUB_FILE_PATH - defaults to "data/messages.json"

const MAX_NAME_LEN = 60;
const MAX_MESSAGE_LEN = 500;
const MAX_STORED = 200;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(str) {
  return decodeURIComponent(escape(atob(str)));
}

async function githubRequest(env, method, body) {
  const path = env.GITHUB_FILE_PATH || "data/messages.json";
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  return fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "tide-messages-worker",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
    }

    const name = String(body.name || "").trim().slice(0, MAX_NAME_LEN);
    const message = String(body.message || "").trim().slice(0, MAX_MESSAGE_LEN);
    if (!name || !message) {
      return new Response(JSON.stringify({ error: "Name and message are required" }), { status: 400, headers });
    }

    const entry = { name, message, date: new Date().toISOString() };

    // Retry once on a 409 (someone else committed between our GET and PUT).
    for (let attempt = 0; attempt < 2; attempt++) {
      const getRes = await githubRequest(env, "GET");
      if (!getRes.ok) {
        return new Response(JSON.stringify({ error: "Failed to read message store" }), { status: 502, headers });
      }
      const file = await getRes.json();
      let list;
      try {
        list = JSON.parse(b64DecodeUtf8(file.content));
      } catch {
        list = [];
      }

      list.unshift(entry);
      const trimmed = list.slice(0, MAX_STORED);

      const putRes = await githubRequest(env, "PUT", {
        message: `Add message from ${name}`,
        content: b64EncodeUtf8(JSON.stringify(trimmed, null, 2)),
        sha: file.sha,
        branch: env.GITHUB_BRANCH || "main",
      });

      if (putRes.ok) {
        return new Response(JSON.stringify({ ok: true, entry }), {
          status: 200,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      if (putRes.status !== 409) {
        return new Response(JSON.stringify({ error: "Failed to save message" }), { status: 502, headers });
      }
      // 409: loop and retry with a fresh sha.
    }

    return new Response(JSON.stringify({ error: "Message store is busy, please try again" }), { status: 409, headers });
  },
};
