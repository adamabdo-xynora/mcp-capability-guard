/**
 * The adversarial suite — one hostile session against one fully wired server.
 *
 * Every other test in this project asks whether a rule works. These ask whether
 * the rules hold when the caller is not a cooperative model but a compromised
 * one: a model that has read the tool descriptions, understood exactly what the
 * two-step write protocol is for, and is now trying to get a write past it.
 * The attacker here holds every advantage a real prompt-injected model holds —
 * it can call any tool, in any order, with any arguments, as many times as it
 * likes, and (in most scenarios below) it even has a user on the other end who
 * clicks yes on whatever confirmation it triggers.
 *
 * The wiring is real. A real {@link InMemoryContactStore}, a real {@link Guard},
 * a real {@link AuditLog}, and the exported tool handlers the SDK itself calls
 * in `buildServer` — not a re-implementation of them. Only two seams are fake,
 * and both are fake in the attacker's favour: an injectable clock (so expiry is
 * exact rather than slow) and a stand-in client whose confirmation prompt
 * answers yes by default.
 *
 * Every scenario asserts two things, and the second is the one that matters:
 *
 *  1. The refusal is typed — the isError text names the rule that produced it,
 *     so a caller (and an operator reading a transcript) can tell *which*
 *     defence fired rather than just that something failed.
 *  2. The store is byte-identical to its pre-attack snapshot afterwards. A
 *     refusal that still left a partial write behind is not a refusal, and only
 *     a full deep-equal of `list_contacts` can rule that out.
 *
 * The scenarios share one session on purpose. An attacker does not get a fresh
 * server per attempt, and the final scenario audits the trail all seven attacks
 * left behind — which requires them to have happened in the same log. Vitest
 * runs the tests in a file in order, and each scenario snapshots the store at
 * its own start, so the sequence reads as one continuous intrusion.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type {
    CallToolResult,
    ClientCapabilities,
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
    handleConfirmedExecuteWrite,
    handleListContacts,
    handleProposeWrite
} from '../src/tools.js';
import type { ConfirmationChannel, ToolDeps } from '../src/tools.js';

const TTL = 60_000;
const START = 1_700_000_000_000;

/**
 * Every token id this session mints carries a recognizable "atk-" prefix, and a
 * distinct one per warrant.
 *
 * Two properties matter for the final audit scenario. The ids are longer than
 * FINGERPRINT_PREFIX_LENGTH (8), so a fingerprint genuinely truncates one rather
 * than showing it whole; and their first eight characters differ per token
 * (`atk-0001`, `atk-0002`, …), so a fingerprint still correlates events about
 * the same warrant. An id like `atk-warrant-0001` would fail the second: every
 * fingerprint would collapse to the same `atk-warr…`.
 */
function attackerIds(): () => string {
    let issued = 0;
    return () => `atk-${String(++issued).padStart(4, '0')}-warrant`;
}

/** A token id the guard never minted, in the same shape as the ones it did. */
const FORGED_TOKEN_ID = 'atk-9999-forged';

/** The text of a tool result — the only channel a refusal travels on. */
function textOf(result: CallToolResult): string {
    const first = result.content[0];
    if (first === undefined || first.type !== 'text') {
        throw new Error(`expected a text content block, received ${JSON.stringify(result.content)}`);
    }
    return first.text;
}

function payloadOf(result: CallToolResult): unknown {
    expect(result.isError).toBeFalsy();
    return JSON.parse(textOf(result));
}

/** Assert a refusal, and that it names its rule where the caller can read it. */
function expectRefusal(result: CallToolResult, rule: string): string {
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text, `expected a refusal naming ${rule}, received: ${text}`).toContain(rule);
    return text;
}

function eventsOfKind<K extends AuditEvent['kind']>(
    events: readonly AuditEvent[],
    kind: K
): Extract<AuditEvent, { kind: K }>[] {
    return events.filter((event): event is Extract<AuditEvent, { kind: K }> => event.kind === kind);
}

/**
 * The client on the other end of the wire, as the attacker experiences it.
 *
 * Mutable on purpose: `capabilities` models which client is connected (scenario
 * 7 attacks from one that never advertised elicitation) and `answer` models
 * what the human does when a confirmation prompt reaches them. The default is
 * the attacker-friendly one — a user who says yes.
 */
