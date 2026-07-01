# CI/CD (GitHub Actions)

Two workflows drive the pipeline (issue #33):

- **`ci.yml`** — test gate. On every PR into `main` and on pushes to `main`: sets up
  pnpm (`11.9.0` from the root `packageManager` field) + Node 22 + `uv`/Python 3.12,
  then runs `pnpm -r --if-present run typecheck` and `pnpm test` (Vitest for
  `shared`/`web`/`backend` + pytest for `generation`).
- **`deploy.yml`** — CD. On push to `main` and on manual `workflow_dispatch`: figures
  out which CDK stack(s) changed and deploys only those, authenticating to AWS via
  **GitHub OIDC** (no long-lived keys).

Both CDK stacks are pinned to **us-east-1**.

## Selective deploy

`deploy.yml` uses [`dorny/paths-filter`](https://github.com/dorny/paths-filter) to map
changed paths to stacks:

| Changed path | Backend | Web |
|---|---|---|
| `packages/backend/**` | ✅ | — |
| `packages/web/**` | — | ✅ |
| `packages/shared/**` | ✅ | ✅ (bundled into the Lambda **and** the SPA) |
| `packages/infra/**` | ✅ | ✅ (both stack defs) |
| `pnpm-lock.yaml`, `package.json`, `pnpm-workspace.yaml` | ✅ | ✅ (safe default) |
| `.github/workflows/deploy.yml` | ✅ | ✅ |
| `packages/generation/**` | — | — (not deployed; tested in CI only) |

`workflow_dispatch` takes a `stacks` input — `changed` (default) | `web` | `backend` |
`all` — to force a selection. `changed` on a manual run diffs the tip commit (`HEAD~1`).

## Required repo configuration

The workflows reference the following — set these once, in the GitHub repo settings.

### 1. AWS OIDC deploy role — secret `AWS_DEPLOY_ROLE_ARN`

`deploy.yml` assumes an IAM role via OIDC (`aws-actions/configure-aws-credentials`).
Create the role once and store its ARN as the repo **secret** `AWS_DEPLOY_ROLE_ARN`
(Settings → Secrets and variables → Actions → Secrets).

Prerequisites (one-time, outside this repo):

- The account is `cdk bootstrap`-ed (modern `cdk-hnb659fds-*` roles exist) in
  **us-east-1**.
- A GitHub OIDC identity provider exists in the account
  (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`).
- An IAM role whose **trust policy** is scoped to this repo, e.g.:

  ```jsonc
  {
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:0xChqrles/rafaelisinthepan:ref:refs/heads/main" }
    }
  }
  ```

- The role's **permissions** must let CDK deploy — at minimum assume the CDK bootstrap
  roles (`sts:AssumeRole` on `arn:aws:iam::<ACCOUNT_ID>:role/cdk-hnb659fds-*`) plus
  `cloudformation:DescribeStacks`. (CDK then uses the bootstrap deploy/file-publishing
  roles for the actual changes.)

### 2. Web build base URL — variable `VITE_API_BASE_URL`

The web deploy builds the SPA with `VITE_API_BASE_URL` **before** `cdk deploy` (WebStack
uploads `dist/`). Set the repo **variable** `VITE_API_BASE_URL` (Settings → Secrets and
variables → Actions → Variables) to the backend origin, e.g. `https://api.whippin.ai`.
There is **no fallback** — if the variable is unset the web deploy fails fast rather than
shipping a build pointed at the wrong origin.

### 3. Branch protection — required status check (manual, admin)

To block merging PRs whose tests fail, make CI a required check on `main`. This is a repo
admin setting; apply it after `ci.yml` has run at least once so the check name is
selectable:

- Settings → Branches → add a rule for `main` → **Require status checks to pass before
  merging** → select **`Typecheck + test`**.

Or via the CLI:

```bash
gh api -X PUT repos/0xChqrles/rafaelisinthepan/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[checks][][context]=Typecheck + test' \
  -f 'enforce_admins=true' \
  -f 'required_pull_request_reviews[required_approving_review_count]=0' \
  -F 'restrictions=' 
```
