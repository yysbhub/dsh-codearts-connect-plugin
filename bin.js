#!/usr/bin/env node
/**
 * Small operator CLI for dsh-codearts-connect.
 *
 *   dsh-codearts-connect login          import the CodeArts app login and refresh it
 *   dsh-codearts-connect import <file>  adopt an existing session document
 *   dsh-codearts-connect status         print the current session status and the app's account
 *   dsh-codearts-connect sync           adopt the account the app is signed in as now
 *   dsh-codearts-connect models         print the CodeArts model catalogue this account can use
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodeArtsSession } from './lib/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const defaultSessionFile = join(dshHome, '.codearts-session.json');
const readScript = join(here, 'scripts', 'read-session.py');

function python() {
	return process.env.DSH_CODEARTS_PYTHON || process.env.PYTHON || 'python';
}

function sessionFileFrom(args) {
	const at = args.indexOf('--session');
	return at >= 0 && args[at + 1] ? resolve(args[at + 1]) : defaultSessionFile;
}

async function login(file) {
	const output = execFileSync(python(), [readScript], {
		encoding: 'utf8',
		timeout: 30_000,
		windowsHide: true
	});
	const document = JSON.parse(output);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(document, null, 2), { mode: 0o600 });
	const session = new CodeArtsSession({ sessionFile: file });
	// `login` is an explicit operator action, so rotating the refresh token here
	// is expected. The plugin's runtime path never calls this.
	const ok = await session.rotateRefreshToken();
	console.log(JSON.stringify(session.status(), null, 2));
	if (!ok) {
		console.error('refresh failed; open the CodeArts Agent and sign in again, then rerun login');
		process.exitCode = 1;
	}
}

async function adopt(file, source) {
	const document = JSON.parse(readFileSync(source, 'utf8'));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(document, null, 2), { mode: 0o600 });
	const session = new CodeArtsSession({ sessionFile: file });
	const ok = await session.rotateRefreshToken();
	console.log(JSON.stringify(session.status(), null, 2));
	if (!ok) process.exitCode = 1;
}

async function status(file) {
	const session = new CodeArtsSession({ sessionFile: file });
	const appAccount = await session.appAccountId();
	const report = session.status();
	console.log(JSON.stringify({ ...report, appAccount }, null, 2));
	if (appAccount !== undefined && appAccount !== report.account) {
		console.error(`提示: 码道当前登录的是 ${appAccount}，插件记录的是 ${report.account}；运行 sync（或直接用插件请求一次）即可切换。`);
	}
}

/**
 * Adopt whatever account the CodeArts app is signed in as right now.
 *
 * Unlike `login` this never rotates the refresh token: it only re-reads the
 * app's own session, which the plugin also does automatically at request time.
 * Exists so the switch can be forced from the CLI without waiting for a request.
 */
async function sync(file) {
	const session = new CodeArtsSession({ sessionFile: file });
	const before = session.data.account_id;
	const credentials = await session.ensureCredentials();
	const appAccount = await session.appAccountId();
	console.log(JSON.stringify({ ...session.status(), appAccount, previousAccount: before }, null, 2));
	if (!credentials) {
		console.error(session.lastError ?? '未能读取码道登录态');
		process.exitCode = 1;
		return;
	}
	if (before !== undefined && session.data.account_id !== before) {
		console.log(`已切换账号: ${before} → ${session.data.account_id}`);
	}
}

async function models() {
	// The catalogue lives in the desktop app's cached state, so this needs no
	// CodeArts session of its own — only the app having been started once.
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const execFileAsync = promisify(execFile);
	const script = join(here, 'scripts', 'read-models.py');
	const { stdout } = await execFileAsync(process.env.DSH_CODEARTS_PYTHON ?? process.env.PYTHON ?? 'python', [script], {
		encoding: 'utf8',
		timeout: 60_000,
		windowsHide: true,
		maxBuffer: 8 * 1024 * 1024
	});
	console.log(stdout.trim());
}

/**
 * Probe every published model against the live gateway.
 *
 * CodeArts retires models without notice and the app's cached catalogue keeps
 * listing them; only a real request tells you what still routes. Each model gets
 * one minimal signed turn, so the whole sweep costs a few hundred tokens.
 */
