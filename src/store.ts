/**
 * The fictional in-memory CRM store — the deepest layer of this project.
 *
 * This module is deliberately dumb about authorization. It knows nothing about
 * tokens, capability guards, or MCP; it never asks who is calling or why. It
 * enforces exactly one safety rule of its own — {@link NEVER_WRITE_STAGES} —
 * because defense in depth means the bottom layer has to refuse independently
 * of every layer above it. If the guard above is misconfigured, bypassed, or
 * simply absent, a Closed-Lost-DNC contact is still frozen here.
 *
 * All data is invented. "Larkspur Supply Co." is a fictional wholesale
 * distributor, every contact is made up, every email is @example.com, and every
 * phone number lives in the 555 range.
 */

export type Stage =
    | 'New'
    | 'Contacted'
    | 'Qualified'
    | 'Proposal'
    | 'Closed-Won'
    | 'Closed-Lost'
    | 'Closed-Lost-DNC';

export interface Note {
    at: string;
    text: string;
}

export interface Contact {
    id: string;
    name: string;
    email: string;
    company: string;
    stage: Stage;
    tags: string[];
    notes: Note[];
}

/**
 * Stages whose contacts accept NO mutations of any kind.
 *
 * DNC means do-not-contact: the record is frozen. Not "frozen except for
 * notes", not "frozen unless you are moving it somewhere better" — every write
 * method checks this set first and throws before touching anything, including
 * deleteContact and including changeStage attempting to move a contact *out*
 * of a never-write stage. Frozen means frozen.
 */
export const NEVER_WRITE_STAGES: ReadonlySet<Stage> = new Set<Stage>(['Closed-Lost-DNC']);

/** Base class for every error this store raises, so callers can catch the family. */
export class ContactStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/** Thrown by every method when no contact with the given id exists. */
export class ContactNotFoundError extends ContactStoreError {
    readonly id: string;

    constructor(id: string) {
        super(`Contact "${id}" was not found: no contact with that id exists in the store.`);
        this.id = id;
    }
}

/**
 * Thrown by every write method when the target contact sits in a never-write
 * stage. The message names the rule so the refusal is self-explaining wherever
 * it surfaces — a log line, an MCP tool result, a test failure.
 */
export class NeverWriteStateError extends ContactStoreError {
    readonly id: string;
    readonly stage: Stage;

    constructor(id: string, stage: Stage) {
        super(
            `Write refused for contact "${id}": contacts in stage "${stage}" refuse all writes. ` +
                `Rule: NEVER_WRITE_STAGES (do-not-contact records are frozen — no notes, no tags, ` +
                `no stage changes in or out, no deletion).`
        );
        this.id = id;
        this.stage = stage;
    }
}

/**
 * The seam. A future adapter for a real CRM implements this same interface, so
 * everything above the store — the guard, the MCP tools, the demo — is written
 * against the contract rather than against the in-memory implementation.
 *
 * Every method throws {@link ContactNotFoundError} for an unknown id. Every
 * write method throws {@link NeverWriteStateError} for a contact in a
 * never-write stage, checked before any other validation or effect.
 */
export interface ContactStore {
    listContacts(): Contact[];
    getContact(id: string): Contact;
    addNote(id: string, text: string): Contact;
    addTag(id: string, tag: string): Contact;
    removeTag(id: string, tag: string): Contact;
    changeStage(id: string, stage: Stage): Contact;
    deleteContact(id: string): void;
}

function cloneContact(contact: Contact): Contact {
    return {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        company: contact.company,
        stage: contact.stage,
        tags: [...contact.tags],
        notes: contact.notes.map((note) => ({ at: note.at, text: note.text }))
    };
}

export class InMemoryContactStore implements ContactStore {
    /** Internal records. Never handed out directly — see {@link cloneContact}. */
    readonly #contacts: Map<string, Contact>;

    constructor(contacts: Contact[] = seedContacts()) {
        // Deep-copy on the way in too: the caller's array (and the seed array)
        // must not be a live handle into the store.
        this.#contacts = new Map(contacts.map((contact) => [contact.id, cloneContact(contact)]));
    }