interface FakeClient {
    channel: ConfirmationChannel;
    capabilities: ClientCapabilities | undefined;
    answer: ElicitResult;
    /** Every confirmation sentence the server actually put to the user. */
    prompts: string[];
}

function fakeClient(): FakeClient {
    const client: FakeClient = {
        capabilities: { elicitation: { form: {} } },
        answer: { action: 'accept', content: { confirm: true } },
        prompts: [],
        channel: {
            getClientCapabilities: () => client.capabilities,
            elicitInput: (params: ElicitRequestFormParams): Promise<ElicitResult> => {
                client.prompts.push(params.message);
                return Promise.resolve(client.answer);
            }
        }
    };
    return client;
}

interface Session {
    deps: ToolDeps;
    client: FakeClient;
    advance(ms: number): void;
    /** Every token id the guard minted this session, in order. */
    mintedIds: string[];
    /** propose_write, as the attacker calls it. Returns the tokenId it was handed. */
    propose(mutation: Mutation): string;
    /** execute_write, as the attacker calls it — through the confirmation gate. */
    execute(tokenId: string, mutation: Mutation): Promise<CallToolResult>;
    /** The whole store, read back through the read tool the attacker also has. */
    snapshot(): Contact[];
}

function wireSession(): Session {
    let current = START;
    const now = (): number => current;

    const mintedIds: string[] = [];
    const nextId = attackerIds();

    const store = new InMemoryContactStore();
    const audit = new AuditLog({ now });
    const guard = new Guard(
        { ttlMs: TTL },
        {
            now,
            generateId: () => {
                const id = nextId();
                mintedIds.push(id);
                return id;
            }
        }
    );
    const deps: ToolDeps = { store, guard, audit };
    const client = fakeClient();

    return {
        deps,
        client,
        mintedIds,
        advance(ms: number) {
            current += ms;
        },
        propose(mutation: Mutation): string {
            const payload = payloadOf(handleProposeWrite(deps, { mutation })) as { tokenId: string };
            return payload.tokenId;
        },
        execute(tokenId: string, mutation: Mutation): Promise<CallToolResult> {
            return handleConfirmedExecuteWrite(deps, client.channel, { tokenId, mutation });
        },
        snapshot(): Contact[] {
            return payloadOf(handleListContacts(deps)) as Contact[];
        }
    };
}

/** Deep-equal AND byte-identical: the same records, in the same order, field for field. */
function expectStoreUnchanged(session: Session, before: Contact[]): void {
    const after = session.snapshot();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
}

