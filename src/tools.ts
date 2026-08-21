/**
 * The MCP tool surface — the only module in this project that imports the SDK.
 *
 * Everything below this file is protocol-free: the store knows about contacts,
 * the guard knows about tokens, the audit log knows about events, and none of
 * them knows it is being spoken to over MCP. This module is the wiring, and
 * only the wiring. It re-implements no rule that already lives underneath it:
 * it does not decide what a token authorizes (the guard does), it does not
 * decide which records are frozen (the store does), and it does not decide what
 * a token id may look like in a record (the audit module does). What it adds is
 * a *shape* — a tiered surface in which the dangerous half of the API is
 * unreachable in one step.
 *
 * The tiering is the point:
 *
 *  - **Reads** (`list_contacts`, `get_contact`) call the store directly. They
 *    need no token, because reading changes nothing.
 *  - **Writes** never touch the store from a single tool call. There is no
 *    `add_note` tool, no `delete_contact` tool, nothing a confused or coerced
 *    model can reach for by accident. Every write is two deliberate steps:
 *    `propose_write` mints a warrant for one exact mutation, and
 *    `execute_write` presents that warrant back. The store is only ever touched
 *    on the far side of a verified warrant.
 *
 * On top of the two-step shape sits one more gate, and it is the only rule this
 * module owns outright: **a destructive write is confirmed by a human before it
 * is executed.** The guard cannot ask a person anything — it has no I/O — and
 * the store cannot either, so the asking belongs here, where the protocol is.
 * The channel is MCP's form elicitation, which exists only if the connected
 * client says it does; a client that never advertised it is not talked into
 * one. See {@link handleConfirmedExecuteWrite} for why the asking happens
 * *before* the guard is consulted rather than after.
 *
 * Everything that happens here is written down. Every handler appends to the
 * {@link AuditLog}: reads, proposals, each half of a confirmation, successful
 * executions, and every refusal — named by the rule that produced it. Two
 * consequences are worth stating where the wiring is:
 *
 *  - **No token id crosses into the record whole.** Events carry a
 *    {@link fingerprint}, and refusal text — which the guard writes with the
 *    token id in it — is passed through {@link redactTokenId} before it is
 *    logged *or returned*. The full id appears in exactly one place in this
 *    file, `propose_write`'s reply to the caller that has to spend it.
 *  - **The log is not part of the model's surface by default.** `read_audit` is
 *    registered only when {@link buildServer} is asked for it. Absent, not
 *    present-and-refusing: a tool the model cannot see is a tool it cannot be
 *    talked into calling. The audit trail is for the operator.
 *
 * Tool descriptions here are written for the model that will call them. They
 * are security documentation at the point of use — the rules are stated where
 * the decision is made, not in a README nobody in the loop can read.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
    CallToolResult,
    ClientCapabilities,
    ElicitRequestFormParams,
    ElicitResult
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { fingerprint, redactTokenId } from './audit.js';
import type { AuditLog } from './audit.js';
import { Guard, GuardError, WRITE_TIERS } from './guard.js';
import type { Mutation } from './guard.js';
import { ContactStoreError } from './store.js';
import type { ContactStore, Stage } from './store.js';

/**
 * What the tool layer needs to do its job: a store to read, a guard to obey, a
 * log to answer to.
 */
export interface ToolDeps {
    store: ContactStore;
    guard: Guard;
    audit: AuditLog;
}

/** Options that change the shape of the registered tool surface. */
export interface ServerOptions {
    /**
     * Register `read_audit`, exposing the audit trail to the model.
     *
     * Defaults to `false`, and the default is the security posture: the audit
     * log records what the model asked for, so handing the model a tool to read
     * it back is a decision an operator makes deliberately, for a session where
     * that is useful — a demo, a debugging run, a self-review loop.
     */
    exposeAudit?: boolean;
}

/**
 * Every {@link Stage}, as an array zod can turn into an enum.
 *
 * Built from a `Record<Stage, true>` rather than written out as a literal
 * array, so adding a stage to the union in `store.ts` without adding it here is
 * a compile error — not a stage the tool surface silently refuses to accept.
 */
const STAGES: Record<Stage, true> = {
    New: true,
    Contacted: true,
    Qualified: true,
    Proposal: true,
    'Closed-Won': true,
    'Closed-Lost': true,
    'Closed-Lost-DNC': true
};

