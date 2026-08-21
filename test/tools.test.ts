import { describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
});
