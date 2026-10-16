/**
 * Smoke test for a real deploy. Run after `npm run deploy`, with credentials for that account:
 *
 *   npm run smoke
 *
 * 1. Uploads a small document for tenant "smoke" and waits until a question finds it.
 * 2. Checks that tenant "smoke-other" can't see it.
 * 3. Deletes the document and waits until its vectors are gone.
 * It invokes the query function directly with a function URL-shaped event, so it needs
 * lambda:InvokeFunction rather than a SigV4-signed HTTP call.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const STACK = process.env.STACK_NAME ?? 'S3VectorsRag';
const KEY = 'docs/smoke/runbook/smoke-test.md';
const DOC = `# Smoke test\n\nThe smoke test password for the S3 Vectors stack is purple-giraffe-42. It changes every Tuesday.`;
const QUESTION = 'What is the smoke test password for the S3 Vectors stack?';

interface Answer {
  answer: string;
  generated: boolean;
  sources: { doc: string; distance: number }[];
}

async function outputs(): Promise<Record<string, string>> {
  const res = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: STACK }));
  const out: Record<string, string> = {};
  for (const o of res.Stacks?.[0]?.Outputs ?? []) if (o.OutputKey && o.OutputValue) out[o.OutputKey] = o.OutputValue;
  return out;
}

async function ask(fn: string, tenant: string): Promise<Answer> {
  const event = { body: JSON.stringify({ tenant, question: QUESTION }), requestContext: { http: { method: 'POST' } } };
  const res = await new LambdaClient({}).send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(event)) }));
  if (res.FunctionError) throw new Error(`query function failed: ${Buffer.from(res.Payload ?? []).toString()}`);
  const reply = JSON.parse(Buffer.from(res.Payload ?? []).toString()) as { statusCode: number; body: string };
  if (reply.statusCode !== 200) throw new Error(`query returned ${reply.statusCode}: ${reply.body}`);
  return JSON.parse(reply.body) as Answer;
}

async function waitFor(what: string, check: () => Promise<boolean>, seconds = 120): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`timed out after ${seconds}s waiting for: ${what}`);
}

async function main(): Promise<void> {
  const out = await outputs();
  const bucket = out.DocsBucketName;
  const fn = out.QueryFunctionName;
  if (!bucket || !fn) throw new Error(`stack ${STACK} has no DocsBucketName / QueryFunctionName outputs`);
  const s3 = new S3Client({});

  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: KEY, Body: DOC, ContentType: 'text/markdown' }));
  console.log(`uploaded s3://${bucket}/${KEY}`);
  try {
    let last: Answer | undefined;
    await waitFor('the document to be searchable', async () => {
      last = await ask(fn, 'smoke');
      return last.sources.some((s) => s.doc === 'smoke-test');
    });
    console.log(`found it: distance ${last?.sources[0]?.distance}, answer: ${last?.answer}`);
    if (!last?.answer.includes('purple-giraffe-42')) console.warn('warning: the answer did not quote the password; check the model output above');

    const other = await ask(fn, 'smoke-other');
    if (other.sources.some((s) => s.doc === 'smoke-test')) throw new Error('tenant isolation failed: smoke-other saw the smoke document');
    console.log('tenant isolation holds');
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: KEY }));
  }
  await waitFor('the vectors to be deleted', async () => !(await ask(fn, 'smoke')).sources.some((s) => s.doc === 'smoke-test'));
  console.log('deleted document is gone from search. Smoke test passed.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
