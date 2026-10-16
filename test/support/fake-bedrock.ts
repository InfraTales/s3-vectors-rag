/**
 * Fakes for the two Bedrock calls, wired into the real BedrockRuntimeClient.
 *
 * The fake embedding is a hashed bag of words: texts that share words point in similar
 * directions. It's crude, but it's deterministic and good enough to test ranking,
 * filtering and the distance cut-off end to end.
 */
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import { normalize } from '../../app/src/distance';

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'for', 'on', 'with', 'how', 'what', 'do', 'i', 'we', 'you', 'our', 'can', 'it', 'be']);

export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w)) ?? [];
}

export function fakeEmbedding(text: string, dims: number): number[] {
  const v: number[] = Array.from({ length: dims }, () => 0);
  for (const w of words(text)) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
    v[h % dims] = (v[h % dims] ?? 0) + 1;
    v[(h >>> 10) % dims] = (v[(h >>> 10) % dims] ?? 0) + 0.5;
  }
  // An empty or all-stopword text still needs a non-zero vector.
  if (!v.some((x) => x !== 0)) v[0] = 1;
  return normalize(v);
}

export interface FakeBedrock {
  embedCalls: string[];
  prompts: { system: string; user: string; modelId: string }[];
  reset(): void;
}

export function installFakeBedrock(): FakeBedrock {
  const state: FakeBedrock = {
    embedCalls: [],
    prompts: [],
    reset() {
      this.embedCalls.length = 0;
      this.prompts.length = 0;
    },
  };
  const mock = mockClient(BedrockRuntimeClient);
  mock.on(InvokeModelCommand).callsFake((input: InvokeModelCommand['input']) => {
    const raw = typeof input.body === 'string' ? input.body : new TextDecoder().decode(input.body as Uint8Array);
    const body = JSON.parse(raw) as { inputText: string; dimensions: number; normalize: boolean };
    state.embedCalls.push(body.inputText);
    const out = { embedding: fakeEmbedding(body.inputText, body.dimensions), inputTextTokenCount: words(body.inputText).length };
    return { body: new TextEncoder().encode(JSON.stringify(out)) };
  });
  mock.on(ConverseCommand).callsFake((input: ConverseCommand['input']) => {
    const system = input.system?.[0]?.text ?? '';
    const user = input.messages?.[0]?.content?.[0]?.text ?? '';
    state.prompts.push({ system, user, modelId: input.modelId ?? '' });
    return {
      output: { message: { role: 'assistant', content: [{ text: 'Answer from [1].' }] } },
      usage: { inputTokens: words(system + user).length, outputTokens: 4, totalTokens: 0 },
    };
  });
  return state;
}
