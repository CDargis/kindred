import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';

const DOMAIN = 'kindred.chrisdargis.com';
const ZONE = 'chrisdargis.com';
const ZONE_ID = 'Z0403035565ZEMQD3654'; // chrisdargis.com — pinned so no lookup role is needed

// One Lambda (Express via serverless-express) behind a Function URL (no API
// Gateway cost), fronted by CloudFront for the custom domain at kindred.
// .chrisdargis.com. Scales to zero; Neon is separate.
export class KindredStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repoRoot = path.join(__dirname, '..', '..'); // infra/lib -> repo root

    const fn = new lambda.Function(this, 'KindredApp', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'lambda/index.handler',
      // Zip the app + node_modules (express/pg/serverless-express are pure JS,
      // so a Windows-built tree runs fine on Lambda's Linux). No bundler needed.
      code: lambda.Code.fromAsset(repoRoot, {
        exclude: [
          'infra', '.git', 'context', 'spike', 'research', 'cdk.out',
          '.env', '*.log', '.gitignore', 'ui/README*',
        ],
      }),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        DATABASE_URL: reqEnv('DATABASE_URL'),   // Neon pooled URL
        APP_PASSWORD: reqEnv('APP_PASSWORD'),   // single sign-in password
        SESSION_SECRET: reqEnv('SESSION_SECRET'), // HMAC key for the session cookie
        NODE_OPTIONS: '--no-warnings',
      },
    });

    // App does its own auth, so the URL itself is open.
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // Custom domain: CloudFront in front of the Function URL + ACM cert + R53 alias.
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: ZONE_ID,
      zoneName: ZONE,
    });
    const cert = new acm.Certificate(this, 'Cert', {
      domainName: DOMAIN,
      validation: acm.CertificateValidation.fromDns(zone), // auto-creates validation record
    });
    const dist = new cloudfront.Distribution(this, 'Dist', {
      domainNames: [DOMAIN],
      certificate: cert,
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(url),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,          // POST /login
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,          // dynamic app
        // Forward cookies/query/headers to origin, but NOT Host — a Function URL
        // rejects a mismatched Host header.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
    });
    new route53.ARecord(this, 'Alias', {
      zone,
      recordName: 'kindred',
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(dist)),
    });

    new cdk.CfnOutput(this, 'AppUrl', { value: `https://${DOMAIN}` });
    new cdk.CfnOutput(this, 'FunctionUrl', { value: url.url });
    new cdk.CfnOutput(this, 'CloudFrontDomain', { value: dist.distributionDomainName });
  }
}

// Secrets come from the environment at deploy time (loaded from repo .env by
// bin/kindred.ts) — never hardcoded, so nothing sensitive lands in git.
function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing env var ${name}. Set it (repo .env) before cdk deploy.`);
  }
  return v;
}
