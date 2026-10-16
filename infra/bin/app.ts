#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeFindings } from '../lib/nag';
import { RagStack } from '../lib/rag-stack';

const app = new cdk.App();

// Optional overrides: cdk deploy -c generationModelId=<id> -c ingestConcurrency=0
const generationModelId = String(app.node.tryGetContext('generationModelId') ?? 'amazon.nova-micro-v1:0');
const rawConcurrency: unknown = app.node.tryGetContext('ingestConcurrency') ?? 2;
const ingestConcurrency = Number(rawConcurrency);
if (!Number.isInteger(ingestConcurrency) || ingestConcurrency < 0) {
  throw new Error(`ingestConcurrency must be a whole number (0 = no cap), got ${JSON.stringify(rawConcurrency)}`);
}

const stack = new RagStack(app, 'S3VectorsRag', {
  generationModelId,
  ingestConcurrency: ingestConcurrency === 0 ? undefined : ingestConcurrency,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
});
acknowledgeFindings(stack);

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
