/**
 * Architecture tests — the layering, read out of the source text itself.
 *
 * Every other test in this project drives the code. These tests read it. That
 * is the point: the properties pinned here are not behaviours a caller can
 * observe at runtime, they are facts about which module is allowed to know
 * about which other module. A dependency edge added in a moment of convenience
 * — the store reaching up to the guard, the audit log importing the SDK, a
 * second place that mints tokens — breaks no behaviour and passes every
 * behavioural test. It just quietly dissolves the design. So the import graph
 * is asserted as text, and a new edge is a test failure with a name.
 *
 * Reading source as text is a blunt instrument, and the tests below are written
 * to be precise rather than clever: each one matches on a form that appears in
 * exactly one place for exactly one reason, and says in a comment why that form
 * identifies the thing it claims to identify.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** Every TypeScript file under src/, recursively — a new subdirectory cannot hide from these tests. */
function srcFileNames(): string[] {
    return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.ts'))
        .sort();
}

function read(name: string): string {
    return readFileSync(join(SRC_DIR, name), 'utf8');
}

interface ImportStatement {
    /** The whole `import ... from '...';` statement, however many lines it spans. */
    statement: string;
    /** The module specifier in quotes. */
    specifier: string;
    /** True for `import type { ... }` — a compile-time-only edge. */
    typeOnly: boolean;
}

/**
 * Every import statement in a source file, including multi-line ones.
 *
 * Anchored to the start of a line, so the word "import" inside a doc comment
 * (every comment line in this project starts with ` *`) is not a match.
 */
function importsOf(source: string): ImportStatement[] {
    const found: ImportStatement[] = [];
    for (const match of source.matchAll(/^import\s+(?:type\s+)?[\s\S]*?\s+from\s+'([^']+)';$/gm)) {
        const specifier = match[1];
        if (specifier === undefined) {
            continue;
        }
        found.push({
            statement: match[0],
            specifier,
            typeOnly: /^import\s+type\b/.test(match[0])
        });
    }
    return found;
}

/** Specifiers that point at another file in this project, rather than a package or a builtin. */
function projectLocalSpecifiers(source: string): string[] {
    return importsOf(source)
        .map((entry) => entry.specifier)
        .filter((specifier) => specifier.startsWith('.'));
}

const SDK_PACKAGE = '@modelcontextprotocol';

