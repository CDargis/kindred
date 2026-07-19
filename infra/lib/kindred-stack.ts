import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

// Cheapest viable shape: one Lambda (the Express app via serverless-express)
// behind a Function URL (no API Gateway cost). Scales to zero. Neon is separate.
// A custom domain (CloudFront + ACM + R53 alias) is a documented fast-follow.
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

    new cdk.CfnOutput(this, 'FunctionUrl', { value: url.url });
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