const STAGE_VALUES = Object.keys(STAGES) as [Stage, ...Stage[]];

/**
 * The wire schema for a mutation, mirroring the guard's {@link Mutation} union
 * field for field.
 *
 * It is a discriminated union rather than one object with optional fields for
 * the same reason the guard's type is: an `add_tag` mutation carrying a
 * `newStage` should not be *expressible*, so there is nothing to reconcile
 * later. The mirroring is enforced at compile time — the handlers below take
 * the guard's `Mutation` type, so a drift between this schema and that union
 * fails `tsc`, not a test at runtime.
 *
 * Note that this schema is a convenience for well-behaved callers, never the
 * security boundary. The guard re-validates every mutation it is handed,
 * because a tool argument arrives from across a trust boundary and a schema
 * that ran somewhere else is not evidence.
 */
const mutationSchema = z
    .discriminatedUnion('op', [
        z.object({
            op: z.literal('add_note'),
            contactId: z.string().min(1).describe('Id of the contact to annotate.'),
            text: z.string().describe('The note body to append.')
        }),
        z.object({
            op: z.literal('add_tag'),
            contactId: z.string().min(1).describe('Id of the contact to tag.'),
            tag: z.string().min(1).describe('The tag to add. Adding a tag that is already present is a no-op.')
        }),
        z.object({
            op: z.literal('remove_tag'),
            contactId: z.string().min(1).describe('Id of the contact to untag.'),
            tag: z.string().min(1).describe('The tag to remove. DESTRUCTIVE: the tag is not recoverable from the record afterwards.')
        }),
        z.object({
            op: z.literal('change_stage'),
            contactId: z.string().min(1).describe('Id of the contact to move.'),
            newStage: z
                .enum(STAGE_VALUES)
                .describe('The stage to move the contact to. DESTRUCTIVE: the previous stage is not recoverable from the record afterwards.')
        }),
        z.object({
            op: z.literal('delete_contact'),
            contactId: z.string().min(1).describe('Id of the contact to delete. DESTRUCTIVE and total: the record is gone.')
        })
    ])
    .describe(
        'One write, described as data. The op discriminates the payload: add_note needs text, ' +
            'add_tag and remove_tag need tag, change_stage needs newStage, delete_contact needs nothing further.'
    );

const getContactShape = {
    contactId: z.string().min(1).describe('The id of the contact to fetch, e.g. "c-003".')
};

const proposeWriteShape = {
    mutation: mutationSchema
};

const executeWriteShape = {
    tokenId: z.string().min(1).describe('The tokenId returned by propose_write for THIS exact mutation.'),
    mutation: mutationSchema
};

/** A successful tool result: the payload as JSON text. */
function ok(payload: unknown): CallToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Name the rule an error is enforcing, and quote the text it refused with.
 *
 * The store and the guard already write their own refusals — every error class
 * they raise names the rule in its own message. This function's whole job is to
 * take that apart into the two pieces the rest of the file needs: a rule name
 * for the record, and text for the caller. It never summarizes a refusal into
 * "operation failed", never swallows one into a success, and never reaches for
 * a stack trace: the caller is a model that has to decide what to do next, and
 * the name of the rule it hit is the only thing that helps it decide well.
 */
function classify(error: unknown): { rule: string; message: string } {
    if (error instanceof GuardError || error instanceof ContactStoreError) {
        return { rule: error.name, message: error.message };
    }

    // Anything else is a bug rather than a rule. Say so plainly, and pass along
    // the message only — never the stack.
    const detail = error instanceof Error ? error.message : String(error);
    return {
        rule: 'UnexpectedToolError',
        message: `the tool failed for a reason it does not model: ${detail}`
    };
}

/**
 * A refusal, as a tool result rather than a thrown exception — and as an audit
 * event, because a refusal nobody recorded is a refusal nobody can review.
 *
 * `tokenId` is the id the caller presented on this call, or `null` for tools
 * that take no token. When there is one, the refusal text is passed through
 * {@link redactTokenId} *before* it is either logged or returned. The guard
 * writes messages like `Token "…" was already used`, and a live warrant quoted
 * back in an error string is a warrant sitting in a transcript. The caller
 * already holds the id it presented, so it loses nothing by reading the
 * fingerprint instead.
 */
