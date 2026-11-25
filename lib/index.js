/**
 * dsh-codearts-connect — bring CodeArts Agent (码道) models into DeepSeek
 * Harness with no separate process or provider configuration.
 *
 * The plugin owns a loopback OpenAI-compatible shim backed by the CodeArts
 * model gateway, then registers one `codearts` route with the Harness LLM seam
 * through the public `PiAiAdapter` extension point.
 *
 * @module dsh-codearts-connect
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import z from '@deepseek-ai/schemastery';

import { DEFAULT_MODELS, DEFAULT_VISION_MODEL, REASONING_EFFORTS, THINKING_LEVELS, thinkingLevelMap } from './models.js';
import { CodeArtsSession } from './session.js';
import { createCodeArtsShim } from './shim.js';

/** Provider route this bundle owns. */
export const PROVIDER = 'codearts';

/** Cordis plugin identity. */
export const name = 'llm-codearts';

/** The LLM seam this plugin registers into. */
export const inject = ['llm'];

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const REQUEST_IMAGE_BUDGETS = {
	// pi-ai must not reject a multi-image turn before the shim sees it, so the
	// total stays at the seam default; the shim enforces the real gateway
	// ceiling per request and degrades images when the body would exceed it.
	maxRequestImageBytes: 20 * 1024 * 1024,
	requestImagePixelBudget: 2 * 1024 * 1024,
	requestImageMaxBytes: 512 * 1024
};

/** The shim authenticates only through `resolveApiKey`; pi-ai's ambient
 * credential lifecycle must never manufacture a credential for this route. */
const INERT_AUTH = {
	credentials: {
		async read() {
			return undefined;
		},
		async list() {
			return [];
		},
		async modify() {
			throw new Error('dsh-codearts-connect: the codearts route has no pi-ai credential lifecycle');
		},
		async delete() {}
	},
	authContext: {
		async env() {
			return undefined;
		},
		async fileExists() {
			return false;
		}
	}
};

// The published catalogue lives in ./models.js so the operator CLI can load it
// without the pi-ai / dsh peer dependencies this module needs.
//
// CodeArts retires models without notice (2026-11 dropped Qwen3-VL-235B,
// Kimi-K2.6-VL and the inline-completion coder). Run `node bin.js probe` after an
// app upgrade to see which entries are still routable.

const MODEL_SCHEMA = z.object({
	id: z.string().required().description('CodeArts model id'),
	name: z.string().description('Display name in the model picker'),
	contextWindow: z.natural().default(202_752).description('Context window in tokens'),
	maxTokens: z.natural().default(65_536).description('Maximum output tokens per turn; must stay within the CodeArts gateway limit'),
	supportsImages: z.boolean().default(true).description('Whether the model accepts image input'),
	reasoningEfforts: z
		.union([
			// 简写：级别名即线上值
			z.array(z.union(THINKING_LEVELS)),
			// 完整形式：级别 → reasoning_effort 实际值；null 表示该模型不支持这一级
			z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS))
		])
		.default(REASONING_EFFORTS)
		.description('Thinking levels to advertise (list, or level→reasoning_effort map with null for unsupported)')
});

export const Config = z.object({
	sessionFile: z.string().default('').description('CodeArts session document (defaults to $DSH_HOME/.codearts-session.json)'),
	models: z.array(MODEL_SCHEMA).default(DEFAULT_MODELS).description('CodeArts models to publish'),
	visionModel: z.string().default(DEFAULT_VISION_MODEL).description('CodeArts multimodal model used for image turns on text-only models; empty degrades images to a text note'),
	maxRequestBytes: z.natural().default(8 * 1024 * 1024).description('Largest upstream request body the shim will send; image turns above it degrade to text'),
	streamIdleTimeoutMs: z.natural().default(300_000).description('Idle ceiling for one upstream stream read')
});


