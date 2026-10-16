import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

/** Turns text into a vector. Titan Text Embeddings V2 takes one text per call. */
export interface Embedder {
  embed(text: string): Promise<Embedding>;
}

export interface Embedding {
  vector: number[];
  /** Input tokens Bedrock counted. You pay per input token. */
  tokens: number;
}

interface TitanResponse {
  embedding?: unknown;
  inputTextTokenCount?: unknown;
}

export class TitanEmbedder implements Embedder {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId: string,
    private readonly dimensions: number,
  ) {}

  async embed(text: string): Promise<Embedding> {
    const res = await this.client.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        // normalize: unit-length vectors, so cosine and euclidean rank results the same way.
        body: JSON.stringify({ inputText: text, dimensions: this.dimensions, normalize: true }),
      }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as TitanResponse;
    const vector = parsed.embedding;
    if (!Array.isArray(vector) || vector.length !== this.dimensions || !vector.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new Error(`embedding model returned no usable ${this.dimensions}-dimension vector`);
    }
    return { vector: vector as number[], tokens: typeof parsed.inputTextTokenCount === 'number' ? parsed.inputTextTokenCount : 0 };
  }
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight, keeping input order.
 * Bedrock throttles per account and model, so one big Promise.all over 500 chunks
 * mostly buys ThrottlingExceptions.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
