/**
 * The capability-token guard — the centerpiece of this project.
 *
 * The guard reasons about mutations as *data*. It imports types from the store
 * and nothing else: no MCP, no store instance, no I/O, no ambient state. It
 * never reads or writes a contact. Ask it to authorize a write and it hands
 * back a token; present that token back with the exact same mutation and it
 * hands the mutation back, once. Whoever applies it is somebody else's job.
 *
 * Three rules give the design its teeth:
 *
 *  - **Binding.** A token embeds the exact mutation it authorizes. There is no
 *    separate "scope" to interpret and no room to argue about what a token
 *    covers — the mutation IS the binding, compared field by field.
 *  - **Single use.** A verified token is spent. Replay is an error, never a
 *    second write.
 *  - **Burn on mismatch.** Presenting a token with the wrong mutation is not a
 *    typo to forgive; it is a token under attack. The token is spent on the
 *    spot and can never execute anything afterwards — not even its own,
 *    correct, bound mutation.
 *
 * Configuration is fail-closed: a guard that cannot prove its config valid
 * throws at construction and mints nothing.
 */

import { randomUUID } from 'node:crypto';

import type { Stage } from './store.js';

/**
 * How much damage a tool can do, independent of who is calling.
 *
 * `read` operations are not represented in {@link Mutation} at all — they need
 * no token. The split that matters for writes is `reversible` (a note or a tag
 * can be undone by hand) versus `destructive` (a lost stage value, a removed
 * tag, or a deleted contact is gone).
 */
export type ToolTier = 'read' | 'reversible' | 'destructive';

/** The name of every write operation the guard knows how to authorize. */
export type WriteOp = Mutation['op'];

/**
 * The tier of each write operation.
 *
 * `change_stage` is destructive because the previous stage is not recoverable
 * from the record afterwards; `remove_tag` for the same reason. Deletion needs
 * no argument.
 */
export const WRITE_TIERS: Readonly<Record<WriteOp, ToolTier>> = Object.freeze({
    add_note: 'reversible',
    add_tag: 'reversible',
    remove_tag: 'destructive',
    change_stage: 'destructive',
    delete_contact: 'destructive'
} satisfies Record<WriteOp, ToolTier>);

/**
 * A single proposed write, as data.
 *
 * Discriminated on `op`, so each operation carries exactly its own payload and
 * nothing else. An `add_tag` mutation cannot even be *spelled* with a
 * `newStage` field, which is what lets the binding check below be a total,
 * exhaustive comparison rather than a bag of optional-field guesses.
 */
export type Mutation =
    | { op: 'add_note'; contactId: string; text: string }
    | { op: 'add_tag'; contactId: string; tag: string }
    | { op: 'remove_tag'; contactId: string; tag: string }
    | { op: 'change_stage'; contactId: string; newStage: Stage }
    | { op: 'delete_contact'; contactId: string };

/**
 * Authorization to perform one mutation, once, before it expires.
 *
 * The token embeds the mutation rather than referring to it. There is no
 * lookup table to poison and no id to re-point: what you get back from
 * {@link Guard.executeWrite} is the mutation that was minted, not the one that
 * was presented.
 */
export interface CapabilityToken {
    id: string;
    mutation: Mutation;
    issuedAt: number;
    expiresAt: number;
}

/** Guard configuration. `ttlMs` is how long a minted token stays usable. */
export interface GuardConfig {
    ttlMs: number;
}

/** Base class for every error the guard raises, so callers can catch the family. */
export class GuardError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/**
 * Thrown at construction when the config cannot be proven valid.
 *
 * There is no default TTL and no repair path. A guard built from a config it
 * does not understand would be minting tokens with an unknown lifetime, so it
 * refuses to exist at all.
 */
export class GuardConfigError extends GuardError {
    constructor(detail: string) {
        super(
            `Guard config refused: ${detail}. ` +
                `Rule: fail-closed configuration — ttlMs must be a finite number greater than zero, ` +
                `and a guard that cannot prove its config valid mints nothing.`
        );
    }
}

