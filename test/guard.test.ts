import { describe, expect, it } from 'vitest';

import {
    ExpiredTokenError,
    Guard,
    GuardConfigError,
    InvalidMutationError,
    MutationMismatchError,
    ReplayedTokenError,
    UnknownTokenError,
    WRITE_TIERS
} from '../src/guard.js';
import type { CapabilityToken, GuardConfig, Mutation } from '../src/guard.js';

const TTL = 60_000;
const START = 1_700_000_000_000;

/** A clock the test drives by hand, so expiry is exact rather than approximate. */
function fakeClock(start = START) {
    let current = start;
    return {
        now: () => current,
        advance(ms: number) {
            current += ms;
        },
        set(at: number) {
            current = at;
        }
    };
}

/** Sequential ids, so a test can name a token before it exists. */
function sequentialIds(prefix = 'tok') {
    let n = 0;
    return () => `${prefix}-${++n}`;
}

function makeGuard(overrides: { ttlMs?: number; now?: () => number; generateId?: () => string } = {}) {
    const clock = fakeClock();
    const guard = new Guard(
        { ttlMs: overrides.ttlMs ?? TTL },
        { now: overrides.now ?? clock.now, generateId: overrides.generateId ?? sequentialIds() }
    );
    return { guard, clock };
}

/** One mutation of every op, used to prove the guard treats all five alike. */
const EVERY_MUTATION: Mutation[] = [
    { op: 'add_note', contactId: 'c-003', text: 'Sent the produce-adjacent SKU list.' },
    { op: 'add_tag', contactId: 'c-003', tag: 'vip' },
    { op: 'remove_tag', contactId: 'c-003', tag: 'net-30' },
    { op: 'change_stage', contactId: 'c-003', newStage: 'Proposal' },
    { op: 'delete_contact', contactId: 'c-006' }
];

