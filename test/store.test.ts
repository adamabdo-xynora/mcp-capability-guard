import { beforeEach, describe, expect, it } from 'vitest';

import {
    ContactNotFoundError,
    ContactStoreError,
    InMemoryContactStore,
    NEVER_WRITE_STAGES,
    NeverWriteStateError,
    seedContacts
} from '../src/store.js';
import type { Contact, ContactStore, Stage } from '../src/store.js';

/** The seeded Closed-Lost-DNC contact — the frozen record every lock check aims at. */
const DNC_ID = 'c-007';
/** A seeded contact in a perfectly ordinary, writable stage. */
const WRITABLE_ID = 'c-003';
const MISSING_ID = 'c-does-not-exist';

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('store', () => {
    let store: ContactStore;

    beforeEach(() => {
        store = new InMemoryContactStore();
    });

    describe('seedContacts', () => {
        it('returns seven fictional Larkspur contacts', () => {
            expect(seedContacts()).toHaveLength(7);
        });

        it('gives every contact a unique id', () => {
            const ids = seedContacts().map((contact) => contact.id);
            expect(new Set(ids).size).toBe(ids.length);
        });

        it('covers the required stages, with exactly one never-write contact', () => {
            const stages = seedContacts().map((contact) => contact.stage);

            expect(stages).toContain('New');
            expect(stages).toContain('Qualified');
            expect(stages).toContain('Proposal');
            expect(stages.filter((stage) => stage === 'Closed-Lost-DNC')).toHaveLength(1);
        });

        it('keeps the fiction: every email is @example.com', () => {
            for (const contact of seedContacts()) {
                expect(contact.email.endsWith('@example.com')).toBe(true);
            }
        });

        it('gives every contact tags and at least one note', () => {
            for (const contact of seedContacts()) {
                expect(contact.tags.length).toBeGreaterThan(0);
                expect(contact.notes.length).toBeGreaterThan(0);
            }
        });

        it('hands back a fresh array each call, not a shared one', () => {
            const first = seedContacts();
            const second = seedContacts();

            expect(first).not.toBe(second);
            expect(first[0]).not.toBe(second[0]);
            expect(first).toEqual(second);
        });
    });

    describe('NEVER_WRITE_STAGES', () => {
        it('contains Closed-Lost-DNC', () => {
            expect(NEVER_WRITE_STAGES.has('Closed-Lost-DNC')).toBe(true);
        });

        it('does not freeze ordinary closed stages', () => {
            expect(NEVER_WRITE_STAGES.has('Closed-Lost')).toBe(false);
            expect(NEVER_WRITE_STAGES.has('Closed-Won')).toBe(false);
        });
    });

    describe('constructor', () => {
        it('defaults to the seed data', () => {
            expect(store.listContacts()).toEqual(seedContacts());
        });

        it('accepts an explicit contact list', () => {
            const only: Contact[] = [
                {
                    id: 'c-900',
                    name: 'Hollis Ambergate',
                    email: 'hollis.ambergate@example.com',
                    company: 'Larkspur Supply Co.',
                    stage: 'New',
                    tags: ['test-fixture'],
                    notes: []
                }
            ];
            const custom = new InMemoryContactStore(only);

            expect(custom.listContacts()).toEqual(only);
        });

        it('deep-copies the contacts it is constructed with', () => {
            const seed = seedContacts();
            const custom = new InMemoryContactStore(seed);

            seed[0]!.name = 'MUTATED BY CALLER';
            seed[0]!.tags.push('mutated');

            const stored = custom.getContact(seed[0]!.id);
            expect(stored.name).not.toBe('MUTATED BY CALLER');
            expect(stored.tags).not.toContain('mutated');
        });
    });

    describe('reads', () => {
        it('listContacts returns every contact', () => {
            const listed = store.listContacts();

            expect(listed).toHaveLength(7);
            expect(listed.map((contact) => contact.id)).toEqual([
                'c-001',
                'c-002',
                'c-003',
                'c-004',
                'c-005',
                'c-006',
                'c-007'
            ]);
        });

        it('getContact returns the requested contact', () => {
            const contact = store.getContact(WRITABLE_ID);

            expect(contact.id).toBe(WRITABLE_ID);
            expect(contact.name).toBe('Junia Halverstam');
            expect(contact.company).toBe('Bellhollow Markets');
            expect(contact.stage).toBe('Qualified');
        });

        it('getContact reads a never-write contact just fine — reads are not writes', () => {
            const frozen = store.getContact(DNC_ID);

            expect(frozen.stage).toBe('Closed-Lost-DNC');
            expect(frozen.tags).toContain('do-not-contact');
        });
    });

    describe('writes — happy paths', () => {
        it('addNote appends a note and returns the updated contact', () => {
            const updated = store.addNote(WRITABLE_ID, 'Sent the produce-adjacent SKU list.');

            expect(updated.notes).toHaveLength(3);
            expect(updated.notes.at(-1)!.text).toBe('Sent the produce-adjacent SKU list.');
            expect(store.getContact(WRITABLE_ID).notes).toHaveLength(3);
        });

        it('addTag adds a new tag', () => {
            const updated = store.addTag(WRITABLE_ID, 'fall-program');

            expect(updated.tags).toContain('fall-program');
            expect(store.getContact(WRITABLE_ID).tags).toContain('fall-program');
        });

        it('removeTag removes an existing tag', () => {
            const updated = store.removeTag(WRITABLE_ID, 'priority');

            expect(updated.tags).not.toContain('priority');
            expect(updated.tags).toEqual(['regional-chain', 'net-30']);
            expect(store.getContact(WRITABLE_ID).tags).not.toContain('priority');
        });

        it('changeStage moves a contact to a new stage', () => {
            const updated = store.changeStage(WRITABLE_ID, 'Proposal');

            expect(updated.stage).toBe('Proposal');
            expect(store.getContact(WRITABLE_ID).stage).toBe('Proposal');
        });

        it('changeStage may move a contact INTO a never-write stage', () => {
            const updated = store.changeStage(WRITABLE_ID, 'Closed-Lost-DNC');

            expect(updated.stage).toBe('Closed-Lost-DNC');
            // ...and the door locks behind it.
            expect(() => store.addNote(WRITABLE_ID, 'too late')).toThrow(NeverWriteStateError);
        });

        it('deleteContact removes the contact', () => {
            store.deleteContact(WRITABLE_ID);

            expect(store.listContacts()).toHaveLength(6);
            expect(() => store.getContact(WRITABLE_ID)).toThrow(ContactNotFoundError);
        });
    });

    // The defense-in-depth floor. The store knows nothing about the guard above
    // it, so each write method gets its own lock check: one door, one test.
    describe('never-write refusal — one lock check per write method', () => {
        it('addNote refuses a Closed-Lost-DNC contact', () => {
            expect(() => store.addNote(DNC_ID, 'circling back!')).toThrow(NeverWriteStateError);
        });

        it('addTag refuses a Closed-Lost-DNC contact', () => {
            expect(() => store.addTag(DNC_ID, 'reengagement')).toThrow(NeverWriteStateError);
        });

        it('removeTag refuses a Closed-Lost-DNC contact', () => {
            // Even removing the do-not-contact tag itself is a write, and refused.
            expect(() => store.removeTag(DNC_ID, 'do-not-contact')).toThrow(NeverWriteStateError);
        });

        it('changeStage refuses a Closed-Lost-DNC contact', () => {
            expect(() => store.changeStage(DNC_ID, 'Qualified')).toThrow(NeverWriteStateError);
        });

        it('deleteContact refuses a Closed-Lost-DNC contact', () => {
            expect(() => store.deleteContact(DNC_ID)).toThrow(NeverWriteStateError);
        });

        it('refuses a move OUT of a never-write stage — frozen means frozen', () => {
            const outbound: Stage[] = ['New', 'Contacted', 'Qualified', 'Proposal', 'Closed-Won', 'Closed-Lost'];

            for (const stage of outbound) {
                expect(() => store.changeStage(DNC_ID, stage)).toThrow(NeverWriteStateError);
            }
            expect(store.getContact(DNC_ID).stage).toBe('Closed-Lost-DNC');
        });

        it('refuses even a no-op write (re-adding a tag the contact already has)', () => {
            expect(() => store.addTag(DNC_ID, 'legal-hold')).toThrow(NeverWriteStateError);
        });

        it('refuses before mutating anything', () => {
            const before = store.getContact(DNC_ID);

            expect(() => store.addNote(DNC_ID, 'nope')).toThrow(NeverWriteStateError);
            expect(() => store.addTag(DNC_ID, 'nope')).toThrow(NeverWriteStateError);
            expect(() => store.removeTag(DNC_ID, 'legal-hold')).toThrow(NeverWriteStateError);
            expect(() => store.changeStage(DNC_ID, 'New')).toThrow(NeverWriteStateError);
            expect(() => store.deleteContact(DNC_ID)).toThrow(NeverWriteStateError);

            expect(store.getContact(DNC_ID)).toEqual(before);
            expect(store.listContacts()).toHaveLength(7);
        });

        it('names the id, the stage, and the NEVER_WRITE_STAGES rule in the error', () => {
            let caught: unknown;
            try {
                store.addNote(DNC_ID, 'circling back!');
            } catch (error: unknown) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(NeverWriteStateError);
            const error = caught as NeverWriteStateError;

            expect(error).toBeInstanceOf(ContactStoreError);
            expect(error).toBeInstanceOf(Error);
            expect(error.name).toBe('NeverWriteStateError');
            expect(error.id).toBe(DNC_ID);
            expect(error.stage).toBe('Closed-Lost-DNC');
            expect(error.message).toContain(DNC_ID);
            expect(error.message).toContain('Closed-Lost-DNC');
            expect(error.message).toContain('NEVER_WRITE_STAGES');
            expect(error.message).toContain('refuse all writes');
        });
    });

    describe('unknown id', () => {
        it('getContact throws ContactNotFoundError', () => {
            expect(() => store.getContact(MISSING_ID)).toThrow(ContactNotFoundError);
        });

        it('addNote throws ContactNotFoundError', () => {
            expect(() => store.addNote(MISSING_ID, 'hello')).toThrow(ContactNotFoundError);
        });

        it('addTag throws ContactNotFoundError', () => {
            expect(() => store.addTag(MISSING_ID, 'hello')).toThrow(ContactNotFoundError);
        });

        it('removeTag throws ContactNotFoundError', () => {
            expect(() => store.removeTag(MISSING_ID, 'hello')).toThrow(ContactNotFoundError);
        });

        it('changeStage throws ContactNotFoundError', () => {
            expect(() => store.changeStage(MISSING_ID, 'Qualified')).toThrow(ContactNotFoundError);
        });

        it('deleteContact throws ContactNotFoundError', () => {
            expect(() => store.deleteContact(MISSING_ID)).toThrow(ContactNotFoundError);
        });

        it('names the missing id in the error', () => {
            let caught: unknown;
            try {
                store.getContact(MISSING_ID);
            } catch (error: unknown) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(ContactNotFoundError);
            const error = caught as ContactNotFoundError;

            expect(error).toBeInstanceOf(ContactStoreError);
            expect(error.name).toBe('ContactNotFoundError');
            expect(error.id).toBe(MISSING_ID);
            expect(error.message).toContain(MISSING_ID);
        });

        it('reports a missing id as not-found rather than as a never-write refusal', () => {
            expect(() => store.deleteContact(MISSING_ID)).not.toThrow(NeverWriteStateError);
        });
    });

    describe('deep-copy isolation', () => {
        it('getContact hands back a copy — mutating it does not touch the store', () => {
            const contact = store.getContact(WRITABLE_ID);

            contact.name = 'MUTATED';
            contact.stage = 'Closed-Won';
            contact.tags.push('injected');
            contact.tags[0] = 'clobbered';
            contact.notes.push({ at: '1999-01-01T00:00:00.000Z', text: 'injected note' });
            contact.notes[0]!.text = 'clobbered note';

            const reread = store.getContact(WRITABLE_ID);
            expect(reread.name).toBe('Junia Halverstam');
            expect(reread.stage).toBe('Qualified');
            expect(reread.tags).toEqual(['regional-chain', 'priority', 'net-30']);
            expect(reread.notes).toHaveLength(2);
            expect(reread.notes[0]!.text).toBe('Confirmed budget for a full pallet program starting in the fall.');
        });

        it('two reads return independent objects', () => {
            const first = store.getContact(WRITABLE_ID);
            const second = store.getContact(WRITABLE_ID);

            expect(first).not.toBe(second);
            expect(first.tags).not.toBe(second.tags);
            expect(first.notes).not.toBe(second.notes);
            expect(first.notes[0]).not.toBe(second.notes[0]);
            expect(first).toEqual(second);
        });

        it('listContacts hands back copies too', () => {
            const listed = store.listContacts();
            listed[0]!.tags.push('injected');
            listed.pop();

            const reread = store.listContacts();
            expect(reread).toHaveLength(7);
            expect(reread[0]!.tags).not.toContain('injected');
        });

        it('write methods hand back copies too', () => {
            const returned = store.addTag(WRITABLE_ID, 'fall-program');
            returned.tags.push('injected');
            returned.notes.push({ at: '1999-01-01T00:00:00.000Z', text: 'injected note' });

            const reread = store.getContact(WRITABLE_ID);
            expect(reread.tags).not.toContain('injected');
            expect(reread.notes).toHaveLength(2);
        });
    });

    describe('notes are append-only', () => {
        it('appends in call order, leaving existing notes untouched', () => {
            const original = store.getContact(WRITABLE_ID).notes;

            store.addNote(WRITABLE_ID, 'first new note');
            store.addNote(WRITABLE_ID, 'second new note');
            const notes = store.addNote(WRITABLE_ID, 'third new note').notes;

            expect(notes).toHaveLength(original.length + 3);
            expect(notes.slice(0, original.length)).toEqual(original);
            expect(notes.slice(original.length).map((note) => note.text)).toEqual([
                'first new note',
                'second new note',
                'third new note'
            ]);
        });

        it('stamps each appended note with an ISO 8601 timestamp', () => {
            const before = Date.now();
            const notes = store.addNote(WRITABLE_ID, 'timestamped').notes;
            const after = Date.now();

            const appended = notes.at(-1)!;
            expect(appended.at).toMatch(ISO_8601);

            const at = Date.parse(appended.at);
            expect(Number.isNaN(at)).toBe(false);
            expect(at).toBeGreaterThanOrEqual(before - 1000);
            expect(at).toBeLessThanOrEqual(after + 1000);
        });

        it('keeps timestamps non-decreasing across appends', () => {
            store.addNote(WRITABLE_ID, 'one');
            store.addNote(WRITABLE_ID, 'two');
            const notes = store.addNote(WRITABLE_ID, 'three').notes;

            const stamps = notes.slice(-3).map((note) => Date.parse(note.at));
            expect(stamps[1]!).toBeGreaterThanOrEqual(stamps[0]!);
            expect(stamps[2]!).toBeGreaterThanOrEqual(stamps[1]!);
        });

        it('keeps duplicate note text as separate entries — notes are a log, not a set', () => {
            store.addNote(WRITABLE_ID, 'same text');
            const notes = store.addNote(WRITABLE_ID, 'same text').notes;

            expect(notes.filter((note) => note.text === 'same text')).toHaveLength(2);
        });

        it('exposes no removal API', () => {
            const surface = store as unknown as Record<string, unknown>;

            expect(surface['removeNote']).toBeUndefined();
            expect(surface['deleteNote']).toBeUndefined();
            expect(surface['editNote']).toBeUndefined();
            expect(surface['clearNotes']).toBeUndefined();
        });
    });

    describe('tag idempotency', () => {
        it('addTag on an existing tag is a no-op returning current state', () => {
            const before = store.getContact(WRITABLE_ID);
            const after = store.addTag(WRITABLE_ID, 'priority');

            expect(after).toEqual(before);
            expect(after.tags.filter((tag) => tag === 'priority')).toHaveLength(1);
            expect(store.getContact(WRITABLE_ID).tags).toEqual(before.tags);
        });

        it('addTag repeated many times still yields one tag', () => {
            store.addTag(WRITABLE_ID, 'fall-program');
            store.addTag(WRITABLE_ID, 'fall-program');
            const tags = store.addTag(WRITABLE_ID, 'fall-program').tags;

            expect(tags.filter((tag) => tag === 'fall-program')).toHaveLength(1);
        });

        it('removeTag on an absent tag is a no-op returning current state', () => {
            const before = store.getContact(WRITABLE_ID);
            const after = store.removeTag(WRITABLE_ID, 'never-applied');

            expect(after).toEqual(before);
            expect(store.getContact(WRITABLE_ID).tags).toEqual(before.tags);
        });

        it('removeTag repeated is a no-op after the first removal', () => {
            const first = store.removeTag(WRITABLE_ID, 'priority');
            const second = store.removeTag(WRITABLE_ID, 'priority');

            expect(second).toEqual(first);
            expect(second.tags).not.toContain('priority');
        });

        it('add then remove then add returns to a single tag', () => {
            store.addTag(WRITABLE_ID, 'fall-program');
            store.removeTag(WRITABLE_ID, 'fall-program');
            const tags = store.addTag(WRITABLE_ID, 'fall-program').tags;

            expect(tags.filter((tag) => tag === 'fall-program')).toHaveLength(1);
        });

        it('removeTag leaves the other tags in order', () => {
            const tags = store.removeTag(WRITABLE_ID, 'regional-chain').tags;

            expect(tags).toEqual(['priority', 'net-30']);
        });
    });
});
