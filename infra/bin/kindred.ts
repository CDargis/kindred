#!/usr/bin/env node
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as cdk from 'aws-cdk-lib';
import { KindredStack } from '../lib/kindred-stack';

// Load the repo's .env so DATABASE_URL / APP_PASSWORD / SESSION_SECRET are
// available at synth/deploy time without committing them.
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const app = new cdk.App();
cdk.Tags.of(app).add('Project', 'kindred'); // cost allocation, mirrors grow

new KindredStack(app, 'KindredStack', {
  env: { account: '853479287330', region: 'us-east-1' }, // same as grow
});
