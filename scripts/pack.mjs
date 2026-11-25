#!/usr/bin/env node
/**
 * Build the distributable artifacts for migrating this plugin to another
 * DeepSeek Harness desktop install:
 *
 *   dist/dsh-codearts-connect-<version>.tgz  npm tarball, installable with
 *                                            `dsh plugin --profile <p> add file:<tgz>`
 *   dist/dsh-codearts-connect-<version>.zip  plain folder zip, unpack-and-copy
 *
 * Pure Node + the platform archiver: no network, no dependencies to install.
 */

import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist');
const base = `${manifest.name}-${manifest.version}`;

mkdirSync(dist, { recursive: true });

// ── npm tarball ───────────────────────────────────────────────────────────
const tgz = join(dist, `${base}.tgz`);
rmSync(tgz, { force: true });
// `npm` is a .cmd shim on Windows, which needs a shell to spawn.
const packOutput = execSync('npm pack --pack-destination "' + dist + '" --json', {
	cwd: root,
	encoding: 'utf8',
	stdio: ['ignore', 'pipe', 'inherit']
});
const packed = JSON.parse(packOutput.trim() || '[]');
const tarballName = packed[0]?.filename;
if (!tarballName) throw new Error('npm pack produced no tarball');
if (join(dist, tarballName) !== tgz) {
	rmSync(tgz, { force: true });
	cpSync(join(dist, tarballName), tgz);
}
console.log(`tgz : ${tgz} (${statSync(tgz).size} bytes, ${packed[0].entryCount} files)`);

// ── folder zip ────────────────────────────────────────────────────────────
const zip = join(dist, `${base}.zip`);
rmSync(zip, { force: true });
// Stage a clean copy so zip/never ships dist/, node_modules or editor junk.
const stage = join(dist, `.stage-${base}`);
rmSync(stage, { recursive: true, force: true });
for (const entry of ['lib', 'scripts', 'bin.js', 'cordis.patch.yml', 'cordis.orchestrator.yml', 'package.json', 'README.md']) {
	const source = join(root, entry);
	if (!existsSync(source)) continue;
	cpSync(source, join(stage, base, entry), { recursive: true });
}
// The orchestrator profile snippet is a template, not part of the bundle; keep
// it out of the plugin folder users copy wholesale.
rmSync(join(stage, base, 'cordis.orchestrator.yml'), { force: true });

if (process.platform === 'win32') {
	execFileSync('powershell', [
		'-NoProfile',
		'-Command',
		`Compress-Archive -LiteralPath '${join(stage, base)}' -DestinationPath '${zip}' -Force`
	], { stdio: 'inherit' });
} else {
	execFileSync('zip', ['-rq', zip, base], { cwd: stage, stdio: 'inherit' });
}
rmSync(stage, { recursive: true, force: true });
console.log(`zip : ${zip} (${statSync(zip).size} bytes)`);
