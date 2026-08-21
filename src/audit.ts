/**
 * The append-only audit log — the record of what was asked for and what was
 * refused.
 *
 * This module is pure, on the same terms as the guard: it imports two *types*
 * from the guard and nothing else. No MCP, no SDK, no store instance, no I/O,
 * no ambient state. It cannot read a contact, cannot mint a token, and cannot
 * refuse anything on its own. It writes down what already happened.
 *
 * Two properties give it its value, and both are structural rather than
 * conventional:
 *
 *  - **Append-only.** {@link AuditLog} has exactly two methods: `append` and
 *    `list`. There is no `clear`, no `delete`, no `truncate`, no index-based
 *    setter, and `list` hands back deep copies of every event — so a caller
 *    holding a listed event is holding a photograph, not a handle. A log that
 *    can be edited by whoever it incriminates is not evidence.
 *  - **Redaction at the type boundary.** A capability token is a bearer
 *    credential: whoever reads one can spend it. An audit trail that quotes
 *    tokens in full turns every log line, every transcript, and every crash
 *    report into a place a live warrant can be lifted from. So a token id
 *    enters an event only as a {@link TokenFingerprint} — the first
 *    {@link FINGERPRINT_PREFIX_LENGTH} characters and an ellipsis, enough to
 *    correlate two events about the same token and not enough to present it.
 *
 * The second property is enforced by the compiler, not by care. The field on
 * an event is named `tokenFingerprint`, not `tokenId`, and its type is opaque:
 * {@link fingerprint} is the only function in the program that can produce a
 * value of that type, so a full token id cannot be assigned to the field even
 * by a caller who wants to. {@link redactTokenId} extends the same rule to free
 * text, because the guard's own refusal messages name the token they refused.
 *
 * Nothing else from a token is recorded — not the expiry, not the issue time,
 * and never the token object. The *mutation* is fair game and is recorded in
 * full: `op` and `contactId` are what an operator reads the log to find out.
 *
 * One honest limitation, stated here rather than discovered later: a
 * fingerprint hides nothing about an id shorter than the prefix length, since
 * the prefix is then the whole id. The guard mints UUIDs, so this matters only
 * for hand-made ids in tests and demos; it is not a reason to treat a
 * fingerprint as a secret.
 */

import type { ToolTier, WriteOp } from './guard.js';

/** How many leading characters of a token id a fingerprint keeps. */
export const FINGERPRINT_PREFIX_LENGTH = 8;

/** The mark that says "this id has been cut short on purpose". */
export const FINGERPRINT_ELLIPSIS = '…';

declare const tokenFingerprintBrand: unique symbol;

/**
 * A token id, truncated — the only form in which a token id may appear in an
 * event.
 *
 * The brand is not decoration. `TokenFingerprint` is a subtype of `string` that
 * no string literal inhabits, so the only way to obtain one is to call
 * {@link fingerprint}. That makes "never log a whole token id" a compile error
 * rather than a code-review habit.
 */
export type TokenFingerprint = string & { readonly [tokenFingerprintBrand]: 'token-fingerprint' };

/**
 * Truncate a token id for the record. The one door into {@link TokenFingerprint}.
 *
 * Deterministic on purpose: two events about the same token carry the same
 * fingerprint, so a trail can be followed end to end without any event
 * carrying a spendable credential.
 */
export function fingerprint(tokenId: string): TokenFingerprint {
    return `${tokenId.slice(0, FINGERPRINT_PREFIX_LENGTH)}${FINGERPRINT_ELLIPSIS}` as TokenFingerprint;
}

/**
 * Replace every occurrence of a full token id in free text with its fingerprint.
 *
 * The refusal messages this project relays are written to be self-explaining,
 * and several of them name the token they refused — `ReplayedTokenError` and
 * `MutationMismatchError` both quote the id. That text is exactly what an audit
 * event should carry and exactly what must not carry a live warrant, so the id
 * is cut down to the same fingerprint the structured fields use.
 *
 * Ids no longer than {@link FINGERPRINT_PREFIX_LENGTH} are left alone: their
 * fingerprint would show them whole anyway, so substituting one would garble
 * the message without hiding anything.
 */
export function redactTokenId(text: string, tokenId: string): string {
    if (tokenId.length <= FINGERPRINT_PREFIX_LENGTH) {
        return text;
    }
    return text.split(tokenId).join(fingerprint(tokenId));
}

/** How a confirmation ended. Every value here is an answer that was received. */
export type ConfirmOutcome =
    /** The user was asked and said yes. */
    | 'confirmed'
    /** The user was asked and said no — by answering no, or by dismissing the prompt. */
    | 'declined'
    /** The user cancelled the prompt rather than answering it. */
    | 'cancelled'
    /** Nobody could be asked: the client advertised no confirmation channel. */
    | 'refused_no_channel';

