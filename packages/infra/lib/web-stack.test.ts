import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { App, Aspects } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { GROUP_SEGMENT, groupLandingPath, SHARE_SEGMENT } from '@whippin/shared';
import { WebStack, builtRoutePages } from './web-stack';

const ACCOUNT = '111122223333';
const REGION = 'us-east-1';
const DOMAIN = 'test.invalid';
// NOT the stack's own `https://api.<domain>` default, so what is pinned below is the
// origin the stack was HANDED (`bin/app.ts` passes the backend's).
const API_HOST = `backend.${DOMAIN}`;
const API_ORIGIN = `https://${API_HOST}`;

// A build of its own, rather than whatever `packages/web/dist` a local build left behind (CI
// has none): the shell, a chunk, the vocabulary, and two routes with a page of their own.
function fakeBuild(files: readonly string[]): string {
  const dist = mkdtempSync(path.join(tmpdir(), 'web-dist-'));
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    writeFileSync(path.join(dist, rel), '');
  }
  return dist;
}
const WEB_DIST = fakeBuild(['index.html', 'assets/index-x.js', 'vocab/en.json', 'fr/learn/index.html', 'fr/learn/2/index.html']);

// `fromLookup` resolves to a dummy zone with no credentials, which is enough: what is
// pinned below is shape, not zone contents.
function webStack(app: App): WebStack {
  return new WebStack(app, 'TestWebStack', {
    env: { account: ACCOUNT, region: REGION },
    domainName: DOMAIN,
    apiOrigin: API_ORIGIN,
    webDist: WEB_DIST,
  });
}

const template = Template.fromStack(webStack(new App()));

const [distribution] = Object.values(template.findResources('AWS::CloudFront::Distribution'));
const config = distribution.Properties.DistributionConfig;

// The CSP the SPA is served under — the DEFAULT behavior's headers policy, split into
// its directives (name -> sources).
function siteCsp(): Record<string, string[]> {
  const { Ref } = config.DefaultCacheBehavior.ResponseHeadersPolicyId as { Ref: string };
  const policy = template.findResources('AWS::CloudFront::ResponseHeadersPolicy')[Ref];
  const csp = policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig
    .ContentSecurityPolicy.ContentSecurityPolicy as string;
  return Object.fromEntries(
    csp.split('; ').map((directive) => {
      const [name, ...sources] = directive.split(' ');
      return [name, sources];
    }),
  );
}

// The DEFAULT behavior's viewer-request function, run on a request as CloudFront runs it
// (its source is a plain `function handler(event)`), answering the URI it sends on.
function spaRewrite(): (uri: string) => string {
  const associations = (config.DefaultCacheBehavior.FunctionAssociations ?? []) as {
    FunctionARN: { 'Fn::GetAtt': [string, string] };
  }[];
  expect(associations).toHaveLength(1);
  const [logicalId] = associations[0].FunctionARN['Fn::GetAtt'];
  const code = template.findResources('AWS::CloudFront::Function')[logicalId].Properties
    .FunctionCode as string;
  const handler = new Function(`${code}\nreturn handler;`)() as (event: unknown) => { uri: string };
  return (uri) => handler({ request: { method: 'GET', uri, querystring: {}, headers: {} } }).uri;
}

