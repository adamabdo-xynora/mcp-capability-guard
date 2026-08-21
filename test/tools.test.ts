import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
    CallToolResult,
    ElicitRequestFormParams,
    ElicitResult
} from '@modelcontextprotocol/sdk/types.js';

import { AuditLog, fingerprint } from '../src/audit.js';
import type { AuditEvent } from '../src/audit.js';
import { Guard } from '../src/guard.js';
import type { Mutation } from '../src/guard.js';
import { InMemoryContactStore } from '../src/store.js';
import type { Contact } from '../src/store.js';
import {
    buildServer,
    handleConfirmedExecuteWrite,
    handleExecuteWrite,
    handleGetContact,
    handleListContacts,
    handleProposeWrite,
    handleReadAudit
} from '../src/tools.js';
import type { ConfirmationChannel, ToolDeps } from '../src/tools.js';

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

function makeDeps(options: { generateId?: () => string } = {}) {
    const clock = fakeClock();
    const store = new InMemoryContactStore();
    const audit = new AuditLog({ now: clock.now });
    const guard = new Guard(
        { ttlMs: TTL },
        { now: clock.now, generateId: options.generateId ?? sequentialIds() }
    );
    return { deps: { store, guard, audit } satisfies ToolDeps, store, guard, audit, clock };
}

/** Every event of one kind, narrowed so a test can read its own fields. */
function eventsOfKind<K extends AuditEvent['kind']>(
    events: readonly AuditEvent[],
    kind: K
): Extract<AuditEvent, { kind: K }>[] {
    return events.filter((event): event is Extract<AuditEvent, { kind: K }> => event.kind === kind);
}

/** A confirmation channel that is there and always says yes. */
function acceptingChannel(): ConfirmationChannel {
    return {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        elicitInput: () => Promise.resolve({ action: 'accept', content: { confirm: true } })
    };
}

/** A confirmation channel that is there and always says no. */
function decliningChannel(): ConfirmationChannel {
    return {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        elicitInput: () => Promise.resolve({ action: 'decline' })
    };
}