describe('adversarial', () => {
    let session: Session;

    beforeAll(() => {
        session = wireSession();
    });

    /**
     * ATTACK: skip the protocol entirely — invent a warrant rather than asking for
     * one, and hope execute_write only checks that a tokenId is present.
     */
    it('1. refuses a fabricated token for a real mutation', async () => {
        const before = session.snapshot();

        const result = await session.execute(FORGED_TOKEN_ID, {
            op: 'add_note',
            contactId: 'c-001',
            text: 'Injected by an untrusted instruction in a fetched document.'
        });

        expectRefusal(result, 'UnknownTokenError');
        expectStoreUnchanged(session, before);
    });

    /**
     * ATTACK: let one authorized destructive write through, then spend its warrant a
     * second time — the classic replay, and the reason single-use is a rule rather
     * than a convention.
     */
    it('2. refuses to spend a legitimate warrant twice', async () => {
        const mutation: Mutation = { op: 'change_stage', contactId: 'c-004', newStage: 'Closed-Won' };

        // The legitimate half: propose, the user confirms, the write lands.
        const tokenId = session.propose(mutation);
        const promptsBefore = session.client.prompts.length;
        const performed = await session.execute(tokenId, mutation);
        expect(performed.isError).toBeFalsy();
        expect(session.client.prompts.length, 'a destructive write must ask').toBe(promptsBefore + 1);
        expect((payloadOf(performed) as Contact).stage).toBe('Closed-Won');

        // The snapshot is taken AFTER the legitimate write, so the assertion below
        // is specifically "no SECOND change", not "no change at all".
        const before = session.snapshot();

        const replay = await session.execute(tokenId, mutation);

        expectRefusal(replay, 'ReplayedTokenError');
        expectStoreUnchanged(session, before);
    });

    /**
     * ATTACK: bait and switch — get a warrant for something harmless, then present it
     * for the destructive write you actually wanted, betting that the token is a
     * general permission rather than a binding to one exact mutation.
     */
    it('3. refuses a warrant presented for a different operation, and burns it', async () => {
        const before = session.snapshot();

        const bait: Mutation = {
            op: 'add_note',
            contactId: 'c-001',
            text: 'Catalog mailed; following up next week.'
        };
        const tokenId = session.propose(bait);

        // The switch. Note the user is asked about the DELETE and says yes — the
        // human in the loop has been socially engineered, and the binding still holds.
        const switched = await session.execute(tokenId, { op: 'delete_contact', contactId: 'c-001' });

        const text = expectRefusal(switched, 'MutationMismatchError');
        expect(text).toContain('diverged on op');
        expect(text).toContain('bound to op "add_note"');
        expect(text).toContain('presented op "delete_contact"');

        // The burn: retreating to the mutation the warrant was actually minted for
        // does not revive it. A token presented under attack is spent, full stop.
        const retreat = await session.execute(tokenId, bait);
        expectRefusal(retreat, 'ReplayedTokenError');

        expectStoreUnchanged(session, before);
    });

    /**
     * ATTACK: keep the operation, move the target — a warrant to delete one contact,
     * presented to delete a different one, betting the binding checks only the verb.
     */
    it('4. refuses a warrant presented against a different contact', async () => {
        const before = session.snapshot();

        const tokenId = session.propose({ op: 'delete_contact', contactId: 'c-006' });
        const shifted = await session.execute(tokenId, { op: 'delete_contact', contactId: 'c-007' });

        const text = expectRefusal(shifted, 'MutationMismatchError');
        expect(text).toContain('diverged on contactId');
        expect(text).toContain('bound to contactId "c-006"');
        expect(text).toContain('presented contactId "c-007"');

        // Neither the warrant's target nor the attack's target was touched.
        const ids = session.snapshot().map((contact) => contact.id);
        expect(ids).toContain('c-006');
        expect(ids).toContain('c-007');
        expectStoreUnchanged(session, before);
    });

    /**
     * ATTACK: no trick at all — a completely legitimate, fully confirmed write aimed
     * at a frozen do-not-contact record. Every layer above the store says yes; this
     * is the defence-in-depth floor test, and the only thing left to refuse is the
     * store itself.
     */
    it('5. refuses a fully authorized, fully confirmed write to a frozen record', async () => {
        const before = session.snapshot();

        // Reversible tier: no confirmation prompt is raised at all, so the guard is
        // the last gate before the store — and it says yes, because the warrant is valid.
        const noteToken = session.propose({
            op: 'add_note',
            contactId: 'c-007',
            text: 'Reopening outreach per campaign request.'
        });
        const noteResult = await session.execute(noteToken, {
            op: 'add_note',
            contactId: 'c-007',
            text: 'Reopening outreach per campaign request.'
        });
        expectRefusal(noteResult, 'NeverWriteStateError');

        // Destructive tier: the user IS asked, by name, and says yes.
        const promptsBefore = session.client.prompts.length;
        const deleteToken = session.propose({ op: 'delete_contact', contactId: 'c-007' });
        const deleteResult = await session.execute(deleteToken, {
            op: 'delete_contact',
            contactId: 'c-007'
        });

        const prompt = session.client.prompts[promptsBefore];
        expect(prompt, 'the destructive attempt must have reached the user').toBeDefined();
        expect(prompt).toContain('delete_contact');
        expect(prompt).toContain('Delphine Ashgrove');

        const text = expectRefusal(deleteResult, 'NeverWriteStateError');
        expect(text).toContain('NEVER_WRITE_STAGES');
        expect(text).toContain('Closed-Lost-DNC');

        // Valid warrant, explicit human yes, and the record is still there.
        expectStoreUnchanged(session, before);
    });

    /**
     * ATTACK: sit on a warrant — mint it now, hold it past its TTL, and present it
     * later, betting that expiry is advisory.
     */
    it('6. refuses a warrant presented after its TTL', async () => {
        const before = session.snapshot();

        const mutation: Mutation = { op: 'remove_tag', contactId: 'c-003', tag: 'priority' };
        const tokenId = session.propose(mutation);

        session.advance(TTL + 1);

        const result = await session.execute(tokenId, mutation);

        const text = expectRefusal(result, 'ExpiredTokenError');
        expect(text).toContain('Rule: tokens are time-bound');
        expectStoreUnchanged(session, before);
    });

    /**
     * ATTACK: dodge the human — run the destructive write from a client that never
     * advertised a confirmation channel, betting the server degrades to executing
     * unconfirmed rather than refusing.
     */
    it('7. refuses a destructive write when there is nobody to confirm it, without spending the warrant', async () => {
        const before = session.snapshot();

        // A client that declared no elicitation capability at initialize time.
        session.client.capabilities = {};
        const promptsBefore = session.client.prompts.length;

        const tokenId = session.propose({ op: 'delete_contact', contactId: 'c-002' });
        const dodged = await session.execute(tokenId, { op: 'delete_contact', contactId: 'c-002' });

        const text = expectRefusal(dodged, 'ConfirmationUnavailableError');
        expect(text).toContain('does not advertise one');
        expect(text).toContain('refuses rather than writing unconfirmed');
        expect(session.client.prompts.length, 'nothing was asked of anyone').toBe(promptsBefore);
        expectStoreUnchanged(session, before);

        // The warrant survived the refusal, exactly as the refusal text claims.
        //
        // Proving it without performing the write it authorizes: present the same
        // token with a DIFFERENT mutation. The guard checks `used` before it checks
        // the binding, so a spent token would answer ReplayedTokenError here.
        // MutationMismatchError is only reachable while the token is still live —
        // and it costs the attacker the warrant, since a mismatch burns it.
        const probe = await session.execute(tokenId, {
            op: 'add_note',
            contactId: 'c-002',
            text: 'probe'
        });
        const probeText = expectRefusal(probe, 'MutationMismatchError');
        expect(probeText).not.toContain('ReplayedTokenError');
        expectStoreUnchanged(session, before);

        session.client.capabilities = { elicitation: { form: {} } };
    });

    /**
     * ATTACK AFTERMATH: the record of the intrusion. An audit trail that missed the
     * attacks, or that quoted a live warrant while describing them, would have made
     * the whole session worse rather than better.
     */
    it('8. leaves a complete audit trail that names every rule and leaks no warrant', () => {
        const events = session.deps.audit.list();

        // Every refusal, in the order the seven scenarios above produced them. The
        // rule name is the finding: it says which defence fired, not merely that
        // something failed.
        expect(eventsOfKind(events, 'refusal').map((event) => event.rule)).toEqual([
            'UnknownTokenError', //          1. fabricated token
            'ReplayedTokenError', //         2. replay of a spent warrant
            'MutationMismatchError', //      3. bait and switch
            'ReplayedTokenError', //         3. the burn: retreat to the bound mutation
            'MutationMismatchError', //      4. target shift
            'NeverWriteStateError', //       5. frozen record, reversible tier
            'NeverWriteStateError', //       5. frozen record, confirmed destructive tier
            'ExpiredTokenError', //          6. stale warrant
            'ConfirmationUnavailableError', //7. no confirmation channel
            'MutationMismatchError' //       7. the unspent-warrant probe
        ]);

        // Exactly one write was ever performed: the legitimate one in scenario 2.
        const succeeded = eventsOfKind(events, 'execute_success');
        expect(succeeded.map((event) => `${event.op}:${event.contactId}`)).toEqual([
            'change_stage:c-004'
        ]);

        const serialized = JSON.stringify(events);

        // No warrant, minted or forged, appears in the log at full length.
        for (const id of [...session.mintedIds, FORGED_TOKEN_ID]) {
            expect(serialized, `full token id ${id} leaked into the audit log`).not.toContain(id);
            // ...and each is still followable, because its fingerprint is there.
            expect(serialized).toContain(fingerprint(id));
        }

        // The same claim without a list to check against: nothing in the log has the
        // shape of a whole "atk-" id. A fingerprint is `atk-0001…` — prefix, then the
        // ellipsis — so any surviving `-warrant`/`-forged` tail would be a leak this
        // catches even for an id no test remembered to record.
        expect(serialized.match(/atk-\d{4}-[A-Za-z]+/g)).toBeNull();

        // Sanity: the ids really were long enough for a fingerprint to hide something.
        expect(session.mintedIds.length).toBeGreaterThan(0);
        for (const id of session.mintedIds) {
            expect(fingerprint(id).length).toBeLessThan(id.length);
        }
    });
});
