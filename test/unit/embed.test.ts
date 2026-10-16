import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { mapLimit, TitanEmbedder } from '../../app/src/embed';

const bedrock = mockClient(BedrockRuntimeClient);
afterEach(() => bedrock.reset());
const reply = (o: unknown) => ({ body: new TextEncoder().encode(JSON.stringify(o)) }) as never;

test('asks Titan V2 for normalized vectors of the index dimension', async () => {
  bedrock.on(InvokeModelCommand).resolves(reply({ embedding: [0.6, 0.8], inputTextTokenCount: 3 }));
  const e = new TitanEmbedder(new BedrockRuntimeClient({ region: 'us-east-1' }), 'amazon.titan-embed-text-v2:0', 2);
  await expect(e.embed('hello')).resolves.toEqual({ vector: [0.6, 0.8], tokens: 3 });
  const input = bedrock.commandCalls(InvokeModelCommand)[0]!.args[0].input;
  expect(input.modelId).toBe('amazon.titan-embed-text-v2:0');
  expect(JSON.parse(input.body as string)).toEqual({ inputText: 'hello', dimensions: 2, normalize: true });
});

test.each([
  ['wrong dimension', { embedding: [1, 0, 0] }],
  ['no embedding', { message: 'nope' }],
  ['NaN inside', { embedding: [Number.NaN, 1] }],
  ['strings inside', { embedding: ['1', '2'] }],
])('rejects a response with %s', async (_n, body) => {
  bedrock.on(InvokeModelCommand).resolves(reply(body));
  const e = new TitanEmbedder(new BedrockRuntimeClient({ region: 'us-east-1' }), 'm', 2);
  await expect(e.embed('x')).rejects.toThrow('no usable 2-dimension vector');
});

test('mapLimit keeps order and never runs more than the limit at once', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit(Array.from({ length: 25 }, (_, i) => i), 4, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1 + (n % 3)));
    inFlight--;
    return n * 2;
  });
  expect(out).toEqual(Array.from({ length: 25 }, (_, i) => i * 2));
  expect(peak).toBe(4);
});

test('mapLimit on an empty list returns an empty list', async () => {
  await expect(mapLimit([], 4, async () => 1)).resolves.toEqual([]);
});