/** Thrown when a mutation is not a well-formed {@link Mutation}. */
export class InvalidMutationError extends GuardError {
    constructor(detail: string) {
        super(
            `Mutation refused: ${detail}. ` +
                `Rule: only well-formed mutations are minted — the guard authorizes what it can name.`
        );
    }
}

/** Thrown when no token with the presented id was ever minted by this guard. */
export class UnknownTokenError extends GuardError {
    readonly id: string;

    constructor(id: string) {
        super(
            `Token "${id}" is unknown: this guard never minted it. ` +
                `Rule: only tokens minted by this guard can execute — an unrecognized id authorizes nothing.`
        );
        this.id = id;
    }
}

/** Thrown when a token is presented at or after its expiry instant. */
export class ExpiredTokenError extends GuardError {
    readonly id: string;
    readonly expiresAt: number;
    readonly now: number;

    constructor(id: string, expiresAt: number, now: number) {
        super(
            `Token "${id}" expired at ${expiresAt}; it is now ${now}. ` +
                `Rule: tokens are time-bound — authorization does not outlive its TTL, ` +
                `and the expiry instant itself is already too late.`
        );
        this.id = id;
        this.expiresAt = expiresAt;
        this.now = now;
    }
}

/**
 * Thrown when a token has already been spent — by a successful execution, or by
 * being burned on a mismatch attempt.
 */
export class ReplayedTokenError extends GuardError {
    readonly id: string;

    constructor(id: string) {
        super(
            `Token "${id}" was already used. ` +
                `Rule: tokens are single-use — one token authorizes exactly one write, ` +
                `and a spent token (whether executed or burned by a mismatch) never executes again.`
        );
        this.id = id;
    }
}

/** Which part of the presented mutation failed to match the bound one. */
export type MismatchField = 'op' | 'contactId' | 'payload';

/**
 * Thrown when the presented mutation is not the mutation the token authorizes.
 *
 * Raising this also burns the token — see {@link Guard.executeWrite}.
 */
export class MutationMismatchError extends GuardError {
    readonly id: string;
    /** The first field that diverged: `op`, `contactId`, or `payload`. */
    readonly field: MismatchField;

    constructor(id: string, field: MismatchField, detail: string) {
        super(
            `Token "${id}" is bound to one exact mutation and the presented mutation diverged ` +
                `on ${field}: ${detail}. ` +
                `Rule: mutation binding — a token authorizes exactly the mutation it was minted for, ` +
                `and a mismatch burns the token.`
        );
        this.id = id;
        this.field = field;
    }
}

/** Injectable seams, so tests can drive time and ids deterministically. */
export interface GuardDeps {
    now?: () => number;
    generateId?: () => string;
}

/**
 * Every {@link Stage}, as a runtime-checkable object.
 *
 * Typed as `Record<Stage, true>`, so adding a stage to the union in `store.ts`
 * without adding it here is a compile error rather than a mutation the guard
 * silently refuses to mint.
 */
const KNOWN_STAGES: Record<Stage, true> = {
    New: true,
    Contacted: true,
    Qualified: true,
    Proposal: true,
    'Closed-Won': true,
    'Closed-Lost': true,
    'Closed-Lost-DNC': true
};

