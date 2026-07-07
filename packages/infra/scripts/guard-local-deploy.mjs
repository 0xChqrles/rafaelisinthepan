// Break-glass guard for LOCAL application deploys.
//
// Application deploys go through CI (PR -> ci.yml checks -> merge to main -> deploy.yml).
// This blocks an ACCIDENTAL `pnpm infra:deploy` / `:app` of your local working tree to
// production — the failure mode branch protection can't catch, because it deploys
// whatever is checked out, unreviewed.
//
// It does NOT take away your AWS access: `cdk synth` / `diff` / `destroy` / `deploy:auth`
// (the by-hand WhippinDeployStack bootstrap) are untouched, and CI is never affected
// (deploy.yml runs `cdk deploy` directly, bypassing this npm script, and GitHub Actions
// sets CI=1 anyway). For a deliberate break-glass deploy, opt in explicitly:
//
//   ALLOW_LOCAL_DEPLOY=1 pnpm infra:deploy

if (process.env.CI || process.env.ALLOW_LOCAL_DEPLOY) process.exit(0);

process.stderr.write(
  '\n✋ Local application deploy blocked.\n\n' +
    'Deploys go through CI: open a PR, let checks pass, merge to main, and deploy.yml\n' +
    'ships it. This guard stops an accidental deploy of your local working tree to prod.\n\n' +
    'For a deliberate break-glass deploy, re-run with:\n' +
    '  ALLOW_LOCAL_DEPLOY=1 pnpm infra:deploy\n\n',
);
process.exit(1);
