export const DEFAULT_EMBEDDING_MODEL = "fast-bge-small-zh-v1.5";

/** fastembed's built-in models, listed statically so config validation never loads fastembed (test/embedding-models.test.ts keeps it in sync). */
export const EMBEDDING_MODELS: readonly string[] = [
	"fast-all-MiniLM-L6-v2",
	"fast-bge-base-en",
	"fast-bge-base-en-v1.5",
	"fast-bge-small-en",
	"fast-bge-small-en-v1.5",
	DEFAULT_EMBEDDING_MODEL,
	"fast-multilingual-e5-large",
];

export function isSupportedEmbeddingModel(model: string): boolean {
	return EMBEDDING_MODELS.includes(model);
}