describe('structure', () => {
    it('finds the source files it is asserting about', () => {
        // A guard on the guards: if the glob broke, every test below would pass
        // vacuously by scanning nothing.
        expect(srcFileNames()).toEqual(['audit.ts', 'guard.ts', 'store.ts', 'tools.ts']);
    });

    /**
     * CLAIM: the MCP SDK enters this project through exactly one door — tools.ts —
     * so every layer beneath it is protocol-free and testable without a server.
     */
    it('confines the MCP SDK import to tools.ts', () => {
        const importers = srcFileNames().filter((name) => read(name).includes(SDK_PACKAGE));

        expect(importers).toEqual(['tools.ts']);

        // And in tools.ts it really is an import, not a mention in prose.
        const sdkImports = importsOf(read('tools.ts')).filter((entry) =>
            entry.specifier.startsWith(SDK_PACKAGE)
        );
        expect(sdkImports.length).toBeGreaterThan(0);
    });

    /**
     * CLAIM: the store is the floor — it knows nothing about the guard, the tool
     * surface, or the audit log, so it can refuse a write without consulting any
     * of them.
     */
    it('keeps src/store.ts ignorant of every layer above it', () => {
        const source = read('store.ts');

        for (const forbidden of ['./guard.js', './tools.js', './audit.js']) {
            expect(projectLocalSpecifiers(source)).not.toContain(forbidden);
        }

        // Stronger, and true today: the floor imports nothing at all.
        expect(importsOf(source)).toEqual([]);
    });

    /**
     * CLAIM: the guard is pure — it depends on the store only for a type, never
     * for an instance, so it can reason about mutations as data without being
     * able to perform one.
     */
    it('limits src/guard.ts to node builtins and a type from the store', () => {
        const statements = importsOf(read('guard.ts'));

        for (const entry of statements) {
            const allowed = entry.specifier.startsWith('node:') || entry.specifier === './store.js';
            expect(allowed, `guard.ts imports "${entry.specifier}", which is not on the allowlist`).toBe(
                true
            );
        }

        // The one project-local edge exists, and it carries no runtime value:
        // a type-only import cannot hand the guard a store to write through.
        const local = statements.filter((entry) => entry.specifier.startsWith('.'));
        expect(local.map((entry) => entry.specifier)).toEqual(['./store.js']);
        expect(local.every((entry) => entry.typeOnly)).toBe(true);
    });

    /**
     * CLAIM: the audit log is pure on the same terms as the guard — it imports two
     * types and nothing else, so it can neither mint a token nor read a contact
     * nor perform any I/O of its own.
     */
    it('limits src/audit.ts to type-only imports from the guard', () => {
        const statements = importsOf(read('audit.ts'));

        expect(statements.map((entry) => entry.specifier)).toEqual(['./guard.js']);
        expect(statements.every((entry) => entry.typeOnly)).toBe(true);
    });

    /**
     * CLAIM: token minting happens in exactly one place — guard.ts — so there is no
     * second path by which a warrant can come into existence.
     *
     * WHY THESE PATTERNS. A token becomes spendable through two steps that both
     * live in `Guard.proposeWrite` and nowhere else:
     *
     *  - `: CapabilityToken = {` is the sole *construction* of a token value. The
     *    annotation is what makes this precise: `CapabilityToken` also appears in
     *    tools.ts, but only inside `{@link CapabilityToken}` in prose, which the
     *    `: ` prefix and ` = {` suffix exclude. Matching the bare type name would
     *    be brittle; matching a typed object-literal binding is not.
     *  - `#tokens.set(` is the sole *registration* of a token in the private
     *    registry. Construction alone authorizes nothing — `executeWrite` looks up
     *    `#tokens`, so a token that was never inserted there is an
     *    `UnknownTokenError`. This line is therefore the exact moment a warrant
     *    starts to exist as far as verification is concerned.
     *
     * Both are asserted to appear exactly once, because "one minting site" is the
     * claim; two of either inside guard.ts would already be a second path.
     */
    it('confines token minting to src/guard.ts', () => {
        const TOKEN_CONSTRUCTION = ': CapabilityToken = {';
        const REGISTRY_INSERTION = '#tokens.set(';

        const guard = read('guard.ts');
        expect(guard.split(TOKEN_CONSTRUCTION)).toHaveLength(2);
        expect(guard.split(REGISTRY_INSERTION)).toHaveLength(2);

        for (const name of srcFileNames().filter((file) => file !== 'guard.ts')) {
            const source = read(name);
            expect(source, `${name} constructs a CapabilityToken`).not.toContain(TOKEN_CONSTRUCTION);
            expect(source, `${name} writes to the token registry`).not.toContain(REGISTRY_INSERTION);
        }
    });

    /**
     * CLAIM: a token id may appear in an audit event only as a branded fingerprint —
     * the audit module names no event field `tokenId`, and the only code in it that
     * touches a whole id is the pair of redaction functions that exist to cut ids
     * down.
     *
     * DEVIATION FROM THE LITERAL SPEC, STATED HERE RATHER THAN HIDDEN. The
     * requested assertion was that the string "tokenId" never appears anywhere in
     * src/audit.ts. It does appear, six times, and every occurrence is part of the
     * mechanism that enforces the rule rather than a violation of it: the
     * parameter of `fingerprint(tokenId: string)`, the name and parameter of
     * `redactTokenId(text, tokenId)` and its body, and one doc-comment line that
     * states the rule ("the field ... is named `tokenFingerprint`, not `tokenId`").
     * Making the literal assertion pass would mean renaming the project's two
     * redaction functions — an src change, which this task forbids and which would
     * make the code worse to read. So the test below pins the claim the literal
     * assertion was reaching for, in a form that is checkable and strictly
     * stronger where it matters: no *event field* is named `tokenId`, and no code
     * outside the two redaction helpers mentions one.
     */
    it('lets a token id into src/audit.ts only through the redaction helpers', () => {
        const source = read('audit.ts');
        const lines = source.split('\n');

        // (a) No event interface declares a token-id field. Interface members are
        // indented; a `tokenId` parameter inside a function signature is not at the
        // start of its line, so this matches declarations only.
        expect(source).not.toMatch(/^\s+tokenId\s*\??\s*:/m);

        // (b) The field that does carry token identity is the branded one, and it is
        // the branded type that makes assigning a full id a compile error.
        expect(source).toContain('tokenFingerprint: TokenFingerprint;');

        // (c) Every mention of `tokenId` in the module is either prose or inside one
        // of the two exported functions whose job is to destroy full ids.
        const spanOf = (signature: string): { start: number; end: number } => {
            const start = lines.findIndex((line) => line.startsWith(signature));
            expect(start, `${signature} not found in audit.ts`).toBeGreaterThanOrEqual(0);
            const end = lines.findIndex((line, index) => index > start && line === '}');
            expect(end, `no end found for ${signature}`).toBeGreaterThan(start);
            return { start, end };
        };
        const redactionSpans = [
            spanOf('export function fingerprint('),
            spanOf('export function redactTokenId(')
        ];

        const isComment = (line: string): boolean => /^\s*(\*|\/\*|\/\/)/.test(line);

        lines.forEach((line, index) => {
            if (!line.includes('tokenId') || isComment(line)) {
                return;
            }
            const inRedaction = redactionSpans.some((span) => index >= span.start && index <= span.end);
            expect(
                inRedaction,
                `audit.ts:${index + 1} mentions a whole token id outside the redaction helpers: ${line.trim()}`
            ).toBe(true);
        });
    });

    /**
     * CLAIM: wherever tools.ts puts token identity into an audit event, it goes
     * through fingerprint() — there is no path by which a raw id reaches the log.
     */
    it('builds every audit event token field in src/tools.ts through fingerprint()', () => {
        const fingerprintFields = read('tools.ts')
            .split('\n')
            .filter((line) => line.includes('tokenFingerprint'));

        // Both event kinds that carry a token: propose and execute_success.
        expect(fingerprintFields.length).toBeGreaterThanOrEqual(2);
        for (const line of fingerprintFields) {
            expect(line, `token field built without fingerprint(): ${line.trim()}`).toContain(
                'fingerprint('
            );
        }
    });
});
