import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { NON_FILTERABLE_KEYS as APP_NON_FILTERABLE } from '../../app/src/vector-store';
import { acknowledgeFindings } from '../../infra/lib/nag';
import { BUILD_DIR, DIMENSIONS, RagStack } from '../../infra/lib/rag-stack';

const env = { account: '123456789012', region: 'us-east-1' };
const build = (id: string, props: Partial<ConstructorParameters<typeof RagStack>[2]> = {}) => {
  const app = new cdk.App();
  const stack = new RagStack(app, id, { env, generationModelId: 'amazon.nova-micro-v1:0', ingestConcurrency: 2, ...props });
  return { app, stack, template: Template.fromStack(stack) };
};
const { stack, template } = build('Test');
const fns = () => Object.values<any>(template.findResources('AWS::Lambda::Function')).filter((f) => f.Properties.Environment?.Variables?.VECTOR_INDEX_ARN !== undefined);
const fnByEnv = (key: string) => fns().find((f) => f.Properties.Environment.Variables[key] !== undefined);
const policyOf = (fn: any) => {
  const roleRef = fn.Properties.Role['Fn::GetAtt'][0];
  return Object.values<any>(template.findResources('AWS::IAM::Policy'))
    .filter((p) => p.Properties.Roles.some((r: any) => r.Ref === roleRef))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
};
const actionsOf = (fn: any) => policyOf(fn).flatMap((s: any) => [s.Action].flat()).sort();
const indexLogicalId = Object.keys(template.findResources('AWS::S3Vectors::Index'))[0]!;

test('one 1024-dimension float32 cosine index, with chunk text non-filterable', () => {
  template.resourceCountIs('AWS::S3Vectors::Index', 1);
  template.hasResourceProperties('AWS::S3Vectors::Index', {
    DataType: 'float32',
    Dimension: 1024,
    DistanceMetric: 'cosine',
    IndexName: 'chunks',
    MetadataConfiguration: { NonFilterableMetadataKeys: ['text', 'title'] },
  });
});

test('the index points at the vector bucket by ARN (Ref on a vector bucket is its ARN, not its name)', () => {
  template.hasResourceProperties('AWS::S3Vectors::Index', {
    VectorBucketArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Vectors'), 'VectorBucketArn'] },
  });
  const props = Object.values<any>(template.findResources('AWS::S3Vectors::Index'))[0].Properties;
  expect(props.VectorBucketName).toBeUndefined();
});

test('both functions get the index ARN, not a bucket name', () => {
  for (const fn of fns()) {
    expect(fn.Properties.Environment.Variables.VECTOR_INDEX_ARN).toEqual({ 'Fn::GetAtt': [indexLogicalId, 'IndexArn'] });
  }
});

test('the app and the stack agree on dimensions and non-filterable keys', () => {
  expect(DIMENSIONS).toBe(1024);
  template.hasResourceProperties('AWS::S3Vectors::Index', { MetadataConfiguration: { NonFilterableMetadataKeys: [...APP_NON_FILTERABLE] } });
});

test('vectors are encrypted with S3-managed keys, and derived data is deleted with the stack', () => {
  template.hasResource('AWS::S3Vectors::VectorBucket', { Properties: { EncryptionConfiguration: { SseType: 'AES256' } }, DeletionPolicy: 'Delete' });
  template.hasResource('AWS::S3Vectors::Index', { DeletionPolicy: 'Delete' });
});

test('the documents bucket is private, TLS-only, and kept on stack delete', () => {
  template.hasResource('AWS::S3::Bucket', {
    Properties: Match.objectLike({
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    }),
    DeletionPolicy: 'Retain',
  });
  const policy = Object.values<any>(template.findResources('AWS::S3::BucketPolicy'))[0].Properties.PolicyDocument.Statement;
  expect(policy).toContainEqual(expect.objectContaining({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }));
});

test('both functions run Node.js 24 on arm64', () => {
  expect(fns()).toHaveLength(2);
  for (const fn of fns()) expect(fn.Properties).toMatchObject({ Runtime: 'nodejs24.x', Architectures: ['arm64'] });
});

