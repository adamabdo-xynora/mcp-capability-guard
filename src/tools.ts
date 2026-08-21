/**
 * The MCP tool surface — the only module in this project that imports the SDK.
 *
 * Everything below this file is protocol-free: the store knows about contacts,
 * the guard knows about tokens, and neither knows it is being spoken to over
 * MCP. This module is the wiring, and only the wiring. It re-implements no
 * rule that already lives underneath it: it does not decide what a token
 * authorizes (the guard does), and it does not decide which records are frozen
 * (the store does). What it adds is a *shape* — a tiered surface in which the
 * dangerous half of the API is unreachable in one step.
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
 * Tool descriptions here are written for the model that will call them. They
 * are security documentation at the point of use — the rules are stated where
 * the decision is made, not in a README nobody in the loop can read.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { Guard, GuardError, WRITE_TIERS } from './guard.js';
import type { Mutation } from './guard.js';
import { ContactStoreError } from './store.js';
import type { ContactStore, Stage } from './store.js';

/** What the tool layer needs to do its job: a store to read, a guard to obey. */
export interface ToolDeps {
    store: ContactStore;
    guard: Guard;
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
 * A refusal, as a tool result rather than a thrown exception.
 *
 * The store and the guard already write their own refusals — every error class
 * they raise names the rule it is enforcing. This function's whole job is to
 * carry that text across the wire intact. It never summarizes a refusal into
 * "operation failed", never swallows one into a success, and never answers with
 * a stack trace: the caller is a model that has to decide what to do next, and
 * the name of the rule it hit is the only thing that helps it decide well.
 */
function refuse(error: unknown): CallToolResult {
    if (error instanceof GuardError || error instanceof ContactStoreError) {
        return {
            isError: true,
            content: [{ type: 'text', text: `${error.name}: ${error.message}` }]
        };
    }

    // Anything else is a bug rather than a rule. Say so plainly, and pass along
    // the message only — never the stack.
    const detail = error instanceof Error ? error.message : String(error);
    return {
        isError: true,
        content: [
            {
                type: 'text',
                text: `UnexpectedToolError: the tool failed for a reason it does not model: ${detail}`
            }
        ]
    };
}

/** Run a handler body, turning any refusal into an isError tool result. */
function attempt(body: () => CallToolResult): CallToolResult {
    try {
        return body();
    } catch (error: unknown) {
        return refuse(error);
    }
}

/** `list_contacts` — a read, straight through to the store. */
export function handleListContacts(deps: ToolDeps): CallToolResult {
    return attempt(() => ok(deps.store.listContacts()));
}

/** `get_contact` — a read, straight through to the store. */
export function handleGetContact(deps: ToolDeps, args: { contactId: string }): CallToolResult {
    return attempt(() => ok(deps.store.getContact(args.contactId)));
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
 */
export function handleProposeWrite(deps: ToolDeps, args: { mutation: Mutation }): CallToolResult {
    return attempt(() => {
        const token = deps.guard.proposeWrite(args.mutation);
        return ok({
            tokenId: token.id,
            expiresAt: token.expiresAt,
            tier: WRITE_TIERS[args.mutation.op]
        });
    });
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
 * guard has already said yes. That refusal surfaces here like any other.
 */
export function handleExecuteWrite(
    deps: ToolDeps,
    args: { tokenId: string; mutation: Mutation }
): CallToolResult {
    return attempt(() => {
        const verified = deps.guard.executeWrite(args.tokenId, args.mutation);

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
    });
}

/**
 * Build the MCP server: four tools, two of which are halves of one write.
 *
 * Every handler is a thin lambda over the exported functions above, so the
 * behaviour under test is the behaviour that ships — the tests drive the same
 * functions the SDK does, not a parallel copy of them.
 */
export function buildServer(deps: ToolDeps): McpServer {
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
                'change_stage, delete_contact) discards information that cannot be recovered from the record.',
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
                'one for the write you actually want). A verified token is still not a promise of success: ' +
                'the store refuses all writes to contacts in the Closed-Lost-DNC stage with ' +
                'NeverWriteStateError, no matter what token you hold. Returns the updated contact, or a ' +
                'deletion acknowledgment for delete_contact.',
            inputSchema: executeWriteShape
        },
        (args) => handleExecuteWrite(deps, args)
    );

    return server;
}
