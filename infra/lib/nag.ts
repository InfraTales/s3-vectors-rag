import * as cdk from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { RagStack } from './rag-stack';

/** Every cdk-nag finding we accept, scoped to one construct, each with its reason. */
export function acknowledgeFindings(stack: RagStack): void {
  const ack = (scope: IConstruct, id: string, reason: string) => cdk.Validations.of(scope).acknowledge({ id, reason });

  ack(
    stack.docsBucket,
    'AwsSolutions::AwsSolutions-S1',
    'Sample stack: server access logs need a second bucket and add cost. Turn on CloudTrail S3 data events if you need an audit trail of document reads.',
  );
  ack(
    stack.ingestFn.role!.node.findChild('DefaultPolicy'),
    `AwsSolutions::AwsSolutions-IAM5[Resource::<${stack.getLogicalId(stack.docsBucket.node.defaultChild as cdk.CfnElement)}.Arn>/docs/*]`,
    'The ingest function reads any document under docs/, and documents are created by users after deploy. s3:GetObject only.',
  );
  // CDK adds this helper to wire S3 event notifications at deploy time. CDK owns its code and role.
  const helper = stack.node.children.find((c) => c.node.id.startsWith('BucketNotificationsHandler'));
  if (!helper) throw new Error('BucketNotificationsHandler not found; check the cdk-nag acknowledgements');
  ack(
    helper,
    'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    'CDK BucketNotificationsHandler, a deploy-time helper that only sets the docs bucket notification. CDK sets its role.',
  );
  ack(stack.deadLetters, 'AwsSolutions::AwsSolutions-SQS3', 'This queue is the dead-letter destination for failed ingest events. It has no queue of its own behind it.');
}
