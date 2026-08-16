# CI/CD (GitHub Actions)

Two workflows drive the pipeline (issue #33):

- **`ci.yml`** — test gate. On every PR into `main` and on pushes to `main`: sets up
  pnpm (`11.9.0` from the root `packageManager` field) + Node 22 + `uv`/Python 3.12,
  then runs `pnpm -r --if-present run typecheck` and `pnpm test` (Vitest for
  `shared`/`web`/`backend` + pytest for `generation`/`benchmark`).
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
| `packages/benchmark/**` | — | — (not deployed; tested in CI only) |

`workflow_dispatch` takes a `stacks` input — `changed` (default) | `web` | `backend` |
`all` — to force a selection. `changed` on a manual run diffs the tip commit (`HEAD~1`).

## Required repo configuration

The workflows reference the following — set these once, in the GitHub repo settings.

### 1. AWS OIDC deploy role — secret `AWS_DEPLOY_ROLE_ARN`

`deploy.yml` assumes an IAM role via OIDC (`aws-actions/configure-aws-credentials`) —
no long-lived keys. **The role is defined as code**, not clicked together in the console:
`WhippinDeployStack` (`packages/infra/lib/deploy-role-stack.ts`) provisions the GitHub
OIDC provider and the role. Deploy it **once** with your own AWS credentials, then copy the
`DeployRoleArn` output into the repo **secret** `AWS_DEPLOY_ROLE_ARN` (Settings → Secrets
and variables → Actions → Secrets):

```bash
# one-time; needs the account cdk-bootstrapped in us-east-1 (npx cdk bootstrap)
pnpm --filter @whippin/infra deploy:auth
# → prints DeployRoleArn=arn:aws:iam::<ACCOUNT_ID>:role/whippin-github-deploy
```

See [`packages/infra/README.md`](../../packages/infra/README.md#whippindeploystack--ci-auth-bootstrap)
for the full picture (branch/preview knobs, importing an existing OIDC provider, and why
this stack is human-deployed rather than run by CI). In short, the stack creates:

- A GitHub OIDC provider (`token.actions.githubusercontent.com`, audience
  `sts.amazonaws.com`) — account-global, so the stack **imports** the account's existing
  one by default; pass `-c createOidcProvider=true` only on an account that has none yet.
- A role trusted only by this repo, scoped to `main` pushes
  (`repo:0xChqrles/rafaelisinthepan:ref:refs/heads/main`), whose permissions are just
  `sts:AssumeRole` on the `cdk-hnb659fds-*` bootstrap roles + `cloudformation:DescribeStacks`
  (CDK does the real work through the assumed bootstrap roles).

> **Chicken-and-egg:** `WhippinDeployStack` is deployed by a human, never by `deploy.yml` —
> the CI role deliberately can't create or edit IAM, so it can't provision its own
> privileges. That's also why `deploy.yml` only targets the backend/web stacks.

### 2. Web build config

`VITE_API_BASE_URL` needs no repo variable: it is committed in
`packages/web/.env.production`, the single source of truth for the value baked into the
shipped bundle. Web deploys read two repo **variables**:

- `VITE_TURNSTILE_SITE_KEY` is **required** (#170): the public site key for the production
  invisible Turnstile widget paired with the backend's `/whippin/turnstile-secret`.
  `vite.config.ts` refuses every production build when it is unset, so production cannot
  silently ship score collection disabled. Configure it with
  `gh variable set VITE_TURNSTILE_SITE_KEY --body '<site-key>'`.
  **The widget must be created with type INVISIBLE**, not Cloudflare's default "Managed":
  the client renders it into a hidden container, so a Managed key that escalates to an
  interactive challenge can never be completed — it times out and silently drops the score.
  Nothing in code or CI can detect the widget type, so it is checked when the key is issued.
- `VITE_PLAUSIBLE_DOMAIN` is optional (#60): unset means analytics stay inert.

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