/** A read tool ran and returned data. Reads need no token, so none is recorded. */
export interface ReadEvent {
    kind: 'read';
    at: string;
    tool: string;
    summary: string;
}

/** A warrant was minted. It authorizes the named mutation and nothing else. */
export interface ProposeEvent {
    kind: 'propose';
    at: string;
    op: WriteOp;
    contactId: string;
    tier: ToolTier;
    tokenFingerprint: TokenFingerprint;
}

/** A human was asked to confirm a destructive write. */
export interface ConfirmRequestedEvent {
    kind: 'confirm_requested';
    at: string;
    op: WriteOp;
    contactId: string;
}

/** How that asking ended. Absent when the question could not be put at all. */
export interface ConfirmOutcomeEvent {
    kind: 'confirm_outcome';
    at: string;
    op: WriteOp;
    contactId: string;
    outcome: ConfirmOutcome;
}

/** A warrant was spent and the store applied the mutation. */
export interface ExecuteSuccessEvent {
    kind: 'execute_success';
    at: string;
    op: WriteOp;
    contactId: string;
    tokenFingerprint: TokenFingerprint;
}

/**
 * Something was refused, by whichever layer refused it.
 *
 * `rule` is the error class name — `ReplayedTokenError`, `NeverWriteStateError`,
 * `ConfirmationDeclinedError` — because that name *is* the rule, and it is what
 * an operator scans for. `message` is the refusal text as the caller received
 * it, with any token id already fingerprinted.
 */
export interface RefusalEvent {
    kind: 'refusal';
    at: string;
    tool: string;
    rule: string;
    message: string;
}

/** Everything the log can hold, discriminated on `kind`. */
export type AuditEvent =
    | ReadEvent
    | ProposeEvent
    | ConfirmRequestedEvent
    | ConfirmOutcomeEvent
    | ExecuteSuccessEvent
    | RefusalEvent;

/** Distribute `Omit` across a union, so each member keeps its own shape. */
type WithoutTimestamp<E> = E extends unknown ? Omit<E, 'at'> : never;

/**
 * An event as a caller writes it: everything except the timestamp.
 *
 * Callers do not stamp their own events. {@link AuditLog.append} reads the
 * clock, so the ordering in the log is the log's account of when things
 * happened, not the caller's claim about it.
 */
export type AuditEventInput = WithoutTimestamp<AuditEvent>;

/** Injectable seam, so tests can drive time deterministically. */
export interface AuditDeps {
    now?: () => number;
}

/**
 * A structural copy of one event.
 *
 * Written as a total switch rather than a spread so that adding a field to any
 * event — or a whole new event kind — fails `tsc` here instead of silently
 * shipping a shallow copy. Every field of every event is a primitive, so this
 * is a genuine deep copy.
 */
function copyEvent(event: AuditEvent): AuditEvent {
    switch (event.kind) {
        case 'read':
            return { kind: 'read', at: event.at, tool: event.tool, summary: event.summary };
        case 'propose':
            return {
                kind: 'propose',
                at: event.at,
                op: event.op,
                contactId: event.contactId,
                tier: event.tier,
                tokenFingerprint: event.tokenFingerprint
            };
        case 'confirm_requested':
            return { kind: 'confirm_requested', at: event.at, op: event.op, contactId: event.contactId };
        case 'confirm_outcome':
            return {
                kind: 'confirm_outcome',
                at: event.at,
                op: event.op,
                contactId: event.contactId,
                outcome: event.outcome
            };
        case 'execute_success':
            return {
                kind: 'execute_success',
                at: event.at,
                op: event.op,
                contactId: event.contactId,
                tokenFingerprint: event.tokenFingerprint
            };
        case 'refusal':
            return { kind: 'refusal', at: event.at, tool: event.tool, rule: event.rule, message: event.message };
    }
}

/**
 * The log. Two methods, and the shorter list is the interesting one.
 *
 * There is no `clear`, no `delete`, no `replace`, no way to reach the backing
 * array, and no event handed out that is still connected to the one stored.
 * Append-only is not a promise made in a comment; it is the entire public
 * surface of the class.
 */
export class AuditLog {
    /** Private and never handed out — not whole, and not element by element. */
    readonly #events: AuditEvent[] = [];
    readonly #now: () => number;

    constructor(deps: AuditDeps = {}) {
        this.#now = deps.now ?? (() => Date.now());
    }

    /** Record one event, stamped with the clock's current instant in ISO form. */
    append(event: AuditEventInput): void {
        const at = new Date(this.#now()).toISOString();
        this.#events.push(copyEvent({ ...event, at }));
    }

    /**
     * Every event so far, oldest first, as copies.
     *
     * The array is fresh and each event in it is a fresh object, so a caller
     * may mutate what it is given as much as it likes: the log it came from is
     * untouched. `readonly` states the intent; the copying enforces it.
     */
    list(): readonly AuditEvent[] {
        return this.#events.map(copyEvent);
    }
}