/** Internal registry entry. `used` is the single-use latch. */
interface TokenRecord {
    token: CapabilityToken;
    used: boolean;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

/**
 * Narrow an untrusted value to a {@link Mutation}, or throw.
 *
 * Callers reach the guard across a trust boundary (an MCP tool argument, a
 * demo script, a test), so the compile-time union is not evidence. Everything
 * is re-checked here.
 */
function validateMutation(value: unknown, label: string): Mutation {
    if (typeof value !== 'object' || value === null) {
        throw new InvalidMutationError(`${label} must be an object, received ${describe(value)}`);
    }

    const candidate = value as Partial<Record<string, unknown>> & { op?: unknown };
    const op = candidate['op'];

    if (!isNonEmptyString(op)) {
        throw new InvalidMutationError(`${label} is missing a string "op", received ${describe(op)}`);
    }
    if (!Object.hasOwn(WRITE_TIERS, op)) {
        throw new InvalidMutationError(
            `${label} has unknown op "${op}"; known ops are ${Object.keys(WRITE_TIERS).join(', ')}`
        );
    }

    const contactId = candidate['contactId'];
    if (!isNonEmptyString(contactId)) {
        throw new InvalidMutationError(
            `${label} is missing a non-empty string "contactId", received ${describe(contactId)}`
        );
    }

    switch (op as WriteOp) {
        case 'add_note': {
            const text = candidate['text'];
            if (typeof text !== 'string') {
                throw new InvalidMutationError(`${label} (add_note) needs a string "text", received ${describe(text)}`);
            }
            return { op: 'add_note', contactId, text };
        }
        case 'add_tag':
        case 'remove_tag': {
            const tag = candidate['tag'];
            if (!isNonEmptyString(tag)) {
                throw new InvalidMutationError(
                    `${label} (${op}) needs a non-empty string "tag", received ${describe(tag)}`
                );
            }
            return { op: op as 'add_tag' | 'remove_tag', contactId, tag };
        }
        case 'change_stage': {
            const newStage = candidate['newStage'];
            if (!isNonEmptyString(newStage) || !Object.hasOwn(KNOWN_STAGES, newStage)) {
                throw new InvalidMutationError(
                    `${label} (change_stage) needs a known "newStage", received ${describe(newStage)}`
                );
            }
            return { op: 'change_stage', contactId, newStage: newStage as Stage };
        }
        case 'delete_contact':
            return { op: 'delete_contact', contactId };
    }
}

/** A short, safe rendering of an untrusted value for error messages. */
function describe(value: unknown): string {
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'an array';
    }
    return typeof value;
}

/** The payload field carried by each op, for precise mismatch reporting. */
function payloadEntry(mutation: Mutation): { key: string; value: string } | null {
    switch (mutation.op) {
        case 'add_note':
            return { key: 'text', value: mutation.text };
        case 'add_tag':
        case 'remove_tag':
            return { key: 'tag', value: mutation.tag };
        case 'change_stage':
            return { key: 'newStage', value: mutation.newStage };
        case 'delete_contact':
            return null;
    }
}

/** A structural copy, so no handle into the registry ever escapes. */
function copyMutation(mutation: Mutation): Mutation {
    switch (mutation.op) {
        case 'add_note':
            return { op: 'add_note', contactId: mutation.contactId, text: mutation.text };
        case 'add_tag':
            return { op: 'add_tag', contactId: mutation.contactId, tag: mutation.tag };
        case 'remove_tag':
            return { op: 'remove_tag', contactId: mutation.contactId, tag: mutation.tag };
        case 'change_stage':
            return { op: 'change_stage', contactId: mutation.contactId, newStage: mutation.newStage };
        case 'delete_contact':
            return { op: 'delete_contact', contactId: mutation.contactId };
    }
}

function copyToken(token: CapabilityToken): CapabilityToken {
    return {
        id: token.id,
        mutation: copyMutation(token.mutation),
        issuedAt: token.issuedAt,
        expiresAt: token.expiresAt
    };
}

/**
 * The first field on which `presented` diverges from `bound`, or `null` if the
 * two mutations are identical.
 *
 * Order is deliberate — `op`, then `contactId`, then payload — so the reported
 * field is the most structural difference rather than an incidental one.
 */
function findDivergence(
    bound: Mutation,
    presented: Mutation
): { field: MismatchField; detail: string } | null {
    if (bound.op !== presented.op) {
        return {
            field: 'op',
            detail: `bound to op "${bound.op}", presented op "${presented.op}"`
        };
    }
    if (bound.contactId !== presented.contactId) {
        return {
            field: 'contactId',
            detail: `bound to contactId "${bound.contactId}", presented contactId "${presented.contactId}"`
        };
    }

    const boundPayload = payloadEntry(bound);
    const presentedPayload = payloadEntry(presented);
    if (boundPayload !== null && presentedPayload !== null && boundPayload.value !== presentedPayload.value) {
        return {
            field: 'payload',
            detail:
                `payload field "${boundPayload.key}" bound to ${JSON.stringify(boundPayload.value)}, ` +
                `presented ${JSON.stringify(presentedPayload.value)}`
        };
    }

    return null;
}

