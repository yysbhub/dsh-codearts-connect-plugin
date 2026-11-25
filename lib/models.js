/**
 * Model catalogue published by dsh-codearts-connect.
 *
 * Kept in its own dependency-free module so the operator CLI (`bin.js probe`)
 * can load the same list without pulling the pi-ai / dsh peer dependencies that
 * `lib/index.js` needs.
 *
 * `contextWindow`/`maxTokens` mirror what the CodeArts catalogue declares for
 * the account (and what the app caches in its `huaweicloud.codearts-snap`
 * state). `supportsImages` decides whether an image turn is sent to the model
 * itself or routed to the configured vision model.
 *
 * `reasoningEfforts` maps a DSH thinking level to the value the gateway should
 * receive in `reasoning_effort`; `null` means "this model cannot take that
 * level" and keeps it out of the picker. An array is still accepted as a
 * shorthand for "each level sends its own name".
 *
 * `id` must be the gateway's model id exactly: the plugin forwards it verbatim.
 * Note the mixed casing — `glm-5.3`/`deepseek-v4.1-flash` are lowercase while
 * `GLM-5.2` is uppercase. They are not interchangeable.
 *
 * CodeArts rotates this list fairly often (models are added and retired without
 * notice). After an app upgrade run `node bin.js probe` to see which entries are
 * still routable and which thinking levels they still accept, then prune/fix
 * here.
 *
 * @module dsh-codearts-connect/models
 */

/**
 * Thinking levels the gateway accepts, with their wire values.
 *
 * Probe-verified 2026-11 on the live gateway: every published model accepts
 * low/medium/high/xhigh/max; `none` and `minimal` are accepted by all except
 * `glm-5.3`, and none of them actually stops a reasoning model from reasoning,
 * so this map leaves `off` unsupported (`null`) rather than pretending a
 * non-existent switch exists.
 */
const REASONING_EFFORTS = {
	off: null,
	minimal: null,
	low: 'low',
	medium: 'medium',
	high: 'high',
	xhigh: 'xhigh',
	max: 'max'
};

const DEFAULT_MODELS = [
	// 多模态（实测可直接读图）
	{ id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', contextWindow: 1_048_576, maxTokens: 65_536, supportsImages: true, reasoningEfforts: REASONING_EFFORTS },
	{ id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1_048_576, maxTokens: 65_536, supportsImages: true, reasoningEfforts: REASONING_EFFORTS },
	// 文本模型
	{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576, maxTokens: 65_536, supportsImages: false, reasoningEfforts: REASONING_EFFORTS },
	{ id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 202_752, maxTokens: 65_536, supportsImages: false, reasoningEfforts: REASONING_EFFORTS },
	{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576, maxTokens: 65_536, supportsImages: false, reasoningEfforts: REASONING_EFFORTS },
	// 目录外（探活验证）：v4.1-flash 的 1017 快照，网关可路由，输出上限同样按 65536 收口
	{ id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017', contextWindow: 1_048_576, maxTokens: 65_536, supportsImages: false, reasoningEfforts: REASONING_EFFORTS },
	{ id: 'openpangu-2.0-pro', name: 'OpenPangu-2.0-Pro', contextWindow: 524_288, maxTokens: 131_072, supportsImages: false, reasoningEfforts: REASONING_EFFORTS },
	{ id: 'openpangu-2.0-flash', name: 'OpenPangu-2.0-Flash', contextWindow: 524_288, maxTokens: 131_072, supportsImages: false, reasoningEfforts: REASONING_EFFORTS },
	{ id: 'glm-5.2-sft-harmony', name: 'GLM-5.2-ArkTS-SPARK', contextWindow: 202_752, maxTokens: 131_072, supportsImages: false, reasoningEfforts: REASONING_EFFORTS }
];

/** Model used for image turns on text-only models (must be multimodal and callable). */
const DEFAULT_VISION_MODEL = 'kimi-k3';

/** Every thinking level pi-ai knows, in escalation order. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Normalize a declared effort list/map into pi-ai's `thinkingLevelMap`.
 *
 * `null` keeps a level out of the picker; a string is forwarded verbatim as
 * `reasoning_effort`. A level the declaration omits is treated as unsupported
 * rather than silently defaulting to something the gateway would refuse.
 */
function thinkingLevelMap(efforts) {
	const declared = Array.isArray(efforts)
		? Object.fromEntries(efforts.map((level) => [level, level]))
		: efforts ?? {};
	const map = {};
	for (const level of THINKING_LEVELS) {
		const wire = declared[level];
		map[level] = typeof wire === 'string' && wire !== '' ? wire : null;
	}
	return map;
}

export { DEFAULT_MODELS, DEFAULT_VISION_MODEL, REASONING_EFFORTS, THINKING_LEVELS, thinkingLevelMap };