function refusal(
    deps: ToolDeps,
    tool: string,
    tokenId: string | null,
    rule: string,
    message: string
): CallToolResult {
    const text = tokenId === null ? message : redactTokenId(message, tokenId);
    deps.audit.append({ kind: 'refusal', tool, rule, message: text });
    return { isError: true, content: [{ type: 'text', text: `${rule}: ${text}` }] };
}

/** Run a handler body, turning any refusal into a recorded isError tool result. */
function attempt(
    deps: ToolDeps,
    tool: string,
    tokenId: string | null,
    body: () => CallToolResult
): CallToolResult {
    try {
        return body();
    } catch (error: unknown) {
        const { rule, message } = classify(error);
        return refusal(deps, tool, tokenId, rule, message);
    }
}

/** `list_contacts` — a read, straight through to the store. */
export function handleListContacts(deps: ToolDeps): CallToolResult {
    return attempt(deps, 'list_contacts', null, () => {
        const contacts = deps.store.listContacts();
        deps.audit.append({
            kind: 'read',
            tool: 'list_contacts',
            summary: `listed ${contacts.length} contacts`
        });
        return ok(contacts);
    });
}

/** `get_contact` — a read, straight through to the store. */
export function handleGetContact(deps: ToolDeps, args: { contactId: string }): CallToolResult {
    return attempt(deps, 'get_contact', null, () => {
        const contact = deps.store.getContact(args.contactId);
        deps.audit.append({
            kind: 'read',
            tool: 'get_contact',
            summary: `read contact ${args.contactId}`
        });
        return ok(contact);
    });
}

/**
 * `read_audit` — a read of the log itself, registered only on request.
 *
 * Reading the log is itself an event, so it is appended: an operator who wants
 * to know who looked can find out. The snapshot is taken before the append, so
 * a reply never contains the line describing its own delivery.
 */
export function handleReadAudit(deps: ToolDeps): CallToolResult {
    return attempt(deps, 'read_audit', null, () => {
        const events = deps.audit.list();
        deps.audit.append({
            kind: 'read',
            tool: 'read_audit',
            summary: `read ${events.length} audit events`
        });
        return ok({ count: events.length, events });
    });
}

/**
 * `propose_write` — mint a warrant. Touches no contact and writes nothing.
 *
 * The reply is deliberately thin: `tokenId`, `expiresAt`, and the `tier` of the
 * op. The {@link CapabilityToken} itself — which embeds the bound mutation and
 * its issue time — stays inside the guard. A model does not need the token's
 * contents to use it, and a token whose contents never enter a transcript
 * cannot be lifted out of one.
 *
 * `tier` is the one piece of guard-side judgment that does cross: it tells the
 * caller, before it commits, whether the write it just proposed is reversible
 * or destructive.
 *
 * This reply is also the single place in the program where a whole token id is
 * written down, and it has to be: the caller cannot spend a warrant it cannot
 * quote. The audit event for the same proposal carries only the fingerprint.
 */
export function handleProposeWrite(deps: ToolDeps, args: { mutation: Mutation }): CallToolResult {
    return attempt(deps, 'propose_write', null, () => {
        const token = deps.guard.proposeWrite(args.mutation);
        const tier = WRITE_TIERS[args.mutation.op];

        deps.audit.append({
            kind: 'propose',
            op: args.mutation.op,
            contactId: args.mutation.contactId,
            tier,
            tokenFingerprint: fingerprint(token.id)
        });

        return ok({ tokenId: token.id, expiresAt: token.expiresAt, tier });
    });
}

/** Apply a mutation the guard has already verified. Never called before that. */
function applyVerified(deps: ToolDeps, verified: Mutation): CallToolResult {
    switch (verified.op) {
        case 'add_note':
            return ok(deps.store.addNote(verified.contactId, verified.text));
        case 'add_tag':
            return ok(deps.store.addTag(verified.contactId, verified.tag));
        case 'remove_tag':
            return ok(deps.store.removeTag(verified.contactId, verified.tag));
        case 'change_stage':
            return ok(deps.store.changeStage(verified.contactId, verified.newStage));
        case 'delete_contact':
            deps.store.deleteContact(verified.contactId);
            return ok({ deleted: true, contactId: verified.contactId });
    }
}