/**
 * Mints capability tokens and verifies them. Holds no contacts and performs no
 * writes — {@link executeWrite} returns the authorized mutation for someone
 * else to apply.
 */
export class Guard {
    readonly #ttlMs: number;
    readonly #now: () => number;
    readonly #generateId: () => string;
    /** The registry is private and never handed out, whole or in part. */
    readonly #tokens = new Map<string, TokenRecord>();

    constructor(config: GuardConfig, deps: GuardDeps = {}) {
        // Fail-closed: validate before storing anything. Every rejection below
        // is a config the guard cannot reason about, and a guard that cannot
        // reason about its TTL must not mint tokens with one.
        if (config === undefined || config === null) {
            throw new GuardConfigError(`config is ${config === null ? 'null' : 'missing'}`);
        }
        if (typeof config !== 'object' || Array.isArray(config)) {
            throw new GuardConfigError(`config must be an object, received ${describe(config)}`);
        }

        const ttlMs = (config as { ttlMs?: unknown }).ttlMs;
        if (ttlMs === undefined) {
            throw new GuardConfigError('config is missing "ttlMs"');
        }
        if (typeof ttlMs !== 'number') {
            throw new GuardConfigError(`"ttlMs" must be a number, received ${describe(ttlMs)}`);
        }
        if (Number.isNaN(ttlMs)) {
            throw new GuardConfigError('"ttlMs" is NaN');
        }
        if (!Number.isFinite(ttlMs)) {
            throw new GuardConfigError(`"ttlMs" is not finite (${ttlMs})`);
        }
        if (ttlMs <= 0) {
            throw new GuardConfigError(`"ttlMs" must be greater than zero, received ${ttlMs}`);
        }

        this.#ttlMs = ttlMs;
        this.#now = deps.now ?? (() => Date.now());
        this.#generateId = deps.generateId ?? randomUUID;
    }

    /**
     * Authorize one mutation and return its token.
     *
     * Minting is not performing: nothing is written, and the mutation is not
     * checked against any contact. The token is a deep copy, so the caller
     * cannot reach into the registry by editing what it was handed.
     */
    proposeWrite(mutation: Mutation): CapabilityToken {
        const validated = validateMutation(mutation, 'mutation');
        const issuedAt = this.#now();
        const token: CapabilityToken = {
            id: this.#generateId(),
            mutation: validated,
            issuedAt,
            expiresAt: issuedAt + this.#ttlMs
        };

        this.#tokens.set(token.id, { token, used: false });
        return copyToken(token);
    }

    /**
     * The verification gate. Returns the authorized mutation, or throws.
     *
     * Checks run in a fixed order — exists, not expired, not used, matches —
     * so the error a caller gets names the first thing actually wrong. The
     * returned mutation is a copy of the *bound* one: even a presented mutation
     * that passes verification is discarded, because the token's copy is the
     * one that was authorized.
     */
    executeWrite(tokenId: string, mutation: Mutation): Mutation {
        const record = this.#tokens.get(tokenId);
        if (record === undefined) {
            throw new UnknownTokenError(tokenId);
        }

        const now = this.#now();
        if (now >= record.token.expiresAt) {
            // The expiry instant is already too late — fail-closed at the boundary.
            throw new ExpiredTokenError(tokenId, record.token.expiresAt, now);
        }
        if (record.used) {
            throw new ReplayedTokenError(tokenId);
        }

        // Validate the presented mutation before comparing, so malformed input
        // is an InvalidMutationError rather than an accidental "mismatch".
        const presented = validateMutation(mutation, 'presented mutation');
        const divergence = findDivergence(record.token.mutation, presented);
        if (divergence !== null) {
            // SECURITY RULE: burn on mismatch. A token presented with the wrong
            // mutation is a token under attack, so it is spent here — the
            // correct mutation will not revive it either.
            record.used = true;
            throw new MutationMismatchError(tokenId, divergence.field, divergence.detail);
        }

        record.used = true;
        return copyMutation(record.token.mutation);
    }
}
