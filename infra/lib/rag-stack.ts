import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export const BUILD_DIR = path.join(__dirname, '..', '..', 'build');
export const INDEX_NAME = 'chunks';
export const DIMENSIONS = 1024;
export const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
/** Keys stored with each vector but not usable in filters. Must match app/src/vector-store.ts. */
export const NON_FILTERABLE_KEYS = ['text', 'title'];

export interface RagStackProps extends cdk.StackProps {
  /** Bedrock model for answers: a model ID or a cross-Region inference profile ID. */
  generationModelId: string;
  /** Most ingest functions running at once. Caps Bedrock spend during a bulk upload. Undefined = no cap. */
  ingestConcurrency?: number;
}

export class RagStack extends cdk.Stack {
  readonly docsBucket: s3.Bucket;
  readonly vectorBucket: s3vectors.CfnVectorBucket;
  readonly index: s3vectors.CfnIndex;
  readonly ingestFn: lambda.Function;
  readonly queryFn: lambda.Function;
  readonly deadLetters: sqs.Queue;

  constructor(scope: Construct, id: string, props: RagStackProps) {
    super(scope, id, props);

    // Source of truth for documents. Retained on delete: vectors can be rebuilt from it, not the other way round.
    this.docsBucket = new s3.Bucket(this, 'Docs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The vector bucket and its one index. Derived data, so `cdk destroy` deletes them and the bill stops.
    this.vectorBucket = new s3vectors.CfnVectorBucket(this, 'Vectors', {
      encryptionConfiguration: { sseType: 'AES256' },
    });
    this.vectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    this.index = new s3vectors.CfnIndex(this, 'ChunksIndex', {
      // Ref on a vector bucket returns its ARN, not its name. Wire by ARN everywhere.
      vectorBucketArn: this.vectorBucket.attrVectorBucketArn,
      indexName: INDEX_NAME,
      dataType: 'float32',
      dimension: DIMENSIONS,
      // Titan V2 returns unit vectors (normalize: true), and cosine distance reads as 0 = same, 1 = unrelated.
      distanceMetric: 'cosine',
      // Chunk text is far bigger than the filterable metadata allowance, so it must be non-filterable.
      metadataConfiguration: { nonFilterableMetadataKeys: NON_FILTERABLE_KEYS },
    });
    this.index.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const indexArn = this.index.attrIndexArn;
    const embedModelArn = this.formatArn({ service: 'bedrock', account: '', resource: 'foundation-model', resourceName: EMBEDDING_MODEL_ID });
    const ragEnv = {
      VECTOR_INDEX_ARN: indexArn,
      EMBEDDING_MODEL_ID,
      EMBEDDING_DIMENSIONS: String(DIMENSIONS),
    };

    // ---- Ingest: S3 event -> chunk -> embed -> PutVectors ----
    this.deadLetters = new sqs.Queue(this, 'IngestFailures', {
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.ingestFn = this.fn('Ingest', 'ingest', {
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: props.ingestConcurrency,
      environment: { ...ragEnv, EMBED_CONCURRENCY: '4' },
      onFailure: new destinations.SqsDestination(this.deadLetters),
      retryAttempts: 2,
    });
    this.ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3vectors:PutVectors', 's3vectors:GetVectors', 's3vectors:DeleteVectors'],
        resources: [indexArn],
      }),
    );
    this.ingestFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [embedModelArn] }));
    // Read objects under docs/ only.
    this.ingestFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [this.docsBucket.arnForObjects('docs/*')] }));
    // ListBucket makes S3 answer 404 (NoSuchKey) for a deleted document instead of 403. The handler
    // relies on that to tell "deleted" from "not allowed". It lists key names only.
    this.ingestFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [this.docsBucket.bucketArn] }));

    for (const suffix of ['.md', '.txt']) {
      const filter = { prefix: 'docs/', suffix };
      this.docsBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(this.ingestFn), filter);
      this.docsBucket.addEventNotification(s3.EventType.OBJECT_REMOVED, new s3n.LambdaDestination(this.ingestFn), filter);
    }

    // ---- Query: function URL (IAM auth) -> embed -> QueryVectors -> Converse ----
    this.queryFn = this.fn('Query', 'query', {
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...ragEnv,
        GENERATION_MODEL_ID: props.generationModelId,
        MAX_DISTANCE: '0.6',
        DEFAULT_TOP_K: '5',
        MAX_ANSWER_TOKENS: '512',
      },
    });
    this.queryFn.addToRolePolicy(
      new iam.PolicyStatement({
        // QueryVectors with a filter or returnMetadata also needs GetVectors.
        actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors'],
        resources: [indexArn],
      }),
    );
    this.queryFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [embedModelArn, ...this.generationModelArns(props.generationModelId)] }),
    );
    const url = this.queryFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // Anything in the dead-letter queue is a document that never made it into the index.
    new cloudwatch.Alarm(this, 'IngestFailuresAlarm', {
      alarmDescription: 'A document failed to ingest after retries. Read the message in the IngestFailures queue.',
      metric: this.deadLetters.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cdk.CfnOutput(this, 'DocsBucketName', { value: this.docsBucket.bucketName });
    new cdk.CfnOutput(this, 'VectorBucketArn', { value: this.vectorBucket.attrVectorBucketArn });
    new cdk.CfnOutput(this, 'IndexArn', { value: indexArn });
    new cdk.CfnOutput(this, 'QueryUrl', { value: url.url });
    new cdk.CfnOutput(this, 'QueryFunctionName', { value: this.queryFn.functionName });
  }

  /** A function from build/<dir>, arm64, Node.js 24, with its own role and log group (no managed policies). */
  private fn(id: string, dir: string, extra: Partial<lambda.FunctionProps>): lambda.Function {
    const codeDir = path.join(BUILD_DIR, dir);
    if (!fs.existsSync(path.join(codeDir, 'index.js'))) throw new Error(`No bundle in ${codeDir}. Run "npm run bundle" first.`);
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, `${id}Role`, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [logGroup.logGroupArn] }));
    return new lambda.Function(this, id, {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(codeDir),
      role,
      logGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      ...extra,
      environment: { NODE_OPTIONS: '--enable-source-maps', ...extra.environment },
    });
  }

  /**
   * IAM resources for the answer model. A plain model ID is one foundation-model ARN in this Region.
   * A cross-Region inference profile (us., eu., apac., global.) needs the profile ARN plus the
   * foundation model in every Region the profile can route to.
   */
  private generationModelArns(modelId: string): string[] {
    const profile = /^(us|eu|apac|global|us-gov|jp|au|ca)\.(.+)$/.exec(modelId);
    if (!profile?.[2]) {
      return [this.formatArn({ service: 'bedrock', account: '', resource: 'foundation-model', resourceName: modelId })];
    }
    return [
      this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: modelId }),
      this.formatArn({ service: 'bedrock', region: '*', account: '', resource: 'foundation-model', resourceName: profile[2] }),
    ];
  }
}
