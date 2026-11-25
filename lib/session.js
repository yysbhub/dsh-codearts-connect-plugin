/**
 * CodeArts Agent (码道) session, token refresh, and request signing.
 *
 * The CodeArts desktop app authenticates against Huawei Cloud STS with a
 * DPoP-bound OAuth refresh token, then signs every model request with
 * `SDK-HMAC-SHA256`. This module owns that lifecycle for the plugin: it reads
 * a small session document (written by `dsh-codearts-connect login`), rotates
 * the one-time refresh token, and signs gateway requests.
 *
 * @module dsh-codearts-connect/session
 */

import { createHash, createHmac, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const STS_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
export const GATEWAY = 'https://snap-access.cn-north-4.myhuaweicloud.com';
export const CHAT_URL = `${GATEWAY}/api/v2/chat/completions`;
export const CLIENT_ID = 'codearts-agent';

/** Refresh this long before the STS credentials expire. */
const REFRESH_SKEW_MS = 180_000;

/** Where the CodeArts app caches its signed-in account and session state. */
const STATE_DB_PATH = typeof process.env.APPDATA === 'string' && process.env.APPDATA !== ''
	? join(process.env.APPDATA, 'codearts-agent', 'User', 'globalStorage', 'state.vscdb')
	: '';

/** How long a probed app account id stays valid before re-reading the database. */
const APP_ACCOUNT_TTL_MS = 60_000;

/** RFC 3986 escaping, matching Huawei's signer (`~` stays literal). */
function escape(value) {
	return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(pathname) {
	const uri = pathname.split('/').map(escape).join('/');
	return uri.endsWith('/') ? uri : `${uri}/`;
}

function canonicalQuery(search) {
	if (!search) return '';
	const params = [...new URLSearchParams(search).entries()];
	params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return params.map(([key, value]) => `${escape(key)}=${escape(value)}`).join('&');
}

function parseExpiry(value) {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000;
	const parsed = Date.parse(String(value));
	return Number.isFinite(parsed) ? parsed : undefined;
}

function base64url(value) {
	return Buffer.from(value).toString('base64url');
}

/** Build an ES256 DPoP proof for one token-endpoint call. */
function dpopProof(dpop, method, url) {
	if (!dpop?.privateKeyJwk || !dpop?.publicKeyJwk) throw new Error('session has no DPoP key pair');
	const privateKey = createPrivateKey({ key: dpop.privateKeyJwk, format: 'jwk' });
	const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: dpop.publicKeyJwk };
	const claims = { htm: method, htu: url, iat: Math.floor(Date.now() / 1000), jti: randomUUID().replaceAll('-', '') };
	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
	const signature = sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
	return `${signingInput}.${base64url(signature)}`;
}

/**
 * A CodeArts session backed by one on-disk document.
 *
 * The document is deliberately the same shape the standalone bridge used, so
 * an existing `state.json` can be adopted by `dsh-codearts-connect import`.
 */
export class CodeArtsSession {
	constructor(options = {}) {
		if (!options.sessionFile) throw new Error('CodeArtsSession requires sessionFile');
		this.sessionFile = options.sessionFile;
		// Default to the script shipped beside this module. Callers may pass an
		// explicit path; an omitted one must still resolve, because the whole
		// adopt-only credential path depends on it.
		this.importScript = options.importScript ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'read-session.py');
		this.logger = options.logger;
		this.data = {};
		this.credentials = undefined;
		this.lastError = undefined;
		this.refreshing = undefined;
		/** Last app account id we read from the app's state database. */
		this.appAccount = undefined;
		this.appAccountProbedAt = 0;
		this.load();
	}

	load() {
		this.data = {};
		this.credentials = undefined;
		if (!this.sessionFile || !existsSync(this.sessionFile)) return;
		try {
			this.data = JSON.parse(readFileSync(this.sessionFile, 'utf8'));
			this.credentials = this.data.credentials;
		} catch (error) {
			this.logger?.warn?.(`codearts session file is unreadable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	save() {
		if (!this.sessionFile) return;
		mkdirSync(dirname(this.sessionFile), { recursive: true });
		const temporary = `${this.sessionFile}.tmp`;
		writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
		renameSync(temporary, this.sessionFile);
	}

	hasCredentials(credentials = this.credentials) {
		if (!credentials?.access_key_id || !credentials?.security_token) return false;
		const expiry = parseExpiry(credentials.expiration);
		return expiry === undefined || expiry > Date.now() + REFRESH_SKEW_MS;
	}

	/**
	 * Account id the CodeArts desktop app is currently signed in as.
	 *
	 * Read straight out of the app's Electron state database with `node:sqlite`:
	 * one indexed SELECT, no Python, no DPAPI. Cached briefly so the check can
	 * run on every request without measurable cost. `undefined` means "unknown"
	 * (app never started, database locked, …) — callers must treat that as
	 * "cannot tell", not as "different account".
	 */
	async appAccountId() {
		const now = Date.now();
		if (this.appAccount !== undefined && now - this.appAccountProbedAt < APP_ACCOUNT_TTL_MS) {
			return this.appAccount;
		}
		let id;
		try {
			// `node:sqlite` still emits an ExperimentalWarning on import; it is
			// noise for a plugin that only runs one indexed SELECT, so drop just
			// that one while the module loads.
			const originalEmitWarning = process.emitWarning;
			process.emitWarning = function emitWarningWithoutSqliteNotice(warning, ...rest) {
				const text = typeof warning === 'string' ? warning : warning?.message;
				if (/SQLite is an experimental feature/i.test(String(text ?? ''))) return undefined;
				return originalEmitWarning.call(process, warning, ...rest);
			};
			let DatabaseSync;
			try {
				({ DatabaseSync } = await import('node:sqlite'));
			} finally {
				process.emitWarning = originalEmitWarning;
			}
			const database = new DatabaseSync(STATE_DB_PATH, { readOnly: true });
			try {
				const row = database.prepare("SELECT value FROM ItemTable WHERE key = 'huaweicloud.codearts-snap'").get();
				if (row?.value) {
					const snapshot = JSON.parse(String(row.value));
					id = snapshot?.userInfoKey?.id ?? undefined;
				}
			} finally {
				database.close();
			}
		} catch {
			id = undefined;
		}
		this.appAccount = id;
		this.appAccountProbedAt = now;
		return id;
	}

	status() {
		return {
			ok: this.hasCredentials(),
			expiration: this.credentials?.expiration,
			account: this.data.account_id,
			appAccount: this.appAccount,
			hasRefreshToken: Boolean(this.data.refresh_token),
			lastError: this.lastError,
			sessionFile: this.sessionFile
		};
	}

	/** Replace the in-memory session with one parsed JSON document. */
	adopt(document) {
		this.data = { ...document };
		this.credentials = this.data.credentials;
		this.save();
	}

	/** Read the CodeArts app's DPAPI-protected login session, if present. */
	async importFromCodeArts(scriptPath) {
		if (!scriptPath || !existsSync(scriptPath)) return false;
		const python = process.env.DSH_CODEARTS_PYTHON ?? process.env.PYTHON ?? 'python';
		try {
			const { stdout } = await execFileAsync(python, [scriptPath], {
				encoding: 'utf8',
				timeout: 30_000,
				windowsHide: true,
				maxBuffer: 4 * 1024 * 1024
			});
			const parsed = JSON.parse(stdout);
			if (!parsed || typeof parsed !== 'object') return false;
			this.data = { ...this.data, ...parsed };
			if (parsed.credentials) this.credentials = parsed.credentials;
			this.save();
			return true;
		} catch (error) {
			this.logger?.warn?.(`could not read the CodeArts app session: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	/**
	 * Ensure a usable AK/SK pair for the account the app is signed in as.
	 *
	 * Never rotates the app's refresh token: that is what logs the desktop app
	 * out. Re-reads the app session instead, and only that.
	 *
	 * Re-reads when the credentials expired *or* when the app switched accounts:
	 * a still-valid AK/SK pair belongs to whoever it was issued to, so keeping it
	 * after an account switch silently answers from the previous tenant.
	 */
	async ensureCredentials() {
		// A cheap account probe first, so a switch is picked up without waiting
		// for the old credentials to expire.
		const appAccount = await this.appAccountId();
		const switched = appAccount !== undefined && appAccount !== this.data.account_id;
		if (this.hasCredentials() && !switched) return this.credentials;
		const previous = this.data.account_id;
		// First try without touching anything, then re-import and re-check.
		if (await this.importFromCodeArts(this.importScript) && this.hasCredentials()) {
			const adopted = this.data.account_id;
			if (previous !== undefined && adopted !== previous) {
				this.logger?.info?.(`codearts: account switched ${previous} → ${adopted}; adopted the app session`);
			} else if (switched) {
				this.logger?.info?.('codearts: adopted the app session after an account switch');
			} else {
				this.logger?.info?.('codearts: adopted the app session after expiry');
			}
			return this.credentials;
		}
		// Could not adopt a fresh session; a still-valid pair is better than
		// failing outright, but say so because it may answer as the old account.
		if (this.hasCredentials()) {
			this.logger?.warn?.(
				`codearts: could not read the app session${switched ? ` after an account switch (${previous} → ${appAccount})` : ''}; still using the credentials expiring ${this.credentials?.expiration}`
			);
			return this.credentials;
		}
		this.lastError ??= 'CodeArts 登录态已过期；请打开码道 Agent 重新登录一次';
		return undefined;
	}

	/** Rotate the one-time refresh token and persist the replacement first. */
	async refresh() {
		// The CodeArts refresh token is single-use. Rotating it here invalidates
		// the copy the desktop app still holds, which is what makes the app log
		// itself out. So: never rotate the app's token from the plugin.
		//
		// The plugin instead re-reads the app's session (which the app itself
		// refreshes) whenever its AK/SK expires. That keeps the app as the sole
		// owner of the token chain, and DSH simply follows along.
		if (this.refreshing) return this.refreshing;
		this.refreshing = (async () => {
			if (await this.importFromCodeArts(this.importScript)) {
				if (this.hasCredentials()) {
					this.logger?.info?.('codearts: adopted the app session; plugin does not rotate the refresh token');
					return true;
				}
			}
			this.lastError ??= 'CodeArts 登录态已过期；请打开码道 Agent 重新登录一次';
			return false;
		})().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	/** Legacy explicit refresh, kept for `bin.js login`. Rotates the token. */
	async rotateRefreshToken() {
		if (this.refreshing) return this.refreshing;
		this.refreshing = this.refreshOnce().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	async refreshOnce() {
		const refreshToken = this.data.refresh_token;
		const dpop = this.data.dpop;
		if (!refreshToken || !dpop?.privateKeyJwk) {
			this.lastError = '没有可用的 refresh token；请先打开码道 Agent 登录，或运行 dsh-codearts-connect login';
			return false;
		}
		const form = new URLSearchParams({
			client_id: CLIENT_ID,
			grant_type: 'refresh_token',
			refresh_token: refreshToken
		});
		if (this.data.code_verifier) form.set('code_verifier', this.data.code_verifier);
		const headers = {
			DPoP: dpopProof(dpop, 'POST', STS_URL),
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		};
		if (this.data.account_id) headers['x-agent-user-account'] = this.data.account_id;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30_000);
		try {
			const response = await fetch(STS_URL, {
				method: 'POST',
				headers,
				body: form,
				signal: controller.signal
			});
			const text = await response.text();
			if (!response.ok) {
				this.lastError = `STS refresh failed (${response.status}): ${text.slice(0, 500)}`;
				this.logger?.warn?.(this.lastError);
				return false;
			}
			const payload = JSON.parse(text);
			const credentials = payload.credentials;
			if (!credentials?.access_key_id || !credentials?.security_token) {
				this.lastError = 'STS refresh returned no credentials';
				return false;
			}
			this.credentials = credentials;
			this.data.credentials = credentials;
			if (payload.refresh_token) this.data.refresh_token = payload.refresh_token;
			this.data.refreshed_at = Date.now();
			this.lastError = undefined;
			this.save();
			this.logger?.info?.(`codearts credentials refreshed; expire ${credentials.expiration}`);
			return true;
		} catch (error) {
			this.lastError = `STS refresh failed: ${error instanceof Error ? error.message : String(error)}`;
			this.logger?.warn?.(this.lastError);
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Sign one request exactly as Huawei's SDK does.
	 *
	 * @returns headers to send; `host` is removed because fetch owns it.
	 */
	signRequest(method, url, headers, body) {
		const credentials = this.credentials;
		if (!credentials?.access_key_id || !credentials?.secret_access_key) throw new Error('session has no AK/SK');
		const parsed = new URL(url);
		const values = { ...headers };
		values.host = parsed.host;
		if (!Object.keys(values).some((name) => name.toLowerCase() === 'x-sdk-date')) {
			values['X-Sdk-Date'] = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
		}
		values['X-Security-Token'] = credentials.security_token;
		const names = Object.keys(values).map((name) => name.toLowerCase()).sort();
		const byLower = new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), String(value)]));
		const signedHeaders = names.join(';');
		const canonicalHeaders = names.map((name) => `${name}:${byLower.get(name).trim()}\n`).join('');
		const payloadHash = createHash('sha256').update(body ?? '').digest('hex');
		const canonicalRequest = [method, canonicalUri(parsed.pathname), canonicalQuery(parsed.search.slice(1)), canonicalHeaders, signedHeaders, payloadHash].join('\n');
		const stringToSign = ['SDK-HMAC-SHA256', values['X-Sdk-Date'], createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
		const signature = createHmac('sha256', credentials.secret_access_key).update(stringToSign).digest('hex');
		values.Authorization = `SDK-HMAC-SHA256 Access=${credentials.access_key_id}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
		delete values.host;
		return values;
	}

	/** Perform a signed request against the Snap gateway. */
	async request(method, url, headers, body) {
		if (!(await this.ensureCredentials())) throw new Error(this.lastError ?? 'CodeArts 登录已失效');
		const signed = this.signRequest(method, url, headers, body);
		const response = await fetch(url, {
			method,
			headers: signed,
			body: body === undefined || body === '' ? undefined : body
		});
		return response;
	}

	/** Report the shared chat session busy/idle so the gateway frees its slot. */
	async heartbeat(sessionId, status) {
		const url = `${GATEWAY}/snap-manager/v1/chat-session/heartbeat?status=${encodeURIComponent(status)}`;
		try {
			const response = await this.request('PUT', url, {
				'Content-Type': 'application/json',
				'user-session-id': sessionId
			}, '');
			await response.arrayBuffer();
			return response.ok;
		} catch (error) {
			this.logger?.warn?.(`codearts heartbeat ${status} failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
}

export { parseExpiry };
