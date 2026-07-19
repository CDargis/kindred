// Lambda handler — wraps the Express app for a Lambda Function URL.
// The app (and its pg pool) init once per cold start and are reused across
// warm invocations. Neon's pooler handles connection reuse on its side.
import serverlessExpress from '@codegenie/serverless-express';
import { app } from '../ui/server.mjs';

export const handler = serverlessExpress({ app });
