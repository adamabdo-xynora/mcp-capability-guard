import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
    CallToolResult,
    ElicitRequestFormParams,
    ElicitResult
} from '@modelcontextprotocol/sdk/types.js';

import { Guard } from '../src/guard.js';
import type { Mutation } from '../src/guard.js';
import { InMemoryContactStore } from '../src/store.js';
import type { Contact } from '../src/store.js';
import {
    buildServer,
    handleExecuteWrite,
    handleGetContact,
    handleListContacts,
    handleProposeWrite
} from '../src/tools.js';
import type { ToolDeps } from '../src/tools.js';

const TTL = 60_000;
const START = 1_700_000_000_000;

/** A clock the test drives by hand, so expiry is exact rather than approximate. */
function fakeClock(start = START) {
    let current = start;
    return {
        now: () => current,
        advance(ms: number) {
            current += ms;
        }
    };
}

/** Sequential ids, so a test can name a token before it exists. */
function sequentialIds(prefix = 'tok') {
    let n = 0;
    return () => `${prefix}-${++n}`;
}

function makeDeps() {
    const clock = fakeClock();
    const store = new InMemoryContactStore();
    const guard = new Guard({ ttlMs: TTL }, { now: clock.now, generateId: sequentialIds() });
    return { deps: { store, guard } satisfies ToolDeps, store, guard, clock };
}

/** The text of a tool result — the only channel a refusal travels on. */
function textOf(result: CallToolResult): string {
    const first = result.content[0];
    if (first === undefined || first.type !== 'text') {
        throw new Error(`expected a text content block, received ${JSON.stringify(result.content)}`);
    }
    return first.text;
}

/** The JSON payload of a successful tool result. */
function payloadOf(result: CallToolResult): unknown {
    expect(result.isError).toBeFalsy();
    return JSON.parse(textOf(result));
}

function contactOf(result: CallToolResult): Contact {
    return payloadOf(result) as Contact;
}

/** propose_write's reply, as the model sees it. */
interface Proposal {
    tokenId: string;
    expiresAt: number;
    tier: string;
}

function proposalOf(result: CallToolResult): Proposal {
    return payloadOf(result) as Proposal;
}

/** One mutation of every op, each aimed at a contact the seed data can prove changed. */
const EVERY_OP: Mutation[] = [
    { op: 'add_note', contactId: 'c-001', text: 'Mailed the dry-goods catalog.' },
    { op: 'add_tag', contactId: 'c-001', tag: 'vip' },
    { op: 'remove_tag', contactId: 'c-003', tag: 'net-30' },
    { op: 'change_stage', contactId: 'c-004', newStage: 'Closed-Won' },
    { op: 'delete_contact', contactId: 'c-006' }
];

