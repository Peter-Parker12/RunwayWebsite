# Messages-to-the-Tide backend

Deploys as a Cloudflare Worker (free tier, no credit card). It takes new
message submissions from `messages.html` and commits them into
`data/messages.json` in this repo using a GitHub token. Reading messages
back on the page happens directly from the raw GitHub file — no worker
needed for that part.

## 1. Create a GitHub token (write access, this repo only)

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token.
2. Repository access: **Only select repositories** → `RunwayWebsite`.
3. Permissions: **Contents → Read and write**. Leave everything else as "No access".
4. Generate, copy the token (starts with `github_pat_...`) — you won't see it again.

## 2. Deploy the Worker

1. Sign up at https://dash.cloudflare.com (free, no card required).
2. Workers & Pages → Create → **Create Worker**. Give it a name, e.g. `tide-messages`.
3. Open the editor, delete the placeholder code, paste in `worker/tide-messages-worker.js`.
4. Deploy. Note the URL it gives you, e.g. `https://tide-messages.<your-subdomain>.workers.dev`.

## 3. Set environment variables

In the Worker's **Settings → Variables**:

| Name | Value | Type |
|---|---|---|
| `GITHUB_TOKEN` | the token from step 1 | **Secret** (encrypted) |
| `GITHUB_OWNER` | `daonhathaibannha` | Plain text |
| `GITHUB_REPO` | `RunwayWebsite` | Plain text |
| `GITHUB_BRANCH` | `main` | Plain text |
| `ALLOWED_ORIGIN` | your site's URL, e.g. `https://daonhathaibannha.github.io` | Plain text |

Redeploy after saving.

## 4. Point the site at your Worker

In [`js/main.js`](../js/main.js), replace the placeholder:

```js
const MESSAGES_API = 'https://REPLACE-WITH-YOUR-WORKER.workers.dev';
```

with your actual Worker URL from step 2. Commit and push.

## Notes

- Reads are unauthenticated `fetch()` calls to
  `https://raw.githubusercontent.com/daonhathaibannha/RunwayWebsite/main/data/messages.json`
  — public and free, no rate-limit concerns at this scale.
- Each submission creates a small commit to `data/messages.json` in this repo — that's the "database".
- `ALLOWED_ORIGIN` restricts who can call the Worker (CORS) — set it to wherever the site is actually hosted (GitHub Pages, a custom domain, etc).