test('ingest can write and delete vectors and read docs/, nothing more', () => {
  const ingest = fnByEnv('EMBED_CONCURRENCY');
  expect(actionsOf(ingest)).toEqual([
    'bedrock:InvokeModel',
    'logs:CreateLogStream',
    'logs:PutLogEvents',
    's3:GetObject',
    's3vectors:DeleteVectors',
    's3vectors:GetVectors',
    's3vectors:PutVectors',
    // CDK's SQS destination grant: send to the dead-letter queue only.
    'sqs:GetQueueAttributes',
    'sqs:GetQueueUrl',
    'sqs:SendMessage',
  ]);
  const vectors = policyOf(ingest).find((s: any) => [s.Action].flat().includes('s3vectors:PutVectors'));
  expect(vectors.Resource).toEqual({ 'Fn::GetAtt': [indexLogicalId, 'IndexArn'] });
  const s3 = policyOf(ingest).find((s: any) => s.Action === 's3:GetObject');
  expect(JSON.stringify(s3.Resource)).toContain('/docs/*');
  expect(ingest.Properties.ReservedConcurrentExecutions).toBe(2);
});

test('query can only read vectors: no writes, no deletes', () => {
  const query = fnByEnv('GENERATION_MODEL_ID');
  const actions = actionsOf(query);
  expect(actions).toEqual(['bedrock:InvokeModel', 'logs:CreateLogStream', 'logs:PutLogEvents', 's3vectors:GetVectors', 's3vectors:QueryVectors']);
});

test('Bedrock access names exact models, in this Region', () => {
  const query = fnByEnv('GENERATION_MODEL_ID');
  const bedrock = policyOf(query).find((s: any) => s.Action === 'bedrock:InvokeModel');
  const arns = JSON.stringify(bedrock.Resource);
  expect(arns).toContain(':bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0');
  expect(arns).toContain(':bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0');
  expect(arns).not.toContain('*');
});

test('a cross-Region inference profile grants the profile plus the model in any Region', () => {
  const { template: t } = build('Profile', { generationModelId: 'us.amazon.nova-lite-v1:0' });
  const statements = Object.values<any>(t.findResources('AWS::IAM::Policy')).flatMap((p) => p.Properties.PolicyDocument.Statement);
  const arns = JSON.stringify(statements.filter((s: any) => s.Action === 'bedrock:InvokeModel').map((s: any) => s.Resource));
  expect(arns).toContain(':bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-lite-v1:0');
  expect(arns).toContain(':bedrock:*::foundation-model/amazon.nova-lite-v1:0');
});

test('the query function URL needs SigV4 (IAM auth)', () => {
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
});

test('docs/*.md and docs/*.txt uploads and deletes trigger ingest', () => {
  const config = Object.values<any>(template.findResources('Custom::S3BucketNotifications'))[0].Properties.NotificationConfiguration;
  const rules = config.LambdaFunctionConfigurations.map((c: any) => ({
    events: c.Events,
    filter: c.Filter.Key.FilterRules.map((r: any) => `${r.Name}=${r.Value}`).sort(),
  }));
  expect(rules).toEqual(
    expect.arrayContaining([
      { events: ['s3:ObjectCreated:*'], filter: ['prefix=docs/', 'suffix=.md'] },
      { events: ['s3:ObjectRemoved:*'], filter: ['prefix=docs/', 'suffix=.txt'] },
    ]),
  );
  expect(rules).toHaveLength(4);
});

test('failed ingest events go to a dead-letter queue with an alarm on it', () => {
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    MaximumRetryAttempts: 2,
    DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [Match.stringLikeRegexp('^IngestFailures'), 'Arn'] } } },
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'ApproximateNumberOfMessagesVisible', Threshold: 1 });
});

test('the query function drops chunks farther than cosine distance 0.6', () => {
  expect(fnByEnv('GENERATION_MODEL_ID').Properties.Environment.Variables.MAX_DISTANCE).toBe('0.6');
});

test('no ingest concurrency cap when asked for none', () => {
  const { template: t } = build('NoCap', { ingestConcurrency: undefined });
  for (const fn of Object.values<any>(t.findResources('AWS::Lambda::Function'))) expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
});

test('cdk-nag AwsSolutions passes, with every acknowledgement scoped and explained', () => {
  const { app, stack: s } = build('Nag');
  acknowledgeFindings(s);
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const assembly = app.synth();
  const report = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'validation-report.json'), 'utf8'));
  for (const plugin of report.pluginReports) expect(plugin.violations).toEqual([]);
});

test('synth stops with a clear message when the bundle is missing', () => {
  const dir = path.join(BUILD_DIR, 'query');
  const backup = `${dir}.bak-${process.pid}`;
  fs.renameSync(dir, backup);
  try {
    expect(() => build('NoBundle')).toThrow('Run "npm run bundle" first');
  } finally {
    fs.renameSync(backup, dir);
  }
});

test('the stack is env-specific only through props', () => {
  expect(stack.region).toBe('us-east-1');
});