/**
 * `execute_write` — present the warrant, then apply what the guard hands back.
 *
 * The order matters and is not negotiable: verify first, mutate second. Note
 * that what gets applied is the guard's return value, not `args.mutation` —
 * the guard returns a copy of the mutation *it* bound at propose time, so even
 * if the presented mutation somehow slipped past the comparison, the bound one
 * is what reaches the store.
 *
 * A verified warrant is still not a guarantee of success. The store enforces
 * its own floor (frozen do-not-contact records), and it enforces it after the
 * guard has already said yes. That refusal surfaces here like any other, and is
 * logged like any other — with the rule that produced it named.
 *
 * The success event is appended after the store call returns, so nothing is
 * recorded as done that was not done.
 */
export function handleExecuteWrite(
    deps: ToolDeps,
    args: { tokenId: string; mutation: Mutation }
): CallToolResult {
    return attempt(deps, 'execute_write', args.tokenId, () => {
        const verified = deps.guard.executeWrite(args.tokenId, args.mutation);
        const result = applyVerified(deps, verified);

        deps.audit.append({
            kind: 'execute_success',
            op: verified.op,
            contactId: verified.contactId,
            tokenFingerprint: fingerprint(args.tokenId)
        });

        return result;
    });
}

/**
 * The confirmation channel, narrowed to the two things this module asks of it.
 *
 * The SDK's `Server` satisfies this structurally — `buildServer` passes its own
 * `server.server` — but naming the seam keeps the rest of the file honest about
 * what it uses: it may ask what the client declared, and it may ask the user one
 * question. It cannot send notifications, sample, or otherwise take the wire for
 * a walk.
 */
export interface ConfirmationChannel {
    /** What the client declared at initialize time, or `undefined` before it. */
    getClientCapabilities(): ClientCapabilities | undefined;
    /** Ask the user a form question and wait for their answer. */
    elicitInput(params: ElicitRequestFormParams): Promise<ElicitResult>;
}

/** The field the confirmation form asks for, and the only one it accepts. */
const CONFIRM_FIELD = 'confirm';

/**
 * Whether this op must be confirmed by a human before it executes.
 *
 * Written as "not reversible" rather than "is destructive" deliberately. Both
 * readings pick out exactly `remove_tag`, `change_stage` and `delete_contact`
 * today, because every op in {@link WRITE_TIERS} is one or the other — but an op
 * this function has never heard of falls on the confirm side, not the silent
 * side. Fail-closed applies to the tier table too.
 */
function requiresConfirmation(op: Mutation['op']): boolean {
    return WRITE_TIERS[op] !== 'reversible';
}

/**
 * Whether the connected client advertised a form-elicitation channel.
 *
 * The SDK normalizes a bare `elicitation: {}` capability into `{ form: {} }`
 * when it parses the initialize request, so an older client that declares
 * elicitation without naming a mode still reads as form-capable here. A client
 * that declared only `url` mode does not: it has a channel, but not one this
 * server knows how to ask a yes/no question over, and pretending otherwise
 * would mean an unconfirmed destructive write.
 */
function supportsFormElicitation(capabilities: ClientCapabilities | undefined): boolean {
    return capabilities?.elicitation?.form !== undefined;
}

/** ` (Idris Vantol)`, or nothing at all if the id resolves to no contact. */
function nameSuffix(deps: ToolDeps, contactId: string): string {
    try {
        return ` (${deps.store.getContact(contactId).name})`;
    } catch {
        // A confirmation prompt is not the place to raise a lookup failure. The
        // store will refuse the write on its own terms a moment from now.
        return '';
    }
}

/**
 * The exact sentence the user is asked to agree to.
 *
 * It names the operation, the contact, and the payload, because a confirmation
 * dialog that says "allow this write?" is not a confirmation of anything. The
 * op name is spelled out verbatim so the sentence the human reads and the tool
 * call the model made can be matched against each other by eye.
 */
function confirmationSentence(deps: ToolDeps, mutation: Mutation): string {
    const target = `contact ${mutation.contactId}${nameSuffix(deps, mutation.contactId)}`;

    switch (mutation.op) {
        case 'add_note':
            return `add_note: append the note ${JSON.stringify(mutation.text)} to ${target}?`;
        case 'add_tag':
            return `add_tag: add the tag ${JSON.stringify(mutation.tag)} to ${target}?`;
        case 'remove_tag':
            return (
                `remove_tag: remove the tag ${JSON.stringify(mutation.tag)} from ${target}? ` +
                `DESTRUCTIVE: the tag is not recoverable from the record afterwards.`
            );
        case 'change_stage':
            return (
                `change_stage: move ${target} to stage ${JSON.stringify(mutation.newStage)}? ` +
                `DESTRUCTIVE: the previous stage is not recoverable from the record afterwards.`
            );
        case 'delete_contact':
            return `delete_contact: delete ${target}? This cannot be undone.`;
    }
}

