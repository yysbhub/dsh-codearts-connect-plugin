/**
 * Loopback OpenAI-compatible endpoint backed by the CodeArts gateway.
 *
 * pi-ai speaks OpenAI Chat Completions; CodeArts speaks the same shape but
 * requires its own signing, heartbeat, role normalisation, and always streams.
 * This shim bridges the two and is reachable only on 127.0.0.1 with a
 * per-process bearer token.
 *
 * @module dsh-codearts-connect/shim
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { CHAT_URL, CodeArtsSession } from './session.js';

/**
 * Largest `max_tokens` the CodeArts gateway accepts.
 *
 * Above this the gateway returns `InferHub.001001005.400` ("The request param
 * is invalid") as an SSE frame with HTTP 200 — a failure pi-ai cannot read as a
 * finish_reason. Clamp every request to this value.
 */
const MAX_UPSTREAM_TOKENS = 65_536;

const SESSION_ID_PREFIX = 'ses_';

function randomSessionId() {
	const digest = createHash('sha256')
		.update(`codearts:${process.env.USERNAME ?? 'user'}:${randomBytes(8).toString('hex')}`)
		.digest('hex');
	return `${SESSION_ID_PREFIX}${digest.slice(0, 26)}`;
}

/** Flatten the message shapes DSH/OpenAI produce into what CodeArts accepts. */
export function normalizeMessages(messages) {
	const normalized = [];
	if (!Array.isArray(messages)) return normalized;
	for (const message of messages) {
		if (message === null || typeof message !== 'object') continue;
		let role = String(message.role ?? '').trim();
		if (role === 'developer') role = 'system';
		if (!['system', 'user', 'assistant', 'tool'].includes(role)) continue;
		const content = normalizeContent(message.content, role === 'system');
		const item = { role, content };
		if (message.name) item.name = message.name;
		if (role === 'assistant' && message.tool_calls) item.tool_calls = message.tool_calls;
		if (role === 'tool' && message.tool_call_id) item.tool_call_id = message.tool_call_id;
		normalized.push(item);
	}
	return normalized;
}

/** Convert one OpenAI/pi-ai content value, keeping image parts when present. */
function normalizeContent(content, textOnly) {
	if (!Array.isArray(content)) {
		if (content === null || content === undefined) return '';
		return content;
	}
	const parts = [];
	for (const part of content) {
		if (typeof part === 'string') {
			parts.push({ type: 'text', text: part });
			continue;
		}
		if (part === null || typeof part !== 'object') continue;
		if (part.type === 'text' && typeof part.text === 'string') {
			parts.push({ type: 'text', text: part.text });
			continue;
		}
		if (textOnly) continue;
		if (part.type === 'image_url' && part.image_url) {
			parts.push({ type: 'image_url', image_url: part.image_url });
			continue;
		}
		if (part.type === 'image' && typeof part.data === 'string') {
			parts.push({
				type: 'image_url',
				image_url: { url: `data:${part.mimeType ?? 'image/png'};base64,${part.data}` }
			});
		}
	}
	if (parts.length === 0) return '';
	if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
	return parts;
}

function messageHasImage(message) {
	return Array.isArray(message.content) && message.content.some((part) => part?.type === 'image_url');
}

function replaceImagesWithText(messages, note) {
	return messages.map((message) => {
		if (!Array.isArray(message.content)) return message;
		const content = message.content.map((part) =>
			part.type === 'image_url' ? { type: 'text', text: note } : part
		);
		return { ...message, content };
	});
}

/**
 * Build the upstream request body.
 *
 * Image handling has three cases:
 *   1. the model itself is multimodal (per configuration) → keep the images and
 *      send them to that same model;
 *   2. the model is text-only → route the turn to the configured vision model;
 *   3. no vision model, or the caller asked to degrade → replace images with a
 *      text note instead of failing the whole turn.
 */