async function probe(file) {
	const { CHAT_URL, CodeArtsSession: SessionClass } = await import('./lib/session.js');
	const { DEFAULT_MODELS, DEFAULT_VISION_MODEL } = await import('./lib/models.js');
	const session = new SessionClass({ sessionFile: file });
	if (!(await session.ensureCredentials())) {
		console.error(session.lastError ?? 'CodeArts 登录已失效');
		process.exitCode = 1;
		return;
	}

	const sessionId = `ses_probe${Math.random().toString(16).slice(2, 12)}`;
	const trace = () => Math.random().toString(16).slice(2).padEnd(32, '0');
	const headers = (model) => ({
		'Content-Type': 'application/json',
		Accept: 'text/event-stream',
		'x-ot-trace-id': trace(),
		'x-ot-span-id': trace().slice(0, 16),
		'x-snap-traceid': `${trace()}_${trace().slice(0, 16)}`,
		'x-ot-session-id': sessionId,
		'x-ot-parent-session-id': '',
		'user-session-id': sessionId,
		'x-ot-function': 'agent-claw',
		'X-Language': 'zh-cn',
		'user-msg-id': `msg_${Math.random().toString(16).slice(2, 14)}`,
		'created-time': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
		'model-id': model,
		'model-name': model,
		'x-ot-client-type': 'IDE',
		'x-ot-client-version': '26.9.901',
		'plugin-name': 'codemate_vscode',
		'plugin-version': '26.9.901',
		'ide-name': 'VSCode',
		'ide-version': '26.9.901',
		'client-ip': '127.0.0.1',
		is_confidential: 'false'
	});

	// "无权调用" / "not registered" mean the model is gone or guarded for good;
	// rate limits and timeouts are transient and must not be reported as retired.
	const PERMANENT = /无权|未开通|not registered|not found|不支持|invalid model/i;
	const TRANSIENT = /rate limit|too many requests|请稍后|稍后重试|timeout|busy|throttl/i;

	async function check(model, reasoningEffort) {
		const body = JSON.stringify({
			model,
			stream: true,
			max_tokens: 16,
			messages: [{ role: 'user', content: '回复：OK' }],
			...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort })
		});
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			try {
				const response = await session.request('POST', CHAT_URL, headers(model), body);
				const text = await response.text();
				const error = text.match(/"error_msg":"([^"]+)"/)?.[1];
				if (error === undefined) return { state: 'OK', detail: 'routable' };
				if (PERMANENT.test(error)) return { state: 'DEAD', detail: error.slice(0, 60) };
				if (TRANSIENT.test(error) && attempt < 4) {
					await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
					continue;
				}
				return { state: TRANSIENT.test(error) ? 'THROTTLED' : 'ERROR', detail: error.slice(0, 60) };
			} catch (error) {
				if (attempt === 4) return { state: 'ERROR', detail: `network: ${error.message}` };
				await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
			}
		}
	}

	/** Declared thinking levels as [level, wireValue] pairs. */
	function declaredEfforts(entry) {
		const declared = entry.reasoningEfforts;
		if (Array.isArray(declared)) return declared.map((level) => [level, level]);
		if (!declared || typeof declared !== 'object') return [];
		return Object.entries(declared).filter(([, wire]) => typeof wire === 'string' && wire !== '');
	}

	const live = [];
	const dead = [];
	const other = [];
	for (const model of DEFAULT_MODELS) {
		const result = await check(model.id);
		const tag = { OK: ' OK ', DEAD: 'DEAD', THROTTLED: 'THRT', ERROR: 'ERR ' }[result.state];
		console.log(`${tag}  ${model.id.padEnd(28)} ${result.detail}`);
		if (result.state === 'OK') live.push(model.id);
		else if (result.state === 'DEAD') dead.push(model.id);
		else other.push(`${model.id}(${result.state})`);
	}

	// Second pass: the declared thinking levels are part of the contract too —
	// a gateway that stops accepting a value turns the picker into a trap.
	console.log('\n思考级别验收:');
	const badEfforts = [];
	for (const model of DEFAULT_MODELS) {
		const levels = declaredEfforts(model);
		if (levels.length === 0) continue;
		const rejected = [];
		for (const [level, wire] of levels) {
			const result = await check(model.id, wire);
			if (result.state !== 'OK') rejected.push(`${level}→${wire} ${result.state === 'DEAD' ? '拒绝' : result.detail}`);
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		if (rejected.length === 0) {
			console.log(`  OK   ${model.id.padEnd(28)} ${levels.map(([level]) => level).join('/')}`);
		} else {
			console.log(`  注意 ${model.id.padEnd(28)} 不接受 ${rejected.join('; ')}`);
			badEfforts.push(`${model.id}: ${rejected.map((entry) => entry.split(' ')[0]).join(', ')}`);
		}
	}

	console.log(`\n可用 ${live.length} / ${DEFAULT_MODELS.length}`);
	if (other.length > 0) console.log(`限流/网络原因未判定（可稍后重跑）: ${other.join(', ')}`);
	if (badEfforts.length > 0) {
		console.log(`思考级别需修正: ${badEfforts.join(' | ')}`);
		console.log('把对应级别在 lib/models.js 的 reasoningEfforts 里改成 null（或删掉该键）。');
	}
	if (dead.length === 0 && badEfforts.length === 0) return;
	if (dead.length === 0) return;
	console.log(`已下线或无权限: ${dead.join(', ')}`);
	console.log('\n把这些 id 从 lib/models.js 的 DEFAULT_MODELS 里删掉后重新打包即可。');
	process.exitCode = 1;
}

const [, , command = 'status', ...rest] = process.argv;
const file = sessionFileFrom(rest);

if (command === 'login') await login(file);
else if (command === 'import') {
	const source = rest.find((arg) => !arg.startsWith('--'));
	if (source === undefined) {
		console.error('usage: dsh-codearts-connect import <session.json>');
		process.exitCode = 2;
	} else await adopt(file, resolve(source));
} else if (command === 'status') await status(file);
else if (command === 'sync') await sync(file);
else if (command === 'models') await models();
else if (command === 'probe') await probe(file);
else {
	console.error('usage: dsh-codearts-connect <login|import <file>|status|sync|models|probe> [--session <file>]');
	process.exitCode = 2;
}