describe('tools', () => {
    describe('reads go straight to the store', () => {
        it('list_contacts returns the whole seed set', () => {
            const { deps } = makeDeps();

            const contacts = payloadOf(handleListContacts(deps)) as Contact[];

            expect(contacts).toHaveLength(7);
            expect(contacts.map((contact) => contact.id)).toEqual([
                'c-001',
                'c-002',
                'c-003',
                'c-004',
                'c-005',
                'c-006',
                'c-007'
            ]);
            expect(contacts[6]?.stage).toBe('Closed-Lost-DNC');
        });

        it('get_contact returns one seeded contact', () => {
            const { deps } = makeDeps();

            const contact = contactOf(handleGetContact(deps, { contactId: 'c-003' }));

            expect(contact.name).toBe('Junia Halverstam');
            expect(contact.company).toBe('Bellhollow Markets');
            expect(contact.stage).toBe('Qualified');
            expect(contact.tags).toContain('net-30');
        });

        it('get_contact refuses an unknown id by name, not with an empty result', () => {
            const { deps } = makeDeps();

            const result = handleGetContact(deps, { contactId: 'c-999' });

            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain('ContactNotFoundError');
            expect(textOf(result)).toContain('c-999');
        });
    });

    describe('propose -> execute happy path', () => {
        it('add_note appends a note to the store', () => {
            const { deps, store } = makeDeps();
            const mutation = EVERY_OP[0]!;

            const { tokenId, tier } = proposalOf(handleProposeWrite(deps, { mutation }));
            expect(tier).toBe('reversible');

            const contact = contactOf(handleExecuteWrite(deps, { tokenId, mutation }));

            expect(contact.notes).toHaveLength(2);
            expect(contact.notes[1]?.text).toBe('Mailed the dry-goods catalog.');
            expect(store.getContact('c-001').notes).toHaveLength(2);
        });

        it('add_tag adds a tag to the store', () => {
            const { deps, store } = makeDeps();
            const mutation = EVERY_OP[1]!;

            const { tokenId, tier } = proposalOf(handleProposeWrite(deps, { mutation }));
            expect(tier).toBe('reversible');

            const contact = contactOf(handleExecuteWrite(deps, { tokenId, mutation }));

            expect(contact.tags).toContain('vip');
            expect(store.getContact('c-001').tags).toContain('vip');
        });

        it('remove_tag removes a tag from the store', () => {
            const { deps, store } = makeDeps();
            const mutation = EVERY_OP[2]!;

            const { tokenId, tier } = proposalOf(handleProposeWrite(deps, { mutation }));
            expect(tier).toBe('destructive');

            const contact = contactOf(handleExecuteWrite(deps, { tokenId, mutation }));

            expect(contact.tags).not.toContain('net-30');
            expect(store.getContact('c-003').tags).not.toContain('net-30');
        });

        it('change_stage moves the contact in the store', () => {
            const { deps, store } = makeDeps();
            const mutation = EVERY_OP[3]!;

            const { tokenId, tier } = proposalOf(handleProposeWrite(deps, { mutation }));
            expect(tier).toBe('destructive');

            const contact = contactOf(handleExecuteWrite(deps, { tokenId, mutation }));

            expect(contact.stage).toBe('Closed-Won');
            expect(store.getContact('c-004').stage).toBe('Closed-Won');
        });

        it('delete_contact removes the contact from the store and acknowledges', () => {
            const { deps, store } = makeDeps();
            const mutation = EVERY_OP[4]!;

            const { tokenId, tier } = proposalOf(handleProposeWrite(deps, { mutation }));
            expect(tier).toBe('destructive');

            const result = handleExecuteWrite(deps, { tokenId, mutation });

            expect(payloadOf(result)).toEqual({ deleted: true, contactId: 'c-006' });
            expect(store.listContacts().map((contact) => contact.id)).not.toContain('c-006');
            expect(textOf(handleGetContact(deps, { contactId: 'c-006' }))).toContain('ContactNotFoundError');
        });

        it('propose_write alone writes nothing', () => {
            const { deps, store } = makeDeps();

            handleProposeWrite(deps, { mutation: EVERY_OP[0]! });
            handleProposeWrite(deps, { mutation: EVERY_OP[4]! });

            expect(store.getContact('c-001').notes).toHaveLength(1);
            expect(store.listContacts()).toHaveLength(7);
        });
    });

    describe('a write without a valid warrant is refused', () => {
        it('refuses a tokenId that was never minted', () => {
            const { deps, store } = makeDeps();

            const result = handleExecuteWrite(deps, {
                tokenId: 'tok-i-made-this-up',
                mutation: EVERY_OP[0]!
            });

            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain('UnknownTokenError');
            expect(textOf(result)).toContain('tok-i-made-this-up');
            expect(store.getContact('c-001').notes).toHaveLength(1);
        });

        it('refuses a replayed token, leaving the second write unapplied', () => {
            const { deps, store } = makeDeps();
            const mutation = EVERY_OP[1]!;

            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation }));
            expect(handleExecuteWrite(deps, { tokenId, mutation }).isError).toBeFalsy();

            const replay = handleExecuteWrite(deps, { tokenId, mutation });

            expect(replay.isError).toBe(true);
            expect(textOf(replay)).toContain('ReplayedTokenError');
            expect(store.getContact('c-001').tags.filter((tag) => tag === 'vip')).toHaveLength(1);
        });

        it('refuses an expired token', () => {
            const { deps, clock, store } = makeDeps();
            const mutation = EVERY_OP[0]!;

            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation }));
            clock.advance(TTL);

            const result = handleExecuteWrite(deps, { tokenId, mutation });

            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain('ExpiredTokenError');
            expect(store.getContact('c-001').notes).toHaveLength(1);
        });

        it('refuses a token presented with a different mutation, and names the field', () => {
            const { deps, store } = makeDeps();
            const proposed: Mutation = { op: 'add_tag', contactId: 'c-001', tag: 'vip' };
            const substituted: Mutation = { op: 'add_tag', contactId: 'c-001', tag: 'do-not-contact' };

            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation: proposed }));

            const result = handleExecuteWrite(deps, { tokenId, mutation: substituted });

            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain('MutationMismatchError');
            expect(textOf(result)).toContain('payload');
            expect(textOf(result)).toContain('"do-not-contact"');
            expect(store.getContact('c-001').tags).not.toContain('do-not-contact');

            // The mismatch burned the token: even its own bound mutation is dead.
            const retry = handleExecuteWrite(deps, { tokenId, mutation: proposed });
            expect(retry.isError).toBe(true);
            expect(textOf(retry)).toContain('ReplayedTokenError');
            expect(store.getContact('c-001').tags).not.toContain('vip');
        });

        it('names contactId when a token is redirected at a different contact', () => {
            const { deps, store } = makeDeps();
            const proposed: Mutation = { op: 'delete_contact', contactId: 'c-006' };
            const redirected: Mutation = { op: 'delete_contact', contactId: 'c-005' };

            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation: proposed }));

            const result = handleExecuteWrite(deps, { tokenId, mutation: redirected });

            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain('MutationMismatchError');
            expect(textOf(result)).toContain('contactId');
            expect(store.listContacts()).toHaveLength(7);
        });
    });

    describe('defense in depth', () => {
        it('lets the guard approve a write to the frozen c-007, and the store still refuses it', () => {
            const { deps, store } = makeDeps();
            const mutation: Mutation = { op: 'add_note', contactId: 'c-007', text: 'Following up anyway.' };

            // Layer 1: the guard knows nothing about contacts, so it mints happily.
            const proposal = handleProposeWrite(deps, { mutation });
            expect(proposal.isError).toBeFalsy();
            const { tokenId } = proposalOf(proposal);
            expect(tokenId).toBeTruthy();

            // Layer 2: the store is the floor, and it refuses a fully verified warrant.
            const result = handleExecuteWrite(deps, { tokenId, mutation });

            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain('NeverWriteStateError');
            expect(textOf(result)).toContain('NEVER_WRITE_STAGES');
            expect(textOf(result)).toContain('Closed-Lost-DNC');
            expect(store.getContact('c-007').notes).toHaveLength(2);
        });

        it('refuses even deletion of the frozen contact after the guard approves', () => {
            const { deps, store } = makeDeps();
            const mutation: Mutation = { op: 'delete_contact', contactId: 'c-007' };

            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation }));
            const result = handleExecuteWrite(deps, { tokenId, mutation });

            expect(result.isError).toBe(true);
            expect(textOf(result)).toContain('NeverWriteStateError');
            expect(store.listContacts().map((contact) => contact.id)).toContain('c-007');
        });
    });

    describe('token hygiene', () => {
        it('returns only tokenId, expiresAt and tier — never the token object', () => {
            const { deps } = makeDeps();
            const mutation = EVERY_OP[0]!;

            const result = handleProposeWrite(deps, { mutation });
            const raw = textOf(result);
            const parsed = payloadOf(result) as Record<string, unknown>;

            expect(Object.keys(parsed).sort()).toEqual(['expiresAt', 'tier', 'tokenId']);
            expect(parsed).not.toHaveProperty('mutation');
            expect(parsed).not.toHaveProperty('issuedAt');
            expect(raw).not.toContain('mutation');
            expect(raw).not.toContain('issuedAt');
            expect(parsed['expiresAt']).toBe(START + TTL);
        });

        it('leaks no bound mutation for any op', () => {
            const { deps } = makeDeps();

            for (const mutation of EVERY_OP) {
                const raw = textOf(handleProposeWrite(deps, { mutation }));
                expect(raw).not.toContain('mutation');
                expect(raw).not.toContain('issuedAt');
                expect(raw).not.toContain(mutation.contactId);
                expect(raw).not.toContain(mutation.op);
            }
        });
    });

    describe('buildServer', () => {
        it('wires the four tools onto an MCP server', () => {
            const { deps } = makeDeps();

            const server = buildServer(deps);

            expect(server.server).toBeDefined();
            expect(server.isConnected()).toBe(false);
        });
    });

    /**
     * These tests drive the real protocol, because the rule under test IS the
     * protocol: a capability the client declares at initialize time, and a
     * request the server sends back down the same connection mid-tool-call.
     * A hand-rolled fake could not get either half wrong in the ways that
     * matter, so the SDK's own in-memory transport pair carries a real Client
     * talking to the real server built by buildServer.
     */
    describe('destructive-tier confirmation', () => {
        /** The fake user: what they answer when the server asks. */
        type Responder = (params: ElicitRequestFormParams) => ElicitResult;

        const ACCEPTS: Responder = () => ({ action: 'accept', content: { confirm: true } });

        /**
         * A connected client/server pair.
         *
         * `elicitation: false` builds a client that declares no elicitation
         * capability at all — not one that declines, one that cannot be asked.
         * The SDK refuses to register an elicitation handler on such a client,
         * which is exactly the shape of the client this rule guards against.
         */
        async function connect(options: { elicitation: boolean; respond?: Responder }) {
            const harness = makeDeps();
            const server = buildServer(harness.deps);
            const requests: ElicitRequestFormParams[] = [];
            let responder: Responder = options.respond ?? ACCEPTS;

            const client = new Client(
                { name: 'confirmation-test-client', version: '0.0.0' },
                { capabilities: options.elicitation ? { elicitation: {} } : {} }
            );

            if (options.elicitation) {
                client.setRequestHandler(ElicitRequestSchema, (request) => {
                    const params = request.params as ElicitRequestFormParams;
                    requests.push(params);
                    return responder(params);
                });
            }

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
                return (await client.callTool({ name, arguments: args })) as CallToolResult;
            }

            /** propose_write over the wire, returning the tokenId. */
            async function propose(mutation: Mutation): Promise<string> {
                return proposalOf(await call('propose_write', { mutation })).tokenId;
            }

            return {
                ...harness,
                requests,
                call,
                propose,
                answerWith(next: Responder) {
                    responder = next;
                },
                async close() {
                    await client.close();
                    await server.close();
                }
            };
        }

        it('asks before a destructive write, and applies it once the user confirms', async () => {
            const wire = await connect({ elicitation: true });
            try {
                const mutation = EVERY_OP[3]!; // change_stage c-004 -> Closed-Won

                const tokenId = await wire.propose(mutation);
                const result = await wire.call('execute_write', { tokenId, mutation });

                expect(result.isError).toBeFalsy();
                expect(contactOf(result).stage).toBe('Closed-Won');
                expect(wire.store.getContact('c-004').stage).toBe('Closed-Won');
                expect(wire.requests).toHaveLength(1);
            } finally {
                await wire.close();
            }
        });

        it('states the operation, the contact and the payload in the form it sends', async () => {
            const wire = await connect({ elicitation: true });
            try {
                const mutation = EVERY_OP[4]!; // delete_contact c-006

                const tokenId = await wire.propose(mutation);
                expect((await wire.call('execute_write', { tokenId, mutation })).isError).toBeFalsy();

                const params = wire.requests[0]!;
                const schema = params.requestedSchema;
                const field = schema.properties[
                    'confirm'
                ] as { type: string; description?: string } | undefined;

                // One required boolean named confirm, and nothing else to answer.
                expect(Object.keys(schema.properties)).toEqual(['confirm']);
                expect(schema.required).toEqual(['confirm']);
                expect(field?.type).toBe('boolean');

                // The description says exactly what is about to happen.
                expect(field?.description).toContain('delete_contact');
                expect(field?.description).toContain('c-006');
                expect(field?.description).toContain('Tobias Merrigold');
                expect(params.message).toContain('c-006');
            } finally {
                await wire.close();
            }
        });

        it('names the payload of a remove_tag confirmation', async () => {
            const wire = await connect({ elicitation: true });
            try {
                const mutation = EVERY_OP[2]!; // remove_tag net-30 from c-003

                const tokenId = await wire.propose(mutation);
                expect((await wire.call('execute_write', { tokenId, mutation })).isError).toBeFalsy();

                const field = wire.requests[0]!.requestedSchema.properties['confirm'] as {
                    description?: string;
                };

                expect(field.description).toContain('remove_tag');
                expect(field.description).toContain('c-003');
                expect(field.description).toContain('net-30');
                expect(wire.store.getContact('c-003').tags).not.toContain('net-30');
            } finally {
                await wire.close();
            }
        });

        it('refuses when the user answers no, and leaves the token unspent', async () => {
            const wire = await connect({
                elicitation: true,
                respond: () => ({ action: 'accept', content: { confirm: false } })
            });
            try {
                const mutation = EVERY_OP[4]!; // delete_contact c-006

                const tokenId = await wire.propose(mutation);
                const refused = await wire.call('execute_write', { tokenId, mutation });

                expect(refused.isError).toBe(true);
                expect(textOf(refused)).toContain('ConfirmationDeclinedError');
                expect(textOf(refused)).toContain('answered no');
                expect(wire.store.listContacts().map((contact) => contact.id)).toContain('c-006');

                // The point of eliciting BEFORE the guard: a refusal costs the
                // caller nothing. The same warrant is still good, so the same
                // tokenId executes the moment the user changes their mind.
                wire.answerWith(ACCEPTS);
                const confirmed = await wire.call('execute_write', { tokenId, mutation });

                expect(payloadOf(confirmed)).toEqual({ deleted: true, contactId: 'c-006' });
                expect(wire.store.listContacts().map((contact) => contact.id)).not.toContain('c-006');
                expect(wire.requests).toHaveLength(2);
            } finally {
                await wire.close();
            }
        });

        it('refuses when the user declines or cancels the prompt', async () => {
            for (const action of ['decline', 'cancel'] as const) {
                const wire = await connect({ elicitation: true, respond: () => ({ action }) });
                try {
                    const mutation = EVERY_OP[4]!; // delete_contact c-006

                    const tokenId = await wire.propose(mutation);
                    const refused = await wire.call('execute_write', { tokenId, mutation });

                    expect(refused.isError).toBe(true);
                    expect(textOf(refused)).toContain('ConfirmationDeclinedError');
                    expect(textOf(refused)).toContain(action === 'decline' ? 'declined' : 'cancelled');
                    expect(wire.store.listContacts().map((contact) => contact.id)).toContain('c-006');
                    expect(wire.requests).toHaveLength(1);
                } finally {
                    await wire.close();
                }
            }
        });

        it('refuses every destructive write when the client declares no elicitation capability', async () => {
            const wire = await connect({ elicitation: false });
            try {
                for (const mutation of EVERY_OP.filter((candidate) => candidate.op !== 'add_note' && candidate.op !== 'add_tag')) {
                    const tokenId = await wire.propose(mutation);
                    const refused = await wire.call('execute_write', { tokenId, mutation });

                    expect(refused.isError).toBe(true);
                    expect(textOf(refused)).toContain('ConfirmationUnavailableError');
                    expect(textOf(refused)).toContain('interactive confirmation channel');
                    expect(textOf(refused)).toContain('does not advertise one');
                    expect(textOf(refused)).toContain(mutation.op);
                }

                // Nothing degraded quietly into a write.
                expect(wire.store.getContact('c-003').tags).toContain('net-30');
                expect(wire.store.getContact('c-004').stage).not.toBe('Closed-Won');
                expect(wire.store.listContacts().map((contact) => contact.id)).toContain('c-006');
            } finally {
                await wire.close();
            }
        });

        it('leaves the reversible tier alone: no capability needed, nothing asked', async () => {
            const withoutChannel = await connect({ elicitation: false });
            try {
                const mutation = EVERY_OP[0]!; // add_note c-001

                const tokenId = await withoutChannel.propose(mutation);
                const result = await withoutChannel.call('execute_write', { tokenId, mutation });

                expect(result.isError).toBeFalsy();
                expect(contactOf(result).notes).toHaveLength(2);
                expect(withoutChannel.store.getContact('c-001').notes).toHaveLength(2);
            } finally {
                await withoutChannel.close();
            }

            // And a client that COULD be asked still is not, for a reversible op.
            const withChannel = await connect({ elicitation: true });
            try {
                const mutation = EVERY_OP[1]!; // add_tag vip on c-001

                const tokenId = await withChannel.propose(mutation);
                const result = await withChannel.call('execute_write', { tokenId, mutation });

                expect(result.isError).toBeFalsy();
                expect(withChannel.store.getContact('c-001').tags).toContain('vip');
                expect(withChannel.requests).toHaveLength(0);
            } finally {
                await withChannel.close();
            }
        });

        it('still enforces the store floor after the user confirms', async () => {
            const wire = await connect({ elicitation: true });
            try {
                const mutation: Mutation = { op: 'delete_contact', contactId: 'c-007' };

                const tokenId = await wire.propose(mutation);
                const refused = await wire.call('execute_write', { tokenId, mutation });

                // Confirmation is a gate, not an override: the frozen record
                // stays frozen no matter who says yes.
                expect(refused.isError).toBe(true);
                expect(textOf(refused)).toContain('NeverWriteStateError');
                expect(wire.requests).toHaveLength(1);
                expect(wire.store.listContacts().map((contact) => contact.id)).toContain('c-007');
            } finally {
                await wire.close();
            }
        });
    });
});
