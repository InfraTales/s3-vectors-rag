/** Reads a required environment variable, so a missing setting fails loudly at cold start. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

/** Reads a positive whole number from the environment, with a default. */
export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export interface RagConfig {
  /** The index ARN. S3 Vectors calls accept it in place of bucket name + index name. */
  indexArn: string;
  embeddingModelId: string;
  dimensions: number;
}

export function ragConfig(): RagConfig {
  return {
    indexArn: requireEnv('VECTOR_INDEX_ARN'),
    embeddingModelId: requireEnv('EMBEDDING_MODEL_ID'),
    dimensions: intEnv('EMBEDDING_DIMENSIONS', 1024),
  };
}
