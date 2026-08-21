import { describe, expect, it } from 'vitest';

import { AuditLog, FINGERPRINT_ELLIPSIS, FINGERPRINT_PREFIX_LENGTH, fingerprint, redactTokenId } from '../src/audit.js';
import type { AuditEvent } from '../src/audit.js';

const START = 1_700_000_000_000;

/** A clock the test drives by hand, so timestamps are exact rather than approximate. */
function fakeClock(start = START) {
    let current = start;
    return {
        now: () => current,
        advance(ms: number) {
            current += ms;
        }
    };
}

const TOKEN = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('audit', () => {
    describe('fingerprint', () => {
        it('keeps the first eight characters and marks the cut', () => {
            expect(fingerprint(TOKEN)).toBe(`a1b2c3d4${FINGERPRINT_ELLIPSIS}`);
            expect(FINGERPRINT_PREFIX_LENGTH).toBe(8);
        });

        it('never returns an id longer than the prefix unchanged', () => {
            const longer = [
                TOKEN,
                'tok-decoy-9f3c2b-full-value-never-logged',
                '123456789',
                'x'.repeat(200),
                'tok-1234-5678'
            ];

            for (const id of longer) {
                expect(id.length).toBeGreaterThan(FINGERPRINT_PREFIX_LENGTH);

                const short = fingerprint(id);
                expect(short).not.toBe(id);
                expect(short).toHaveLength(FINGERPRINT_PREFIX_LENGTH + FINGERPRINT_ELLIPSIS.length);
                expect(short.startsWith(id.slice(0, FINGERPRINT_PREFIX_LENGTH))).toBe(true);
                expect(short.endsWith(FINGERPRINT_ELLIPSIS)).toBe(true);
                // The point of the whole exercise: what is left is not spendable.
                expect(short).not.toContain(id);
            }
        });

        it('is deterministic, so two events about one token can be correlated', () => {
            expect(fingerprint(TOKEN)).toBe(fingerprint(TOKEN));
            expect(fingerprint(TOKEN)).not.toBe(fingerprint('b1b2c3d4-e5f6-7890-abcd-ef1234567890'));
        });
    });

    describe('redactTokenId', () => {
        it('replaces every occurrence of a full id in free text', () => {
            const text = `Token "${TOKEN}" was already used, and token "${TOKEN}" stays used.`;

            const redacted = redactTokenId(text, TOKEN);

            expect(redacted).not.toContain(TOKEN);
            expect(redacted).toBe(
                `Token "${fingerprint(TOKEN)}" was already used, and token "${fingerprint(TOKEN)}" stays used.`
            );
        });

        it('leaves text alone when the id is no longer than the prefix', () => {
            // Nothing to hide: the fingerprint of a short id shows it whole, so
            // substituting one would garble the message for no gain.
            const text = 'Token "tok-1" was already used.';

            expect(redactTokenId(text, 'tok-1')).toBe(text);
        });
    });

    describe('append and list', () => {
        it('round-trips every kind of event, in the order it was appended', () => {
            const log = new AuditLog({ now: fakeClock().now });

            log.append({ kind: 'read', tool: 'list_contacts', summary: 'listed 7 contacts' });
            log.append({
                kind: 'propose',
                op: 'delete_contact',
                contactId: 'c-006',
                tier: 'destructive',
                tokenFingerprint: fingerprint(TOKEN)
            });
            log.append({ kind: 'confirm_requested', op: 'delete_contact', contactId: 'c-006' });
            log.append({
                kind: 'confirm_outcome',
                op: 'delete_contact',
                contactId: 'c-006',
                outcome: 'confirmed'
            });
            log.append({
                kind: 'execute_success',
                op: 'delete_contact',
                contactId: 'c-006',
                tokenFingerprint: fingerprint(TOKEN)
            });
            log.append({
                kind: 'refusal',
                tool: 'execute_write',
                rule: 'ReplayedTokenError',
                message: 'Rule: tokens are single-use.'
            });

            const events = log.list();

            expect(events.map((event) => event.kind)).toEqual([
                'read',
                'propose',
                'confirm_requested',
                'confirm_outcome',
                'execute_success',
                'refusal'
            ]);
            expect(events[0]).toEqual({
                kind: 'read',
                at: new Date(START).toISOString(),
                tool: 'list_contacts',
                summary: 'listed 7 contacts'
            });
            expect(events[1]).toMatchObject({
                op: 'delete_contact',
                contactId: 'c-006',
                tier: 'destructive',
                tokenFingerprint: 'a1b2c3d4…'
            });
            expect(events[5]).toMatchObject({ rule: 'ReplayedTokenError', tool: 'execute_write' });
        });

        it('stamps every event from the injected clock', () => {
            const clock = fakeClock();
            const log = new AuditLog({ now: clock.now });

            log.append({ kind: 'read', tool: 'get_contact', summary: 'read contact c-001' });
            clock.advance(1_000);
            log.append({ kind: 'read', tool: 'get_contact', summary: 'read contact c-002' });
            clock.advance(60_000);
            log.append({ kind: 'read', tool: 'get_contact', summary: 'read contact c-003' });

            expect(log.list().map((event) => event.at)).toEqual([
                new Date(START).toISOString(),
                new Date(START + 1_000).toISOString(),
                new Date(START + 61_000).toISOString()
            ]);
            expect(log.list().map((event) => event.at)).toEqual([
                '2023-11-14T22:13:20.000Z',
                '2023-11-14T22:13:21.000Z',
                '2023-11-14T22:14:21.000Z'
            ]);
        });

        it('defaults to the wall clock when no clock is injected', () => {
            const before = Date.now();
            const log = new AuditLog();

            log.append({ kind: 'read', tool: 'list_contacts', summary: 'listed 7 contacts' });

            const at = Date.parse(log.list()[0]!.at);
            expect(at).toBeGreaterThanOrEqual(before);
            expect(at).toBeLessThanOrEqual(Date.now());
        });

        it('starts empty', () => {
            expect(new AuditLog().list()).toEqual([]);
        });
    });

    describe('the log is append-only', () => {
        it('hands out deep copies, so a caller cannot edit the record it was shown', () => {
            const log = new AuditLog({ now: fakeClock().now });
            log.append({
                kind: 'refusal',
                tool: 'execute_write',
                rule: 'ReplayedTokenError',
                message: 'Rule: tokens are single-use.'
            });

            const events = log.list();
            const stolen = events[0]!;

            // Tamper with every field of the event we were handed.
            (stolen as { kind: string }).kind = 'read';
            (stolen as { at: string }).at = '1999-01-01T00:00:00.000Z';
            (stolen as { rule: string }).rule = 'NothingHappenedError';
            (stolen as { message: string }).message = 'all clear';

            expect(log.list()[0]).toEqual({
                kind: 'refusal',
                at: new Date(START).toISOString(),
                tool: 'execute_write',
                rule: 'ReplayedTokenError',
                message: 'Rule: tokens are single-use.'
            });
        });

        it('hands out a fresh array and fresh objects on every call', () => {
            const log = new AuditLog({ now: fakeClock().now });
            log.append({ kind: 'read', tool: 'list_contacts', summary: 'listed 7 contacts' });

            const first = log.list();
            const second = log.list();

            expect(first).not.toBe(second);
            expect(first[0]).not.toBe(second[0]);
            expect(first[0]).toEqual(second[0]);

            // Emptying or extending the returned array changes nothing.
            const mutable = first as AuditEvent[];
            mutable.push({
                kind: 'read',
                at: '1999-01-01T00:00:00.000Z',
                tool: 'forged',
                summary: 'never happened'
            });
            mutable.splice(0, mutable.length);

            expect(log.list()).toHaveLength(1);
            expect(log.list()[0]).toMatchObject({ tool: 'list_contacts' });
        });

        it('offers no way to remove or rewrite an event', () => {
            const log = new AuditLog({ now: fakeClock().now });
            log.append({ kind: 'read', tool: 'list_contacts', summary: 'listed 7 contacts' });

            // Append-only is structural, not conventional: the class has exactly
            // two methods, and neither of them takes anything away.
            expect(Object.getOwnPropertyNames(AuditLog.prototype).sort()).toEqual([
                'append',
                'constructor',
                'list'
            ]);

            const reachable = log as unknown as Record<string, unknown>;
            for (const forbidden of ['clear', 'delete', 'remove', 'truncate', 'reset', 'pop', 'splice', 'events']) {
                expect(reachable[forbidden]).toBeUndefined();
            }

            expect(log.list()).toHaveLength(1);
        });
    });
});
