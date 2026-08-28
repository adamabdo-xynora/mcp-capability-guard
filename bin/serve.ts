/**
 * The stdio entrypoint — the one place the server is wired to a real transport.
 *
 * Everything else in this repository builds the server in memory: the tests
 * drive it through `InMemoryTransport`, and so does the demo. This file is the
 * same wiring pointed at stdin/stdout, so an MCP client can spawn it as a
 * subprocess (or as a container with stdin attached — see the Dockerfile).
 *
 * It lives outside `src/` on purpose. The structural test pins `src/` to four
 * protocol-free modules plus `tools.ts`, and this file is neither: it is glue
 * that exists only to start a process. Keeping it here keeps that claim true.
 *
 * Choices, stated:
 *  - The store is the seeded in-memory one, exactly as in the demo. A real
 *    deployment swaps in a `ContactStore` of its own here — nowhere else needs
 *    to change.
 *  - `read_audit` is NOT exposed. That is `buildServer`'s default, and the
 *    default is the security posture: the audit trail is for the operator.
 *  - Nothing is logged to stdout. On a stdio transport stdout *is* the
 *    protocol; a stray `console.log` corrupts the framing. Diagnostics go to
 *    stderr only.
 *  - No environment variable is read and no file is opened. The server needs
 *    no secret to run; if a future store does, it arrives at run time
 *    (`docker run -e`, a mounted file), never as a build-time ARG.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { AuditLog } from '../src/audit.js';
import { Guard } from '../src/guard.js';
import { InMemoryContactStore } from '../src/store.js';
import { buildServer } from '../src/tools.js';

/** Same warrant lifetime the demo uses: long enough to confirm, short enough to forget. */
const TTL_MS = 60_000;

async function main(): Promise<void> {
    const store = new InMemoryContactStore();
    const guard = new Guard({ ttlMs: TTL_MS });
    const audit = new AuditLog();
    const server = buildServer({ store, guard, audit });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('mcp-capability-guard: listening on stdio');
}

main().catch((error: unknown) => {
    console.error('mcp-capability-guard: failed to start:', error);
    process.exit(1);
});