export function buildUpstreamBody(request, modelId, options = {}) {
	const messages = normalizeMessages(request.messages);
	const hasImage = messages.some(messageHasImage);
	let upstreamModel = modelId;
	let outbound = messages;
	if (hasImage && options.degradeImages) {
		outbound = replaceImagesWithText(messages, options.degradeNote ?? '[图片已省略：请求体超过码道网关大小限制]');
	} else if (hasImage && options.supportsImages) {
		// Nothing to do: this model reads images itself.
	} else if (hasImage && options.visionModel) {
		upstreamModel = options.visionModel;
	} else if (hasImage) {
		outbound = replaceImagesWithText(messages, '[图片已省略：当前码道模型不支持图片输入]');
	}
	const body = { model: upstreamModel, stream: true, messages: outbound };
	const passthrough = [
		'temperature',
		'top_p',
		'stop',
		'tools',
		'tool_choice',
		'parallel_tool_calls',
		'response_format',
		'reasoning_effort',
		'presence_penalty',
		'frequency_penalty',
		'seed',
		'user'
	];
	for (const key of passthrough) {
		if (request[key] !== undefined && request[key] !== null) body[key] = request[key];
	}
	// The gateway rejects an out-of-range `max_tokens` with an in-stream
	// `InferHub.001001005.400`, which pi-ai cannot translate. Clamp whatever
	// DSH asks for to the largest value the gateway accepts (probe-verified).
	const requestedMaxTokens = request.max_tokens ?? request.max_completion_tokens;
	if (typeof requestedMaxTokens === 'number' && Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0) {
		body.max_tokens = Math.min(Math.trunc(requestedMaxTokens), MAX_UPSTREAM_TOKENS);
	}
	if (Array.isArray(body.tools) && body.tools.length > 0) body.tool_stream = true;
	return { body, upstreamModel, hasImage };
}

/** Yield `data:` payloads from a fetch Response carrying SSE. */
async function* ssePayloads(response) {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const index = buffer.indexOf('\n');
				if (index < 0) break;
				let line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.endsWith('\r')) line = line.slice(0, -1);
				if (line.startsWith('data:')) yield line.slice(5).trim();
			}
		}
		if (buffer.startsWith('data:')) yield buffer.slice(5).trim();
	} finally {
		reader.releaseLock();
	}
}

/** Replay already-consumed payloads in front of the rest of a stream. */
async function* withPrefix(prefix, iterable) {
	for (const item of prefix) yield item;
	yield* iterable;
}

function writeJson(response, status, payload) {
	const data = Buffer.from(JSON.stringify(payload));
	response.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': String(data.length)
	});
	response.end(data);
}

function writeError(response, status, kind, message) {
	writeJson(response, status, { error: { message, type: kind } });
}