/**
 * The elicitation request for one destructive mutation: one required boolean.
 *
 * The form is deliberately the smallest thing that can carry a decision. There
 * is no free-text field to smuggle instructions through and no second question
 * whose answer could be read as consent to the first — the user says yes to
 * this exact sentence, or they do not.
 */
function confirmationRequest(deps: ToolDeps, mutation: Mutation): ElicitRequestFormParams {
    const sentence = confirmationSentence(deps, mutation);

    return {
        mode: 'form',
        message: `Confirm a destructive CRM write — ${sentence}`,
        requestedSchema: {
            type: 'object',
            properties: {
                [CONFIRM_FIELD]: {
                    type: 'boolean',
                    title: 'Confirm this write',
                    description: sentence
                }
            },
            required: [CONFIRM_FIELD]
        }
    };
}

/**
 * `execute_write` as the wire sees it: confirm first, then verify, then write.
 *
 * **Order is the whole design here.** The elicitation runs against the mutation
 * from the tool arguments, *before* {@link Guard.executeWrite} is ever called,
 * and only a confirmed mutation is handed on. That is not a stylistic choice:
 * the guard's token is single-use, and it is spent the moment it is presented.
 * Asking afterwards would mean a user who says "no" has still burned their
 * warrant — the refusal would cost them the write they were entitled to make,
 * and every declined prompt would force a fresh `propose_write`. Asking first
 * means declining is free: the token is untouched, still bound to the same
 * mutation, still good until it expires.
 *
 * The three ways a confirmation can fail to be a yes are kept distinct in the
 * refusal text — answered no, declined the prompt, cancelled it — because they
 * mean different things to whoever reads the transcript later. None of them
 * fall through to the write.
 *
 * Both halves of the exchange are logged: a `confirm_requested` event when the
 * question goes out and a `confirm_outcome` event when an answer comes back, so
 * the record shows that a human was in the loop and what they said. Two cases
 * deliberately produce no `confirm_outcome`: a client with no channel is asked
 * nothing, so its outcome is the refusal itself (`refused_no_channel`), and a
 * channel that broke mid-question returned no answer to record — only the
 * refusal is written, because inventing an outcome for a question nobody
 * answered is exactly the kind of thing an audit log must not do.
 *
 * Reversible writes (`add_note`, `add_tag`) skip all of this and go straight to
 * the warrant check. Nothing is asked, because nothing is at stake that cannot
 * be undone by hand.
 */