describe('web hosting stack (#21)', () => {
  // CONTRACT (root AGENTS.md, shared/src/invite.ts): the share page, the cards and the
  // group invite preview are served by the BACKEND under the apex. Infra routes the paths,
  // the backend answers them, the web builds the links — and the dev proxy restates the
  // list, so a pattern missing here shows on the real CDN alone, as a shared link that
  // unfurls as the app's stock card.
  it('hands exactly the share, card and invite paths to the API origin', () => {
    const behaviors = config.CacheBehaviors as Record<string, unknown>[];
    expect(behaviors.map(({ PathPattern }) => PathPattern).sort()).toEqual(
      [`/${SHARE_SEGMENT}/*`, '/og/*', `/${GROUP_SEGMENT}/*`].sort(),
    );

    const origins = config.Origins as { Id: string; DomainName: unknown }[];
    const api = origins.find(({ DomainName }) => DomainName === API_HOST);
    expect(api).toBeDefined();
    for (const behavior of behaviors) {
      expect(behavior.TargetOriginId, String(behavior.PathPattern)).toBe(api!.Id);
    }
  });

  // The API's distribution sees only this one's edge servers for these paths, so THIS is
  // where one viewer rendering card after card is stopped: a path handed to the API and
  // left out of the limit is unauthenticated compute nobody bounds by address.
  it('limits exactly the paths it hands to the API, by the viewer\'s own address', () => {
    const acl = template.findResources('AWS::WAFv2::WebACL')[config.WebACLId['Fn::GetAtt'][0]];
    expect(acl.Properties).toMatchObject({ Scope: 'CLOUDFRONT', DefaultAction: { Allow: {} } });
    const rules = acl.Properties.Rules as Record<string, any>[];
    expect(rules).toHaveLength(1);
    const { RateBasedStatement } = rules[0].Statement;
    expect(rules[0].Action).toEqual({ Block: { CustomResponse: { ResponseCode: 429 } } });
    expect(RateBasedStatement).toMatchObject({ AggregateKeyType: 'IP', EvaluationWindowSec: 300 });
    const limited = (RateBasedStatement.ScopeDownStatement.OrStatement.Statements as Record<string, any>[])
      .map(({ ByteMatchStatement }) => `${ByteMatchStatement.SearchString}*`);
    const behaviors = config.CacheBehaviors as { PathPattern: string }[];
    expect(limited.sort()).toEqual(behaviors.map(({ PathPattern }) => PathPattern).sort());
  });

  // The backend's preview and dead-link pages are a redirect stub that paints the app's
  // ground inline (backend `ogCard.ts`): a policy refusing either inline piece is a white
  // page before the redirect, or no redirect at all — seen on the real CDN alone.
  it('lets the share and invite pages run their redirect and paint their ground', () => {
    const behaviors = config.CacheBehaviors as { PathPattern: string; ResponseHeadersPolicyId: { Ref: string } }[];
    const policies = template.findResources('AWS::CloudFront::ResponseHeadersPolicy');
    for (const behavior of behaviors) {
      const csp = policies[behavior.ResponseHeadersPolicyId.Ref].Properties.ResponseHeadersPolicyConfig
        .SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy as string;
      const directives = Object.fromEntries(
        csp.split('; ').map((directive) => {
          const [name, ...sources] = directive.split(' ');
          return [name, sources];
        }),
      );
      expect(directives['default-src'], behavior.PathPattern).toEqual(["'none'"]);
      expect(directives['script-src'], behavior.PathPattern).toEqual(["'unsafe-inline'"]);
      expect(directives['style-src'], behavior.PathPattern).toEqual(["'unsafe-inline'"]);
    }
  });

  // The SPA fallback is a viewer-request function on the DEFAULT behavior, never a
  // distribution-wide error response: those rewrite every behavior's 403/404, so a dead
  // invite, share or card from the API origin would answer 200 with the SPA shell.
  it('falls back to the SPA on the bucket behavior alone, so the API origin\'s 404s reach the viewer', () => {
    expect(config.CustomErrorResponses).toBeUndefined();

    const associations = config.DefaultCacheBehavior.FunctionAssociations as { EventType: string }[];
    expect(associations).toHaveLength(1);
    expect(associations[0].EventType).toBe('viewer-request');

    for (const behavior of config.CacheBehaviors as Record<string, unknown>[]) {
      expect(behavior.FunctionAssociations, String(behavior.PathPattern)).toBeUndefined();
    }
  });

  it('serves index.html for every client route and leaves every file alone', () => {
    const rewrite = spaRewrite();
    const routes = [
      '/',
      '/en',
      '/fr/',
      '/en/2026-09-01',
      '/en/bonus/1234567',
      groupLandingPath('abcdefghijklmnop'),
      '/account/email',
      '/en/learn/2',
      '/fr/learning',
    ];
    for (const uri of routes) expect(rewrite(uri), uri).toBe('/index.html');
    for (const uri of [
      '/assets/x.js',
      '/vocab/en.json',
      '/version.json',
      '/favicon.ico',
      '/index.html',
      '/fr/learn/2/index.html',
    ]) {
      expect(rewrite(uri), uri).toBe(uri);
    }
  });

  // A route the build gave a page of its own wears that page's link preview (web
  // src/linkPreviews.ts); below one, the NEAREST such route above it answers — the route a
  // level not ready in a language lands on in the SPA (its list).
  it('serves a route the build gave a page of its own, and the nearest one above any other', () => {
    const rewrite = spaRewrite();
    expect(rewrite('/fr/learn')).toBe('/fr/learn/index.html');
    expect(rewrite('/fr/learn/')).toBe('/fr/learn/index.html');
    expect(rewrite('/fr/learn/2')).toBe('/fr/learn/2/index.html');
    expect(rewrite('/fr/learn/2/')).toBe('/fr/learn/2/index.html');
    expect(rewrite('/fr/learn/9')).toBe('/fr/learn/index.html');
    expect(rewrite('/fr')).toBe('/index.html');
  });

  it('reads the routes with a page of their own off a build', () => {
    const dist = fakeBuild([
      'index.html',
      'fr/learn/index.html',
      'fr/learn/2/index.html',
      'en/learn/index.html',
      'assets/nested/index.html',
      'vocab/index.html',
      'fr/other/page.html',
    ]);
    expect(builtRoutePages(dist)).toEqual(['/en/learn', '/fr/learn', '/fr/learn/2']);
    expect(builtRoutePages(path.join(dist, 'missing'))).toEqual([]);
  });

  it('lets the SPA call the backend it was given', () => {
    // An origin missing from `connect-src` is every API call refused by the browser.
    expect(siteCsp()['connect-src']).toContain(API_ORIGIN);
  });

  it('loads fonts and styles from the site alone', () => {
    // The fonts are self-hosted (`web/src/index.css`): the policy names no third party
    // for a request the app never makes.
    const csp = siteCsp();
    expect(csp['font-src']).toEqual(["'self'"]);
    expect(csp['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
  });

  // The uploads run in an order: the route pages after the chunks they name (as the root set
  // does) and BEFORE the fallback function that serves them — a function naming a page the
  // bucket does not hold yet answers that route with the bucket's 403 until the upload lands.
  it('publishes the route pages after their chunks and before the function that serves them', () => {
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    const id = (prefix: string) => Object.keys(deployments).find((key) => key.startsWith(prefix))!;
    const [pages, assets, vocab, root] = ['DeployPages', 'DeployAssets', 'DeployVocab', 'DeployRoot'].map(id);
    expect(deployments[pages].DependsOn).toEqual(expect.arrayContaining([assets, vocab]));
    const [fn] = Object.values(template.findResources('AWS::CloudFront::Function'));
    expect(fn.DependsOn).toEqual(expect.arrayContaining([pages]));
    // The pages are DeployPages' alone: the root set leaves them out.
    expect(deployments[pages].Properties.Include).toEqual(['*/index.html']);
    expect(deployments[root].Properties.Exclude).toContain('*/index.html');
  });

  // `bin/app.ts` runs cdk-nag over every stack, where a finding is a FAILED SYNTH — and
  // CI synthesizes nothing, so without this a finding is first seen by the deploy, after
  // the merge. The stack is built from a fake build, so the BucketDeployments and the
  // stack-level suppressions they need are checked too.
  it('synthesizes with NO cdk-nag findings', () => {
    const app = new App();
    const stack = webStack(app);
    Aspects.of(app).add(new AwsSolutionsChecks());
    expect(
      Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*')),
    ).toEqual([]);
  });
});