describe('guard', () => {
    describe('tier taxonomy', () => {
        it('rates note and tag additions reversible, and the rest destructive', () => {
            expect(WRITE_TIERS).toEqual({
                add_note: 'reversible',
                add_tag: 'reversible',
                remove_tag: 'destructive',
                change_stage: 'destructive',
                delete_contact: 'destructive'
            });
        });
    });

    describe('proposeWrite → executeWrite (happy path)', () => {
        for (const mutation of EVERY_MUTATION) {
            it(`mints and executes a token for ${mutation.op}`, () => {
                const { guard } = makeGuard();

                const token = guard.proposeWrite(mutation);

                expect(token.id).toBeTruthy();
                expect(token.mutation).toEqual(mutation);
                expect(token.issuedAt).toBe(START);
                expect(token.expiresAt).toBe(START + TTL);

                expect(guard.executeWrite(token.id, mutation)).toEqual(mutation);
            });
        }

        it('returns the bound mutation, not the presented object', () => {
            const { guard } = makeGuard();
            const mutation: Mutation = { op: 'add_tag', contactId: 'c-003', tag: 'vip' };

            const token = guard.proposeWrite(mutation);
            const presented: Mutation = { op: 'add_tag', contactId: 'c-003', tag: 'vip' };
            const executed = guard.executeWrite(token.id, presented);

            expect(executed).toEqual(mutation);
            expect(executed).not.toBe(presented);
            expect(executed).not.toBe(token.mutation);
        });

        it('mints a unique id for every token', () => {
            const guard = new Guard({ ttlMs: TTL });
            const ids = new Set<string>();

            for (let i = 0; i < 100; i++) {
                ids.add(guard.proposeWrite({ op: 'add_tag', contactId: 'c-003', tag: `t-${i}` }).id);
            }

            expect(ids.size).toBe(100);
        });
    });

    describe('unknown tokens', () => {
        it('refuses an id this guard never minted', () => {
            const { guard } = makeGuard();

            expect(() => guard.executeWrite('tok-never-minted', EVERY_MUTATION[0]!)).toThrow(UnknownTokenError);
            expect(() => guard.executeWrite('tok-never-minted', EVERY_MUTATION[0]!)).toThrow(/tok-never-minted/);
        });

        it('refuses another guard’s token', () => {
            const { guard: minter } = makeGuard();
            const { guard: verifier } = makeGuard();
            const mutation = EVERY_MUTATION[1]!;

            const token = minter.proposeWrite(mutation);

            expect(() => verifier.executeWrite(token.id, mutation)).toThrow(UnknownTokenError);
        });
    });

    describe('single use', () => {
        it('refuses a replayed token', () => {
            const { guard } = makeGuard();
            const mutation = EVERY_MUTATION[0]!;

            const token = guard.proposeWrite(mutation);
            expect(guard.executeWrite(token.id, mutation)).toEqual(mutation);

            expect(() => guard.executeWrite(token.id, mutation)).toThrow(ReplayedTokenError);
            expect(() => guard.executeWrite(token.id, mutation)).toThrow(/single-use/);
        });
    });

    describe('expiry', () => {
        it('refuses a token presented after its ttl has passed', () => {
            const { guard, clock } = makeGuard();
            const mutation = EVERY_MUTATION[3]!;

            const token = guard.proposeWrite(mutation);
            clock.advance(TTL + 1);

            expect(() => guard.executeWrite(token.id, mutation)).toThrow(ExpiredTokenError);
        });

        it('names the expiry instant and the current time', () => {
            const { guard, clock } = makeGuard();
            const mutation = EVERY_MUTATION[3]!;

            const token = guard.proposeWrite(mutation);
            clock.set(START + TTL + 5);

            try {
                guard.executeWrite(token.id, mutation);
                expect.unreachable('expected ExpiredTokenError');
            } catch (error) {
                expect(error).toBeInstanceOf(ExpiredTokenError);
                const expired = error as ExpiredTokenError;
                expect(expired.expiresAt).toBe(START + TTL);
                expect(expired.now).toBe(START + TTL + 5);
            }
        });

        it('accepts a token presented at expiresAt - 1', () => {
            const { guard, clock } = makeGuard();
            const mutation = EVERY_MUTATION[2]!;

            const token = guard.proposeWrite(mutation);
            clock.set(token.expiresAt - 1);

            expect(guard.executeWrite(token.id, mutation)).toEqual(mutation);
        });

        it('refuses a token presented at exactly expiresAt', () => {
            const { guard, clock } = makeGuard();
            const mutation = EVERY_MUTATION[2]!;

            const token = guard.proposeWrite(mutation);
            clock.set(token.expiresAt);

            expect(() => guard.executeWrite(token.id, mutation)).toThrow(ExpiredTokenError);
        });
    });

    describe('mutation binding', () => {
        /** Run `attempt` and return the MutationMismatchError it must throw. */
        function expectMismatch(attempt: () => unknown): MutationMismatchError {
            let caught: unknown;
            try {
                attempt();
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(MutationMismatchError);
            return caught as MutationMismatchError;
        }

        it('refuses a different contact, naming contactId as the diverging field', () => {
            const { guard } = makeGuard();

            const token = guard.proposeWrite({ op: 'add_tag', contactId: 'c-003', tag: 'vip' });
            const error = expectMismatch(() =>
                guard.executeWrite(token.id, { op: 'add_tag', contactId: 'c-004', tag: 'vip' })
            );

            expect(error.field).toBe('contactId');
            expect(error.message).toMatch(/contactId/);
            expect(error.message).toMatch(/c-003/);
            expect(error.message).toMatch(/c-004/);
        });

        it('refuses a different op, naming op as the diverging field', () => {
            const { guard } = makeGuard();

            const token = guard.proposeWrite({ op: 'add_tag', contactId: 'c-003', tag: 'vip' });
            const error = expectMismatch(() =>
                guard.executeWrite(token.id, { op: 'remove_tag', contactId: 'c-003', tag: 'vip' })
            );

            expect(error.field).toBe('op');
            expect(error.message).toMatch(/\bop\b/);
            expect(error.message).toMatch(/add_tag/);
            expect(error.message).toMatch(/remove_tag/);
        });

        it('refuses a different payload, naming payload as the diverging field', () => {
            const { guard } = makeGuard();

            const token = guard.proposeWrite({ op: 'add_tag', contactId: 'c-003', tag: 'vip' });
            const error = expectMismatch(() =>
                guard.executeWrite(token.id, { op: 'add_tag', contactId: 'c-003', tag: 'priority' })
            );

            expect(error.field).toBe('payload');
            expect(error.message).toMatch(/payload/);
            expect(error.message).toMatch(/"tag"/);
            expect(error.message).toMatch(/vip/);
            expect(error.message).toMatch(/priority/);
        });

        it('states that the token is bound to one exact mutation', () => {
            const { guard } = makeGuard();

            const token = guard.proposeWrite({ op: 'add_note', contactId: 'c-003', text: 'one' });
            const error = expectMismatch(() =>
                guard.executeWrite(token.id, { op: 'add_note', contactId: 'c-003', text: 'two' })
            );

            expect(error.message).toMatch(/bound to one exact mutation/);
        });

        it('burns the token: the correct mutation fails afterwards too', () => {
            const { guard } = makeGuard();
            const bound: Mutation = { op: 'change_stage', contactId: 'c-003', newStage: 'Proposal' };

            const token = guard.proposeWrite(bound);

            expect(() =>
                guard.executeWrite(token.id, { op: 'change_stage', contactId: 'c-003', newStage: 'Closed-Won' })
            ).toThrow(MutationMismatchError);

            expect(() => guard.executeWrite(token.id, bound)).toThrow(ReplayedTokenError);
        });
    });

    describe('token copies', () => {
        it('hands out a deep copy: editing it does not move the binding', () => {
            const { guard } = makeGuard();
            const bound: Mutation = { op: 'add_tag', contactId: 'c-003', tag: 'vip' };

            const token = guard.proposeWrite(bound);
            const tampered = token as CapabilityToken & { mutation: { contactId: string; tag: string } };
            tampered.mutation.contactId = 'c-007';
            tampered.mutation.tag = 'priority';
            tampered.expiresAt = Number.MAX_SAFE_INTEGER;

            // The tampered mutation is refused; the original binding still executes.
            expect(() =>
                guard.executeWrite(token.id, { op: 'add_tag', contactId: 'c-007', tag: 'priority' })
            ).toThrow(MutationMismatchError);

            const fresh = guard.proposeWrite(bound);
            expect(guard.executeWrite(fresh.id, bound)).toEqual(bound);
        });

        it('hands out a fresh copy on every mint', () => {
            const { guard } = makeGuard();
            const bound: Mutation = { op: 'add_note', contactId: 'c-003', text: 'note' };

            const first = guard.proposeWrite(bound);
            const second = guard.proposeWrite(bound);

            expect(first.mutation).not.toBe(second.mutation);
            expect(first.mutation).not.toBe(bound);
        });
    });

    describe('mutation validation', () => {
        it('rejects an unknown op at propose time', () => {
            const { guard } = makeGuard();
            const bogus = { op: 'drop_database', contactId: 'c-003' } as unknown as Mutation;

            expect(() => guard.proposeWrite(bogus)).toThrow(InvalidMutationError);
            expect(() => guard.proposeWrite(bogus)).toThrow(/drop_database/);
        });

        it('rejects a mutation with no op at all', () => {
            const { guard } = makeGuard();

            expect(() => guard.proposeWrite({ contactId: 'c-003' } as unknown as Mutation)).toThrow(
                InvalidMutationError
            );
        });

        it('rejects a mutation missing its payload field', () => {
            const { guard } = makeGuard();

            expect(() => guard.proposeWrite({ op: 'add_tag', contactId: 'c-003' } as unknown as Mutation)).toThrow(
                InvalidMutationError
            );
        });

        it('rejects a change_stage to a stage that does not exist', () => {
            const { guard } = makeGuard();

            expect(() =>
                guard.proposeWrite({ op: 'change_stage', contactId: 'c-003', newStage: 'Ascended' } as unknown as Mutation)
            ).toThrow(InvalidMutationError);
        });
    });

    describe('fail-closed config', () => {
        const malformed: Array<[string, unknown]> = [
            ['missing config', undefined],
            ['null config', null],
            ['non-object config (number)', 42],
            ['non-object config (string)', 'ttl please'],
            ['missing ttlMs', {}],
            ['non-number ttlMs', { ttlMs: '60000' }],
            ['NaN ttlMs', { ttlMs: Number.NaN }],
            ['zero ttlMs', { ttlMs: 0 }],
            ['negative ttlMs', { ttlMs: -1 }],
            ['non-finite ttlMs', { ttlMs: Number.POSITIVE_INFINITY }],
            ['negative non-finite ttlMs', { ttlMs: Number.NEGATIVE_INFINITY }]
        ];

        for (const [label, config] of malformed) {
            it(`throws GuardConfigError at construction: ${label}`, () => {
                expect(() => new Guard(config as GuardConfig)).toThrow(GuardConfigError);
                expect(() => new Guard(config as GuardConfig)).toThrow(/fail-closed/);
            });
        }

        it('accepts a valid config and mints', () => {
            const guard = new Guard({ ttlMs: 1 });

            expect(guard.proposeWrite({ op: 'delete_contact', contactId: 'c-006' }).id).toBeTruthy();
        });
    });
});