function isLoopbackHost(host) {
	if (typeof host !== 'string') return false;
	const [name] = host.split(':');
	return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function isLoopbackOrigin(origin) {
	if (origin === undefined) return true;
	try {
		const url = new URL(origin);
		return isLoopbackHost(url.host);
	} catch {
		return false;
	}
}

/** Read a request body with a hard ceiling. */
async function readBody(request, limit = 64 * 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > limit) throw new Error('request body too large');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

export function createCodeArtsShim(options) {
	const { session, models, logger } = options;
	const token = options.token ?? randomBytes(24).toString('hex');
	const sessionId = options.sessionId ?? randomSessionId();
	const maxRequestBytes = options.maxRequestBytes ?? 8 * 1024 * 1024;

	function gatewayHeaders(upstreamModel) {
		const headers = {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			'x-ot-trace-id': randomBytes(16).toString('hex'),
			'x-ot-span-id': randomBytes(8).toString('hex'),
			'x-snap-traceid': `${randomBytes(16).toString('hex')}_${randomBytes(8).toString('hex')}`,
			'x-ot-session-id': sessionId,
			'x-ot-parent-session-id': '',
			'user-session-id': sessionId,
			'x-ot-function': 'agent-claw',
			'X-Language': 'zh-cn',
			'user-msg-id': `msg_${randomBytes(6).toString('hex')}`,
			'created-time': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
			'model-id': upstreamModel,
			'model-name': upstreamModel,
			'x-ot-client-type': 'IDE',
			'x-ot-client-version': '26.9.901',
			'plugin-name': 'codemate_vscode',
			'plugin-version': '26.9.901',
			'ide-name': 'VSCode',
			'ide-version': '26.9.901',
			'client-ip': '127.0.0.1',
			is_confidential: 'false'
		};
		return headers;
	}
	const server = createServer(async (request, response) => {
		const origin = request.headers.origin;
		if (!isLoopbackHost(request.headers.host) || !isLoopbackOrigin(origin)) {
			writeError(response, 403, 'host_not_allowed', 'Host/Origin must name the loopback interface');
			return;
		}
		if ((request.headers.authorization ?? '') !== `Bearer ${token}`) {
			writeError(response, 401, 'unauthorized', 'missing or invalid bearer token');
			return;
		}
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		try {
			if (request.method === 'GET' && url.pathname === '/v1/models') {
				writeJson(response, 200, {
					object: 'list',
					data: models.map((model) => ({
						id: model.id,
						object: 'model',
						created: 0,
						owned_by: 'codearts',
						name: model.name,
						context_window: model.contextWindow
					}))
				});
				return;
			}
			if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
				await handleChat(request, response);
				return;
			}
			writeError(response, 404, 'not_found', `no such route: ${request.method} ${url.pathname}`);
		} catch (error) {
			logger?.warn?.(`codearts shim request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
			if (!response.headersSent) writeError(response, 500, 'internal', error instanceof Error ? error.message : String(error));
			else response.destroy();
		}
	});

	async function handleChat(request, response) {
		const raw = await readBody(request);
		let payload;
		try {
			payload = JSON.parse(raw);
		} catch {
			writeError(response, 400, 'invalid_json', 'invalid JSON body');
			return;
		}
		const requestedModel = String(payload.model ?? models[0]?.id ?? 'glm-5.3').split('/').pop();
		const model = models.find((entry) => entry.id === requestedModel) ?? models[0];
		if (model === undefined) {
			writeError(response, 400, 'unknown_model', `no such model: ${requestedModel}`);
			return;
		}
		// A multimodal model reads images itself; only text-only models need the
		// vision-model detour.
		const buildOptions = {
			visionModel: options.visionModel,
			supportsImages: model.supportsImages === true
		};
		let built = buildUpstreamBody(payload, model.id, buildOptions);
		let rawBody = JSON.stringify(built.body);
		let upstreamModel = built.upstreamModel;
		let degraded = false;
		const wantsStream = payload.stream === true;
		if (built.hasImage && upstreamModel !== model.id) {
			logger?.info?.(`codearts: routing an image turn from ${model.id} to vision model ${upstreamModel}`);
		}

		// APIG rejects oversized bodies with an opaque 413. Keep image turns
		// under the bridge ceiling by dropping images to a text note first.
		if (built.hasImage && Buffer.byteLength(rawBody) > maxRequestBytes) {
			logger?.warn?.(`codearts: request is ${Buffer.byteLength(rawBody)} bytes, degrading images to text`);
			built = buildUpstreamBody(payload, model.id, { ...buildOptions, degradeImages: true });
			rawBody = JSON.stringify(built.body);
			upstreamModel = built.upstreamModel;
			degraded = true;
		}
		if (Buffer.byteLength(rawBody) > maxRequestBytes) {
			writeError(
				response,
				413,
				'request_too_large',
				`request body is ${Buffer.byteLength(rawBody)} bytes, above the bridge ceiling of ${maxRequestBytes} bytes; remove large attachments or start a new session`
			);
			return;
		}

		await session.heartbeat(sessionId, 'busy');
		const openUpstream = (body, modelForHeaders) =>
			session.request('POST', CHAT_URL, gatewayHeaders(modelForHeaders), body);
		let upstream;
		try {
			upstream = await openUpstream(rawBody, upstreamModel);
		} catch (error) {
			await session.heartbeat(sessionId, 'idle');
			writeError(response, 503, 'auth_unavailable', error instanceof Error ? error.message : String(error));
			return;
		}

		if (upstream.status === 413 && built.hasImage && !degraded) {
			await upstream.text().catch(() => '');
			upstream.body?.cancel?.().catch?.(() => {});
			logger?.warn?.('codearts: upstream 413, retrying this turn without images');
			built = buildUpstreamBody(payload, model.id, { ...buildOptions, degradeImages: true });
			rawBody = JSON.stringify(built.body);
			upstreamModel = built.upstreamModel;
			degraded = true;
			try {
				upstream = await openUpstream(rawBody, upstreamModel);
			} catch (error) {
				await session.heartbeat(sessionId, 'idle');
				writeError(response, 503, 'auth_unavailable', error instanceof Error ? error.message : String(error));
				return;
			}
		}

		try {
			if (!upstream.ok) {
				const detail = await upstream.text();
				writeError(response, upstream.status >= 400 ? upstream.status : 502, 'upstream_error', detail || upstream.statusText);
				return;
			}
			let payloads = ssePayloads(upstream);
			// A routed image turn depends on the vision model being callable for
			// this account. When it is not, the gateway still answers 200 and
			// reports the refusal as an in-stream error frame ("no permission"),
			// so peek the first frame and retry the turn with the images replaced
			// by a text note instead of failing it outright.
			if (built.hasImage && !degraded && upstreamModel !== model.id) {
				const first = await payloads.next();
				const failure = first.done ? undefined : inStreamError(first.value);
				if (failure === undefined) {
					payloads = withPrefix(first.done ? [] : [first.value], payloads);
				} else {
					logger?.warn?.(`codearts: vision model ${upstreamModel} refused the image turn (${failure}); retrying without images`);
					await upstream.body?.cancel?.().catch?.(() => {});
					built = buildUpstreamBody(payload, model.id, {
						...buildOptions,
						degradeImages: true,
						degradeNote: `[图片已省略：视觉模型 ${upstreamModel} 当前不可用]`
					});
					rawBody = JSON.stringify(built.body);
					upstreamModel = built.upstreamModel;
					degraded = true;
					upstream = await openUpstream(rawBody, upstreamModel);
					if (!upstream.ok) {
						const detail = await upstream.text();
						writeError(response, upstream.status >= 400 ? upstream.status : 502, 'upstream_error', detail || upstream.statusText);
						return;
					}
					payloads = ssePayloads(upstream);
				}
			}
			if (wantsStream) await relayStream(payloads, response, model.id);
			else await relayAggregate(payloads, response, model.id);
		} finally {
			upstream.body?.cancel?.().catch?.(() => {});
			await session.heartbeat(sessionId, 'idle');
		}
	}

/**
 * Detect the gateway's in-stream error envelope.
 *
 * CodeArts reports real failures as an SSE `data:` frame with HTTP 200, shaped
 * `{"text":"[DONE]","error_code":..., "error_msg":...}`. pi-ai treats it as a
 * normal chunk, sees no `finish_reason`, and reports the opaque
 * "Stream ended without finish_reason". Surface the actual reason instead.
 */function inStreamError(payload) {
	if (payload === '[DONE]' || !payload.startsWith('{')) return undefined;
	try {
		const frame = JSON.parse(payload);
		if (frame.error_code === undefined && frame.error_msg === undefined) return undefined;
		const detail = String(frame.error_msg ?? frame.error_code);
		return `${detail}${frame.request_id ? ` (request ${frame.request_id})` : ''} [${frame.error_code ?? 'unknown'}]`;
	} catch {
		return undefined;
	}
}

	async function relayStream(payloads, response, modelId) {
		response.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache',
			Connection: 'close',
			'X-Accel-Buffering': 'no'
		});
		response.flushHeaders();
		let sawFinish = false;
		let lastId = '';
		let lastCreated = Math.floor(Date.now() / 1000);
		let inStreamFailure;
		for await (const payload of payloads) {
			const failure = inStreamError(payload);
			if (failure !== undefined) {
				inStreamFailure = failure;
				logger?.warn?.(`codearts: stream error: ${failure}`);
				break;
			}
			if (payload === '[DONE]') {
				if (!sawFinish) {
					const synthetic = {
						id: lastId || 'chatcmpl-codearts',
						object: 'chat.completion.chunk',
						created: lastCreated,
						model: modelId,
						choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
					};
					response.write(`data: ${JSON.stringify(synthetic)}\n\n`);
				}
				response.write('data: [DONE]\n\n');
				response.end();
				return;
			}
			try {
				const chunk = JSON.parse(payload);
				lastId = String(chunk.id ?? lastId);
				if (Number.isFinite(chunk.created)) lastCreated = chunk.created;
				if (Array.isArray(chunk.choices) && chunk.choices.some((choice) => choice?.finish_reason)) sawFinish = true;
			} catch {
				// Forward malformed payloads verbatim; pi-ai decides what to do.
			}
			response.write(`data: ${payload}\n\n`);
		}
		// The stream ended without a finish_reason. Inject one so DSH does not
		// fail the turn with an opaque TRANSPORT error; when the gateway told us
		// why, carry that message through the same finish chunk.
		const synthetic = {
			id: lastId || 'chatcmpl-codearts',
			object: 'chat.completion.chunk',
			created: lastCreated,
			model: modelId,
			choices: [{
				index: 0,
				delta: {},
				finish_reason: inStreamFailure === undefined ? 'stop' : 'error'
			}]
		};
		if (inStreamFailure !== undefined) response.setHeader('x-codearts-error', inStreamFailure);
		response.write(`data: ${JSON.stringify(synthetic)}\n\n`);
		response.write('data: [DONE]\n\n');
		response.end();
	}

	async function relayAggregate(payloads, response, modelId) {
		const content = [];
		const reasoning = [];
		const toolCalls = new Map();
		let finishReason = 'stop';
		let id = '';
		let created = Math.floor(Date.now() / 1000);
		let usage;
		let inStreamFailure;
		for await (const payload of payloads) {
			if (payload === '[DONE]') break;
			const failure = inStreamError(payload);
			if (failure !== undefined) {
				inStreamFailure = failure;
				logger?.warn?.(`codearts: stream error: ${failure}`);
				break;
			}
			let chunk;
			try {
				chunk = JSON.parse(payload);
			} catch {
				continue;
			}
			id = String(chunk.id ?? id);
			if (Number.isFinite(chunk.created)) created = chunk.created;
			if (chunk.usage) usage = chunk.usage;
			for (const choice of chunk.choices ?? []) {
				const delta = choice?.delta ?? {};
				if (choice?.finish_reason) finishReason = choice.finish_reason;
				if (delta.content) content.push(String(delta.content));
				if (delta.reasoning_content) reasoning.push(String(delta.reasoning_content));
				for (const call of delta.tool_calls ?? []) {
					const index = Number(call.index ?? 0);
					const slot = toolCalls.get(index) ?? { id: call.id ?? '', type: 'function', function: { name: '', arguments: '' } };
					if (call.id) slot.id = call.id;
					if (call.function?.name) slot.function.name += String(call.function.name);
					if (call.function?.arguments) slot.function.arguments += String(call.function.arguments);
					toolCalls.set(index, slot);
				}
			}
		}
		const message = { role: 'assistant', content: content.join('') };
		if (reasoning.length > 0) message.reasoning_content = reasoning.join('');
		if (toolCalls.size > 0) {
			message.tool_calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
			if (message.content === '') message.content = null;
		}
		const result = {
			id: id || 'chatcmpl-codearts',
			object: 'chat.completion',
			created,
			model: modelId,
			choices: [{ index: 0, message, finish_reason: inStreamFailure === undefined ? finishReason : 'error' }]
		};
		if (usage) result.usage = usage;
		if (inStreamFailure !== undefined) {
			message.content = message.content ?? '';
			message.content = inStreamFailure;
		}
		writeJson(response, inStreamFailure === undefined ? 200 : 502, inStreamFailure === undefined ? result : {
			error: { message: inStreamFailure, type: 'upstream_error' }
		});
	}

	const ready = new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});

	return {
		ready,
		token: () => token,
		sessionId,
		baseUrl: () => {
			const address = server.address();
			if (address === null || typeof address === 'string') throw new Error('codearts shim is not listening');
			return `http://127.0.0.1:${address.port}`;
		},
		close: () => new Promise((resolve) => server.close(() => resolve()))
	};
}