/** A client that never advertised a way to be asked anything. */
function absentChannel(): ConfirmationChannel {
    return {
        getClientCapabilities: () => ({}),
        elicitInput: () => Promise.reject(new Error('this client cannot be asked'))
    };
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
            // The refusal names the token by fingerprint, never in full: the
            // guard writes the whole id into its message and this layer cuts it
            // down before the text goes anywhere. See the redaction tests below.
            expect(textOf(result)).toContain(fingerprint('tok-i-made-this-up'));
            expect(textOf(result)).not.toContain('tok-i-made-this-up');
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

    /**
     * The audit trail. Two rules are under test here, and only one of them is
     * about bookkeeping.
     *
     * The first is that the log is a faithful account: the events, in order,
     * say what was asked for, what a human answered, what was written, and what
     * was refused by name.
     *
     * The second is the redaction rule, and it is the reason the module exists.
     * A capability token is a bearer credential — whoever can read one can spend
     * it — so an audit trail that quotes tokens in full is a place live warrants
     * accumulate. The decoy tests below take that literally: they mint every
     * token in the run with one recognizable id, run the flows including the
     * refusals whose messages are *written by the guard with the id in them*,
     * and then search the entire log and every tool result for that string.
     */
    describe('audit trail', () => {
        const CONFIRMED_FLOW = EVERY_OP[3]!; // change_stage c-004 -> Closed-Won

        /** A client connected to a freshly built server, for tool-list checks. */
        async function connectTo(server: ReturnType<typeof buildServer>) {
            const client = new Client({ name: 'audit-surface-test-client', version: '0.0.0' }, { capabilities: {} });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

            return {
                async toolNames(): Promise<string[]> {
                    return (await client.listTools()).tools.map((tool) => tool.name);
                },
                async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
                    return (await client.callTool({ name, arguments: args })) as CallToolResult;
                },
                async close() {
                    await client.close();
                    await server.close();
                }
            };
        }

        it('records a read, a proposal, both halves of the confirmation, and the write', async () => {
            const { deps, audit } = makeDeps();

            handleListContacts(deps);
            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation: CONFIRMED_FLOW }));
            const result = await handleConfirmedExecuteWrite(deps, acceptingChannel(), {
                tokenId,
                mutation: CONFIRMED_FLOW
            });

            expect(result.isError).toBeFalsy();

            const events = audit.list();
            expect(events.map((event) => event.kind)).toEqual([
                'read',
                'propose',
                'confirm_requested',
                'confirm_outcome',
                'execute_success'
            ]);

            expect(eventsOfKind(events, 'read')[0]).toMatchObject({
                tool: 'list_contacts',
                summary: 'listed 7 contacts'
            });
            expect(eventsOfKind(events, 'propose')[0]).toMatchObject({
                op: 'change_stage',
                contactId: 'c-004',
                tier: 'destructive',
                tokenFingerprint: fingerprint(tokenId)
            });
            expect(eventsOfKind(events, 'confirm_requested')[0]).toMatchObject({
                op: 'change_stage',
                contactId: 'c-004'
            });
            expect(eventsOfKind(events, 'confirm_outcome')[0]).toMatchObject({ outcome: 'confirmed' });
            expect(eventsOfKind(events, 'execute_success')[0]).toMatchObject({
                op: 'change_stage',
                contactId: 'c-004',
                tokenFingerprint: fingerprint(tokenId)
            });

            // Every event is stamped from the injected clock, not the wall.
            const at = new Date(START).toISOString();
            expect(events.every((event) => event.at === at)).toBe(true);
        });

        it('asks nobody for a reversible write, and says so by omission', () => {
            const { deps, audit } = makeDeps();
            const mutation = EVERY_OP[0]!; // add_note

            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation }));
            expect(handleExecuteWrite(deps, { tokenId, mutation }).isError).toBeFalsy();

            expect(audit.list().map((event) => event.kind)).toEqual(['propose', 'execute_success']);
        });

        it('logs a refusal naming ReplayedTokenError when a spent token is presented again', () => {
            // A realistically long id, so the redaction below is doing real work:
            // a fingerprint of an id shorter than the prefix shows it whole, which
            // is a property of short ids rather than of the redaction.
            const { deps, audit } = makeDeps({ generateId: () => 'tok-replay-long-enough-to-redact' });
            const mutation = EVERY_OP[1]!; // add_tag, reversible: no confirmation in the way

            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation }));
            expect(handleExecuteWrite(deps, { tokenId, mutation }).isError).toBeFalsy();
            expect(handleExecuteWrite(deps, { tokenId, mutation }).isError).toBe(true);

            const events = audit.list();
            expect(events.map((event) => event.kind)).toEqual(['propose', 'execute_success', 'refusal']);

            const refusal = eventsOfKind(events, 'refusal')[0]!;
            expect(refusal.tool).toBe('execute_write');
            expect(refusal.rule).toBe('ReplayedTokenError');
            expect(refusal.message).toContain('single-use');
            expect(refusal.message).toContain(fingerprint(tokenId));
            expect(refusal.message).not.toContain(tokenId);
        });

        it('logs the store floor by name when a verified warrant is refused underneath it', () => {
            const { deps, audit } = makeDeps();
            const mutation: Mutation = { op: 'add_note', contactId: 'c-007', text: 'Following up anyway.' };

            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation }));
            expect(handleExecuteWrite(deps, { tokenId, mutation }).isError).toBe(true);

            const events = audit.list();
            // No execute_success: the write that never happened is not recorded
            // as one, and the refusal names the layer that refused.
            expect(events.map((event) => event.kind)).toEqual(['propose', 'refusal']);
            expect(eventsOfKind(events, 'refusal')[0]).toMatchObject({
                tool: 'execute_write',
                rule: 'NeverWriteStateError'
            });
        });

        it('records refused_no_channel as the outcome when there is nobody to ask', async () => {
            const { deps, audit } = makeDeps();
            const mutation = EVERY_OP[4]!; // delete_contact c-006

            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation }));
            const refused = await handleConfirmedExecuteWrite(deps, absentChannel(), { tokenId, mutation });

            expect(refused.isError).toBe(true);

            const events = audit.list();
            // No confirm_requested: nothing was asked, so nothing is recorded as
            // asked. The outcome names why.
            expect(events.map((event) => event.kind)).toEqual(['propose', 'confirm_outcome', 'refusal']);
            expect(eventsOfKind(events, 'confirm_outcome')[0]).toMatchObject({
                op: 'delete_contact',
                contactId: 'c-006',
                outcome: 'refused_no_channel'
            });
            expect(eventsOfKind(events, 'refusal')[0]).toMatchObject({ rule: 'ConfirmationUnavailableError' });
        });

        it('records a declined confirmation as declined, with no write after it', async () => {
            const { deps, audit } = makeDeps();
            const mutation = EVERY_OP[4]!; // delete_contact c-006

            const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation }));
            expect(
                (await handleConfirmedExecuteWrite(deps, decliningChannel(), { tokenId, mutation })).isError
            ).toBe(true);

            const events = audit.list();
            expect(events.map((event) => event.kind)).toEqual([
                'propose',
                'confirm_requested',
                'confirm_outcome',
                'refusal'
            ]);
            expect(eventsOfKind(events, 'confirm_outcome')[0]).toMatchObject({ outcome: 'declined' });
            expect(eventsOfKind(events, 'refusal')[0]).toMatchObject({ rule: 'ConfirmationDeclinedError' });
        });

        /**
         * The decoy. Every token in this run is minted with the same
         * unmistakable id, and the flows deliberately include the refusals whose
         * messages the guard writes *with that id embedded in the text* —
         * ReplayedTokenError, MutationMismatchError — plus the two this module
         * writes itself. If any of them reaches the log unredacted, the search
         * below finds it.
         */
        describe('the decoy token never reaches the record', () => {
            const DECOY = 'tok-decoy-9f3c2b-full-value-never-logged';

            /** Run every interesting path, keeping the results apart by kind. */
            async function runFlows() {
                const harness = makeDeps({ generateId: () => DECOY });
                const { deps } = harness;
                const proposals: CallToolResult[] = [];
                const others: CallToolResult[] = [];

                others.push(handleListContacts(deps));

                // Reversible: propose, execute, then replay the spent warrant.
                const note = EVERY_OP[0]!;
                proposals.push(handleProposeWrite(deps, { mutation: note }));
                const noteToken = proposalOf(proposals[0]!).tokenId;
                others.push(handleExecuteWrite(deps, { tokenId: noteToken, mutation: note }));
                others.push(handleExecuteWrite(deps, { tokenId: noteToken, mutation: note }));

                // Mismatch: a fresh warrant presented with a substituted payload.
                const tag = EVERY_OP[1]!;
                proposals.push(handleProposeWrite(deps, { mutation: tag }));
                others.push(
                    handleExecuteWrite(deps, {
                        tokenId: proposalOf(proposals[1]!).tokenId,
                        mutation: { op: 'add_tag', contactId: 'c-001', tag: 'do-not-contact' }
                    })
                );

                // Destructive: refused for want of a channel, then declined,
                // then confirmed — all on one warrant, since neither refusal
                // spends it.
                const remove = EVERY_OP[4]!;
                proposals.push(handleProposeWrite(deps, { mutation: remove }));
                const removeToken = proposalOf(proposals[2]!).tokenId;
                others.push(
                    await handleConfirmedExecuteWrite(deps, absentChannel(), {
                        tokenId: removeToken,
                        mutation: remove
                    })
                );
                others.push(
                    await handleConfirmedExecuteWrite(deps, decliningChannel(), {
                        tokenId: removeToken,
                        mutation: remove
                    })
                );
                others.push(
                    await handleConfirmedExecuteWrite(deps, acceptingChannel(), {
                        tokenId: removeToken,
                        mutation: remove
                    })
                );

                // And the log read back through its own tool.
                others.push(handleReadAudit(deps));

                return { ...harness, proposals, others };
            }

            it('keeps the whole id out of every audit event, fingerprint and all', async () => {
                const { audit, others } = await runFlows();

                const events = audit.list();
                const serialized = JSON.stringify(events);

                expect(serialized).not.toContain(DECOY);
                expect(serialized).toContain(fingerprint(DECOY));

                // The run really did exercise the paths that quote the token.
                expect(others.some((result) => result.isError === true)).toBe(true);
                expect(eventsOfKind(events, 'refusal').map((event) => event.rule)).toEqual([
                    'ReplayedTokenError',
                    'MutationMismatchError',
                    'ConfirmationUnavailableError',
                    'ConfirmationDeclinedError'
                ]);
                expect(eventsOfKind(events, 'execute_success').map((event) => event.tokenFingerprint)).toEqual([
                    fingerprint(DECOY),
                    fingerprint(DECOY)
                ]);
            });

            it('keeps the whole id out of every tool result except the proposal that mints it', async () => {
                const { proposals, others } = await runFlows();

                for (const result of others) {
                    expect(textOf(result)).not.toContain(DECOY);
                }

                // Refusals still identify the token — by fingerprint, which is
                // enough to correlate and not enough to spend.
                const refusals = others.filter((result) => result.isError === true);
                expect(refusals).toHaveLength(4);
                for (const refused of refusals) {
                    expect(textOf(refused)).toContain(fingerprint(DECOY));
                }

                // The one legitimate exception: propose_write hands the caller
                // the id it will have to present. Nowhere else in the payload.
                expect(proposals).toHaveLength(3);
                for (const proposal of proposals) {
                    const parsed = payloadOf(proposal) as Record<string, unknown>;
                    expect(parsed['tokenId']).toBe(DECOY);

                    const { tokenId: _minted, ...withoutTheToken } = parsed;
                    expect(JSON.stringify(withoutTheToken)).not.toContain(DECOY);
                }
            });
        });

        describe('read_audit is denied by default', () => {
            it('is not registered at all unless it is asked for', async () => {
                const { deps, audit } = makeDeps();
                const wire = await connectTo(buildServer(deps));
                try {
                    const names = await wire.toolNames();

                    expect(names).toEqual(['list_contacts', 'get_contact', 'propose_write', 'execute_write']);
                    expect(names).not.toContain('read_audit');

                    // Absent, not present-and-refusing: the refusal comes from
                    // the protocol layer, which has no such tool to dispatch to.
                    // No handler of ours ran, and nothing was logged.
                    const attempted = await wire.call('read_audit', {});
                    expect(attempted.isError).toBe(true);
                    expect(textOf(attempted)).toContain('Tool read_audit not found');
                    expect(audit.list()).toEqual([]);
                } finally {
                    await wire.close();
                }
            });

            it('is registered and returns the trail when exposeAudit is true', async () => {
                const { deps, audit } = makeDeps();
                const mutation = EVERY_OP[0]!;

                handleListContacts(deps);
                const { tokenId } = proposalOf(handleProposeWrite(deps, { mutation }));
                expect(handleExecuteWrite(deps, { tokenId, mutation }).isError).toBeFalsy();

                const wire = await connectTo(buildServer(deps, { exposeAudit: true }));
                try {
                    expect(await wire.toolNames()).toContain('read_audit');

                    const payload = payloadOf(await wire.call('read_audit', {})) as {
                        count: number;
                        events: AuditEvent[];
                    };

                    expect(payload.count).toBe(3);
                    expect(payload.events.map((event) => event.kind)).toEqual([
                        'read',
                        'propose',
                        'execute_success'
                    ]);
                    expect(JSON.stringify(payload)).toContain(fingerprint(tokenId));

                    // Reading the log is itself an event, appended after the
                    // snapshot the caller was handed.
                    expect(audit.list()).toHaveLength(4);
                    expect(audit.list().at(-1)).toMatchObject({ kind: 'read', tool: 'read_audit' });
                } finally {
                    await wire.close();
                }
            });
        });
    });
});
