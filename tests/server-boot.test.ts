/**
 * End-to-end boot guard: spawn the REAL built artifacts and run the handshake
 * an MCP host runs at install time (`initialize` → `tools/list`).
 *
 * Two failure modes this catches, both of which unit tests structurally cannot:
 *
 *  1. **An eager import of an esbuild-externalised / optional dependency.**
 *     `dist/bundle.js` is the `.mcpb` artifact and ships with NO
 *     `node_modules`; a top-level import of `dotenv` or `@fetchproxy/server`
 *     would crash the shipped server on launch while every test stayed green.
 *     The bundle is therefore copied ALONE into an empty temp dir before it runs.
 *  2. **A `bin` that points at a path `tsc` never emitted.** `dist/index.js` is
 *     the npm entry point, run here from the repo root with `node_modules`.
 *
 * Both run with no HelloFresh session, which also proves the deferred-config-error
 * pattern end to end: the server must boot and list its tools before any
 * credential exists.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');
const BIN = join(ROOT, 'dist', 'index.js');

/**
 * A LOWER BOUND, never an exact count — this file must stay green when another
 * branch adds a tool (PRs are CI-tested merged with main). Raise it as tool
 * registrars land; the manifest roster test owns the exact list.
 */
const MIN_TOOLS = 24;

beforeAll(() => {
  if (!existsSync(BUNDLE) || !existsSync(BIN)) {
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  }
}, 180_000);

interface BootResult {
  serverName: string | undefined;
  tools: string[];
}

/**
 * Spawn an MCP stdio server, run initialize + tools/list, resolve the server
 * name and tool names. A server with NO tools registered declares no `tools`
 * capability and answers tools/list with -32601; that is read as an empty
 * roster (so the scaffold boots green), and `MIN_TOOLS` turns it into a
 * failure once any registrar is expected.
 */
function listToolsViaStdio(entry: string, cwd: string, home: string): Promise<BootResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [entry], {
      cwd,
      env: {
        ...process.env,
        // A throwaway HOME so a boot never reads or writes the developer's real
        // fetchproxy identity / pairing.
        HOME: home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let serverName: string | undefined;
    let tools: string[] | undefined;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out waiting for tools/list; stderr:\n${err}`));
    }, 20_000);

    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message: {
          id?: number;
          result?: { tools?: { name: string }[]; serverInfo?: { name: string } };
          error?: { code: number };
        };
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue; // a partial line — wait for the rest
        }
        if (message.id === 0 && message.result) serverName = message.result.serverInfo?.name;
        if (message.id === 1 && (message.result || message.error?.code === -32601)) {
          tools = (message.result?.tools ?? []).map((tool) => tool.name);
        }
        // Responses can arrive out of order — wait for both.
        if (serverName !== undefined && tools !== undefined) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve({ serverName, tools });
          return;
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // 'close' (not 'exit') so stdout is fully drained first.
    child.on('close', (code) => {
      if (serverName === undefined || tools === undefined) {
        clearTimeout(timer);
        reject(new Error(`server exited (code ${code}) before answering tools/list; stderr:\n${err}`));
      }
    });

    child.stdin.write(
      '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"boot-test","version":"1"}}}\n',
    );
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  });
}

describe('server boot (built artifacts)', () => {
  it('bundled .mcpb (dist/bundle.js) boots WITHOUT node_modules and lists its tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hellofresh-mcpb-'));
    try {
      // Only the bundle — no node_modules, no package.json, no .env. Exactly
      // what a .mcpb install unpacks.
      copyFileSync(BUNDLE, join(dir, 'bundle.js'));
      const { serverName, tools } = await listToolsViaStdio(join(dir, 'bundle.js'), dir, dir);
      expect(serverName).toBe('hellofresh-mcp');
      expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
      expect(tools.every((name) => name.startsWith('hf_'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('npm bin (dist/index.js) boots with node_modules and lists its tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hellofresh-bin-'));
    try {
      const { serverName, tools } = await listToolsViaStdio(BIN, ROOT, dir);
      expect(serverName).toBe('hellofresh-mcp');
      expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
      expect(tools.every((name) => name.startsWith('hf_'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
