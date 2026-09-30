import { EmbeddingModel, FlagEmbedding } from "fastembed";

export const DEFAULT_EMBEDDING_MODEL = "fast-bge-small-zh-v1.5";

export interface Embedder {
	readonly dimensions: number;
	embed(texts: readonly string[]): Promise<Float32Array[]>;
}

type StandardModel = Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;
const MODELS: Record<string, StandardModel> = Object.fromEntries(
	Object.values(EmbeddingModel)
		.filter((model): model is StandardModel => model !== EmbeddingModel.CUSTOM)
		.map((model) => [model, model]),
);

export function isSupportedEmbeddingModel(model: string): boolean {
	return Object.hasOwn(MODELS, model);
}

/** 每个适配器只初始化一次模型；后续批次共用 tokenizer 与 ONNX session。 */
export async function createFastEmbedder(options: { model: string; cacheDir: string }): Promise<Embedder> {
	const model = Object.hasOwn(MODELS, options.model) ? MODELS[options.model] : undefined;
	if (!model) throw new Error("不支持的 embedding 模型");
	const instance = await FlagEmbedding.init({ model, cacheDir: options.cacheDir, showDownloadProgress: false });
	let dimensions = instance.listSupportedModels().find((entry) => entry.model === model)?.dim;
	if (!dimensions) {
		for await (const batch of instance.embed(["维度探测"])) dimensions = batch[0]?.length;
	}
	if (!dimensions) throw new Error("embedding 模型未返回向量维度");
	return {
		dimensions,
		async embed(texts) {
			if (!texts.length) return [];
			const vectors: Float32Array[] = [];
			for await (const batch of instance.embed([...texts])) {
				for (const vector of batch) vectors.push(Float32Array.from(vector));
			}
			return vectors;
		},
	};
}