/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(entry, baseUrl) {
	return {
		id: entry.id,
		name: entry.name || entry.id,
		api: 'openai-completions',
		provider: PROVIDER,
		baseUrl,
		input: entry.supportsImages ? ['text', 'image'] : ['text'],
		reasoning: true,
		thinkingLevelMap: thinkingLevelMap(entry.reasoningEfforts),
		cost: NO_COST,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: { maxTokensField: 'max_tokens' }
	};
}

/**
 * Start the shim and register the CodeArts route.
 *
 * @param ctx - cordis context carrying the `llm` service.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
	const sessionFile = config.sessionFile || join(resolveDshHome(), '.codearts-session.json');
	const importScript = fileURLToPath(new URL('../scripts/read-session.py', import.meta.url));
	const session = new CodeArtsSession({ sessionFile, importScript, logger: ctx.logger });
	const models = config.models.map((entry) => ({
		...entry,
		name: entry.name || entry.id
	}));
	const shim = createCodeArtsShim({
		session,
		models,
		logger: ctx.logger,
		visionModel: config.visionModel,
		maxRequestBytes: config.maxRequestBytes
	});
	let disposed = false;

	ctx.effect(() => () => {
		disposed = true;
		void shim.close();
	});

	shim.ready
		.then(() => {
			if (disposed) return;
			const baseUrl = `${shim.baseUrl()}/v1`;
			const piModels = models.map((entry) => toPiModel(entry, baseUrl));
			const piProvider = {
				...createProvider({
					id: PROVIDER,
					name: 'CodeArts Agent（码道）',
					auth: {
						apiKey: {
							name: 'CodeArts loopback bearer',
							async resolve() {
								return { auth: { apiKey: shim.token() }, source: 'CodeArts Agent' };
							}
						}
					},
					models: piModels,
					api: openAICompletionsApi()
				}),
				getModels: () => piModels
			};
			const profile = {
				provider: PROVIDER,
				displayName: 'CodeArts Agent（码道）',
				streamIdleTimeoutMs: config.streamIdleTimeoutMs,
				retryPolicy: resolveRetryPolicy(undefined, 'dsh-codearts-connect retryPolicy'),
				configuredMaxTokens: new Map(),
				modelErrors: new Map(),
				...REQUEST_IMAGE_BUDGETS,
				piProvider
			};
			const adapter = new PiAiAdapter({
				profiles: () => new Map([[PROVIDER, profile]]),
				auth: INERT_AUTH,
				resolveApiKey: async () => shim.token(),
				resolveAttachments: () => ctx.get('attachments'),
				resolveImageAccess: (attachments, ref) =>
					resolveImageAttachmentAccess(
						attachments,
						(hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
						ref
					)
			});
			const release = ctx.llm.registerAdapter([PROVIDER], adapter);
			ctx.effect(() => () => release());
			ctx.emit('llm/adapters-updated');
			ctx.logger.info(`dsh-codearts-connect: registered ${PROVIDER} (${models.map((model) => model.id).join(', ')}) on ${baseUrl}`);

			// Follow the app's signed-in account at startup. Without this the
			// plugin keeps answering with the previous account's still-valid
			// AK/SK until those credentials expire, which is confusing after a
			// switch. Cheap: one indexed read of the app's state database, and a
			// Python/DPAPI read only when the account actually changed.
			void (async () => {
				try {
					const appAccount = await session.appAccountId();
					const pluginAccount = session.data.account_id;
					await session.ensureCredentials();
					if (appAccount !== undefined && appAccount !== pluginAccount) {
						ctx.logger.info(`dsh-codearts-connect: codearts account switched ${pluginAccount} → ${appAccount}; using the app session`);
					} else if (appAccount !== undefined) {
						ctx.logger.info(`dsh-codearts-connect: codearts account ${appAccount} matches the app session`);
					}
				} catch (error) {
					ctx.logger.warn(`dsh-codearts-connect: could not reconcile the codearts account: ${error instanceof Error ? error.message : String(error)}`);
				}
			})();
		})
		.catch((error) => {
			ctx.logger.error('dsh-codearts-connect: loopback endpoint failed to start', error);
		});
}

export { DEFAULT_MODELS, REQUEST_IMAGE_BUDGETS };