export async function handleConfirmedExecuteWrite(
    deps: ToolDeps,
    channel: ConfirmationChannel,
    args: { tokenId: string; mutation: Mutation }
): Promise<CallToolResult> {
    if (!requiresConfirmation(args.mutation.op)) {
        return handleExecuteWrite(deps, args);
    }

    const { op, contactId } = args.mutation;
    const attempted = `Refused ${op} on contact ${contactId}`;

    if (!supportsFormElicitation(channel.getClientCapabilities())) {
        // Fail closed. The alternative — executing because nobody could be
        // asked — is exactly the degradation this gate exists to prevent.
        deps.audit.append({ kind: 'confirm_outcome', op, contactId, outcome: 'refused_no_channel' });
        return refusal(
            deps,
            'execute_write',
            args.tokenId,
            'ConfirmationUnavailableError',
            `${attempted}: this server requires an interactive confirmation channel for destructive ` +
                `operations, and the connected client does not advertise one (no form elicitation ` +
                `capability was declared at initialize time). ` +
                `Rule: destructive-tier writes (remove_tag, change_stage, delete_contact) are confirmed ` +
                `by the user before anything is written, and a client that cannot ask cannot execute ` +
                `them — the server refuses rather than writing unconfirmed. The reversible tier ` +
                `(add_note, add_tag) remains fully available. Token "${args.tokenId}" was not spent.`
        );
    }

    deps.audit.append({ kind: 'confirm_requested', op, contactId });

    let outcome: ElicitResult;
    try {
        outcome = await channel.elicitInput(confirmationRequest(deps, args.mutation));
    } catch (error: unknown) {
        // A confirmation that could not be asked is not a confirmation.
        const detail = error instanceof Error ? error.message : String(error);
        return refusal(
            deps,
            'execute_write',
            args.tokenId,
            'ConfirmationChannelError',
            `${attempted}: the confirmation request to the client failed: ${detail}. ` +
                `Rule: destructive-tier writes execute only on a confirmation that was actually ` +
                `received — a broken channel fails closed. Token "${args.tokenId}" was not spent.`
        );
    }

    const unspent =
        `The mutation was not applied, and token "${args.tokenId}" was NOT spent: the confirmation ` +
        `runs before the guard is consulted, so the warrant is still bound to this mutation and ` +
        `still usable until it expires. Re-run execute_write with the same tokenId if the user ` +
        `changes their mind.`;

    if (outcome.action !== 'accept') {
        const declined = outcome.action === 'decline';
        deps.audit.append({
            kind: 'confirm_outcome',
            op,
            contactId,
            outcome: declined ? 'declined' : 'cancelled'
        });
        return refusal(
            deps,
            'execute_write',
            args.tokenId,
            'ConfirmationDeclinedError',
            `${attempted}: the user ${declined ? 'declined' : 'cancelled'} the ` +
                `confirmation prompt. ` +
                `Rule: destructive-tier writes proceed only on an explicit confirmation; anything ` +
                `that is not a yes is a no, and it is not retried by asking again. ${unspent}`
        );
    }

    if (outcome.content?.[CONFIRM_FIELD] !== true) {
        deps.audit.append({ kind: 'confirm_outcome', op, contactId, outcome: 'declined' });
        return refusal(
            deps,
            'execute_write',
            args.tokenId,
            'ConfirmationDeclinedError',
            `${attempted}: the user was asked to confirm this write and answered no. ` +
                `Rule: destructive-tier writes proceed only on an explicit confirmation. ${unspent}`
        );
    }

    deps.audit.append({ kind: 'confirm_outcome', op, contactId, outcome: 'confirmed' });
    return handleExecuteWrite(deps, args);
}

/**
 * Build the MCP server: four tools, two of which are halves of one write — and
 * a fifth that is not registered unless it is asked for.
 *
 * Every handler is a thin lambda over the exported functions above, so the
 * behaviour under test is the behaviour that ships — the tests drive the same
 * functions the SDK does, not a parallel copy of them.
 *
 * `execute_write` is wired to {@link handleConfirmedExecuteWrite} rather than to
 * {@link handleExecuteWrite}: the confirmation gate is part of the tool, not an
 * optional wrapper a caller could forget. The server hands itself in as the
 * confirmation channel, so the capability check reads whatever the *currently
 * connected* client declared — not a snapshot taken at build time.
 *
 * `read_audit` is registered only when `options.exposeAudit` is true, and the
 * distinction between "not registered" and "registered but refusing" is the
 * whole point. A tool that exists and says no still tells the model the log is
 * there, still invites a retry, still shows up in a tool list that a prompt
 * injection can read. A tool that was never registered is not part of the
 * conversation at all.
 */