    listContacts(): Contact[] {
        return [...this.#contacts.values()].map(cloneContact);
    }

    getContact(id: string): Contact {
        return cloneContact(this.#require(id));
    }

    addNote(id: string, text: string): Contact {
        const contact = this.#requireWritable(id);
        contact.notes.push({ at: new Date().toISOString(), text });
        return cloneContact(contact);
    }

    addTag(id: string, tag: string): Contact {
        const contact = this.#requireWritable(id);
        if (!contact.tags.includes(tag)) {
            contact.tags.push(tag);
        }
        return cloneContact(contact);
    }

    removeTag(id: string, tag: string): Contact {
        const contact = this.#requireWritable(id);
        const index = contact.tags.indexOf(tag);
        if (index !== -1) {
            contact.tags.splice(index, 1);
        }
        return cloneContact(contact);
    }

    changeStage(id: string, stage: Stage): Contact {
        // #requireWritable is checked against the contact's CURRENT stage, which
        // is what makes a never-write contact unmovable rather than merely
        // un-enterable. Moving out of Closed-Lost-DNC is a write like any other.
        const contact = this.#requireWritable(id);
        contact.stage = stage;
        return cloneContact(contact);
    }

    deleteContact(id: string): void {
        this.#requireWritable(id);
        this.#contacts.delete(id);
    }

    /** Resolve an id to the live record, or throw. */
    #require(id: string): Contact {
        const contact = this.#contacts.get(id);
        if (contact === undefined) {
            throw new ContactNotFoundError(id);
        }
        return contact;
    }

    /**
     * The floor of defense in depth: resolve an id, then refuse if the record is
     * frozen. Every write method calls this FIRST, before validating arguments
     * or mutating anything.
     */
    #requireWritable(id: string): Contact {
        const contact = this.#require(id);
        if (NEVER_WRITE_STAGES.has(contact.stage)) {
            throw new NeverWriteStateError(id, contact.stage);
        }
        return contact;
    }
}

/**
 * Seven fictional Larkspur Supply Co. contacts, spread across stages: one in
 * Closed-Lost-DNC (the frozen record every guard test aims at), and at least one
 * each in New, Qualified, and Proposal.
 */
export function seedContacts(): Contact[] {
    return [
        {
            id: 'c-001',
            name: 'Marisol Devane',
            email: 'marisol.devane@example.com',
            company: 'Thistlewood Grocers',
            stage: 'New',
            tags: ['inbound', 'northeast'],
            notes: [{ at: '2026-07-02T14:05:00.000Z', text: 'Requested the wholesale dry-goods catalog through the website form.' }]
        },
        {
            id: 'c-002',
            name: 'Peter Oyelaran',
            email: 'peter.oyelaran@example.com',
            company: 'Copperkettle Cafes',
            stage: 'Contacted',
            tags: ['cafe-chain', 'reorder-risk'],
            notes: [
                { at: '2026-07-05T09:30:00.000Z', text: 'Left voicemail at 555-0142 about the quarterly paper-goods contract.' },
                { at: '2026-07-08T16:12:00.000Z', text: 'Returned the call; asked for pricing on twelve locations.' }
            ]
        },
        {
            id: 'c-003',
            name: 'Junia Halverstam',
            email: 'junia.halverstam@example.com',
            company: 'Bellhollow Markets',
            stage: 'Qualified',
            tags: ['regional-chain', 'priority', 'net-30'],
            notes: [
                { at: '2026-06-19T11:45:00.000Z', text: 'Confirmed budget for a full pallet program starting in the fall.' },
                { at: '2026-07-11T13:20:00.000Z', text: 'Wants a produce-adjacent SKU list before committing.' }
            ]
        },
        {
            id: 'c-004',
            name: 'Idris Vantol',
            email: 'idris.vantol@example.com',
            company: 'Pinecrest Diner Group',
            stage: 'Proposal',
            tags: ['restaurant', 'proposal-sent'],
            notes: [
                { at: '2026-07-14T10:00:00.000Z', text: 'Sent the 18-month supply proposal with tiered volume pricing.' },
                { at: '2026-07-21T15:40:00.000Z', text: 'Asked whether delivery windows can shift to pre-dawn on Tuesdays.' }
            ]
        },
        {
            id: 'c-005',
            name: 'Rowena Sackfield',
            email: 'rowena.sackfield@example.com',
            company: 'Quillbrook Hotels',
            stage: 'Closed-Won',
            tags: ['hospitality', 'annual-contract', 'reference-account'],
            notes: [{ at: '2026-05-30T17:15:00.000Z', text: 'Signed the annual linen-and-paper contract; first delivery scheduled.' }]
        },
        {
            id: 'c-006',
            name: 'Tobias Merrigold',
            email: 'tobias.merrigold@example.com',
            company: 'Fernwick Catering',
            stage: 'Closed-Lost',
            tags: ['catering', 'price-sensitive'],
            notes: [
                { at: '2026-04-08T12:00:00.000Z', text: 'Chose a lower-cost regional supplier for this season.' },
                { at: '2026-06-02T09:05:00.000Z', text: 'Open to a revisit next spring; keep on the newsletter list.' }
            ]
        },
        {
            id: 'c-007',
            name: 'Delphine Ashgrove',
            email: 'delphine.ashgrove@example.com',
            company: 'Harrowgate Provisions',
            stage: 'Closed-Lost-DNC',
            tags: ['do-not-contact', 'legal-hold'],
            notes: [
                { at: '2026-03-17T08:25:00.000Z', text: 'Asked in writing to be removed from all outreach; call 555-0178 retired.' },
                { at: '2026-03-18T10:10:00.000Z', text: 'Record frozen under NEVER_WRITE_STAGES; no further edits permitted.' }
            ]
        }
    ];
}