export function buildServer(deps: ToolDeps, options: ServerOptions = {}): McpServer {
    const server = new McpServer({ name: 'mcp-capability-guard', version: '0.1.0' });

    server.registerTool(
        'list_contacts',
        {
            title: 'List contacts',
            description:
                'Read every contact in the CRM. Takes no arguments and changes nothing, so it needs no ' +
                'capability token. Contacts in the Closed-Lost-DNC stage are returned like any other, but ' +
                'they are frozen records: no write of any kind will succeed against them.',
            inputSchema: {},
            annotations: { readOnlyHint: true }
        },
        () => handleListContacts(deps)
    );

    server.registerTool(
        'get_contact',
        {
            title: 'Get one contact',
            description:
                'Read a single contact by id. Changes nothing, so it needs no capability token. ' +
                'An unknown id is refused with ContactNotFoundError rather than an empty result — ' +
                'if you get that refusal, the contact does not exist; do not retry with a guessed id.',
            inputSchema: getContactShape,
            annotations: { readOnlyHint: true }
        },
        (args) => handleGetContact(deps, args)
    );

    server.registerTool(
        'propose_write',
        {
            title: 'Propose a write (step 1 of 2)',
            description:
                'Request authorization for ONE write. This is the only way to write anything: there are no ' +
                'direct write tools, and nothing you do here changes any contact. It mints a capability ' +
                'token bound to exactly the mutation you pass, and returns { tokenId, expiresAt, tier }. ' +
                'Pass that tokenId back to execute_write ALONG WITH THE IDENTICAL MUTATION to perform the write. ' +
                'The rules the token enforces, so you can plan around them: it is single-use (one token, one ' +
                'write, ever); it is time-bound (unusable at or after expiresAt — propose immediately before ' +
                'you execute, not in advance); and it is mutation-bound (presenting it with any different ' +
                'mutation BURNS it permanently, so it cannot even perform its own correct mutation afterwards — ' +
                'do not reuse or repurpose a tokenId). The returned tier tells you what you are about to do: ' +
                '"reversible" (add_note, add_tag) can be undone by hand; "destructive" (remove_tag, ' +
                'change_stage, delete_contact) discards information that cannot be recovered from the record. ' +
                'This reply is the only place the full tokenId is ever written down: refusals and the audit ' +
                'trail name tokens by a truncated fingerprint, so keep the tokenId from this reply if you ' +
                'intend to execute — you cannot recover it from anywhere else.',
            inputSchema: proposeWriteShape,
            annotations: { readOnlyHint: true, destructiveHint: false }
        },
        (args) => handleProposeWrite(deps, args)
    );

    server.registerTool(
        'execute_write',
        {
            title: 'Execute a proposed write (step 2 of 2)',
            description:
                'Perform a write that propose_write already authorized. Pass the tokenId you were given ' +
                'together with the SAME mutation you proposed — the token is verified against the mutation ' +
                'field by field before anything is written. Typical refusals, each naming its rule: ' +
                'UnknownTokenError (that tokenId was never minted — you cannot invent one), ' +
                'ExpiredTokenError (the TTL ran out; propose again), ReplayedTokenError (that token was ' +
                'already spent, by a successful write or by being burned), and MutationMismatchError (the ' +
                'mutation is not the one the token authorizes — this also burns the token; propose a fresh ' +
                'one for the write you actually want). Refusal messages name the token by a truncated ' +
                'fingerprint rather than in full; that is deliberate, and it is not a sign you sent the ' +
                'wrong id. A verified token is still not a promise of success: ' +
                'the store refuses all writes to contacts in the Closed-Lost-DNC stage with ' +
                'NeverWriteStateError, no matter what token you hold. Returns the updated contact, or a ' +
                'deletion acknowledgment for delete_contact. ' +
                'One more rule applies to the destructive tier (remove_tag, change_stage, ' +
                'delete_contact) and only to it: before any such write is performed, this server asks ' +
                'the human operator to confirm it, by name, through your client. If they say no, or ' +
                'dismiss the prompt, the write is refused with ConfirmationDeclinedError and the token ' +
                'is NOT spent — you may present the same tokenId again if they change their mind, but ' +
                'do not re-ask on your own initiative; a refusal is an answer. If your client did not ' +
                'declare the elicitation capability there is nobody to ask, and every destructive write ' +
                'is refused with ConfirmationUnavailableError no matter how valid the token is; the ' +
                'reversible tier (add_note, add_tag) still works and needs no confirmation.',
            inputSchema: executeWriteShape
        },
        (args) => handleConfirmedExecuteWrite(deps, server.server, args)
    );

    if (options.exposeAudit === true) {
        server.registerTool(
            'read_audit',
            {
                title: 'Read the audit trail',
                description:
                    'Read the append-only audit log for this session: every read, every proposed write, ' +
                    'every confirmation asked and answered, every write performed, and every refusal with ' +
                    'the name of the rule that produced it. Takes no arguments and changes nothing, so it ' +
                    'needs no capability token — but reading the log is itself recorded in it. Tokens appear ' +
                    'only as truncated fingerprints: the log correlates events about the same warrant and ' +
                    'cannot be used to recover or replay one. The log cannot be edited or cleared through ' +
                    'this or any other tool.',
                inputSchema: {},
                annotations: { readOnlyHint: true }
            },
            () => handleReadAudit(deps)
        );
    }

    return server;
}
