/**
 * The demo — one narrated session that shows what this server does and, more to
 * the point, what it refuses to do.
 *
 * Everything below the narration is real. A real {@link InMemoryContactStore},
 * a real {@link Guard}, a real {@link AuditLog}, and the actual MCP server that
 * {@link buildServer} returns, speaking the protocol over an in-memory
 * transport pair to a real SDK {@link Client}. No handler is called directly
 * and no rule is re-implemented here: every result printed below travelled the
 * wire as a JSON-RPC tool call and came back as a tool result.
 *
 * The client is the fake, and it is fake in exactly two ways, because a demo
 * needs to play both halves of the conversation a real deployment has:
 *
 *  - **The model side.** The scripted sequence of tool calls is what a model
 *    would decide to do. Here it is written down in advance, including the
 *    three things a compromised model would try — replaying a spent warrant,
 *    swapping the mutation out from under one, and pushing a write at a record
 *    that is frozen.
 *  - **The human side.** MCP form elicitation is how this server asks a person
 *    to confirm a destructive write. The client answers those prompts from a
 *    variable, so the demo can show a yes and a no without a person at the
 *    keyboard. Every prompt the server actually sent is printed verbatim, which
 *    is the point: the sentence the human is asked to agree to has to name the
 *    operation, the contact and the payload, or it confirms nothing.
 *
 * Determinism: the guard's clock and id generator and the audit log's clock are
 * injected, so token ids, expiry instants and event timestamps are the same on
 * every run. The one exception is called out where it appears — the store
 * stamps a new note with its own wall clock, which is not an injectable seam.
 *
 * The demo is also a smoke test. Every step asserts what it just claimed, so a
 * refusal that stops refusing fails the run: `npm run demo` exits 0 only if all
 * of it held.
 *
 * No network, no environment variables, no files written. It runs offline.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

import { AuditLog, FINGERPRINT_ELLIPSIS, FINGERPRINT_PREFIX_LENGTH } from '../src/audit.js';
import type { AuditEvent } from '../src/audit.js';
import { Guard } from '../src/guard.js';
import { InMemoryContactStore } from '../src/store.js';
import type { Contact } from '../src/store.js';
import { buildServer } from '../src/tools.js';

/* -------------------------------------------------------------------------- */
/* Deterministic seams                                                        */
/* -------------------------------------------------------------------------- */

/** A fixed instant, so every printed timestamp is the same on every run. */
const START = Date.UTC(2026, 7, 20, 15, 0, 0);

/** Long enough that nothing in this demo expires; short enough to be a real TTL. */
const TTL_MS = 60_000;

let clock = START;
const now = (): number => clock;

/** Advance the injected clock, so the audit trail reads as a sequence. */
function tick(ms = 1000): void {
    clock += ms;
}

/**
 * Every warrant this session mints, in order.
 *
 * The ids are longer than FINGERPRINT_PREFIX_LENGTH and differ inside their
 * first eight characters, so the audit trail's fingerprints genuinely truncate
 * them and still tell one warrant from another. Step 8 checks both properties.
 */
const mintedIds: string[] = [];

function nextTokenId(): string {
    const id = `tok-${String(mintedIds.length + 1).padStart(4, '0')}-demo`;
    mintedIds.push(id);
    return id;
}

/* -------------------------------------------------------------------------- */
/* Narration                                                                  */
/* -------------------------------------------------------------------------- */

const WIDTH = 78;

function out(line = ''): void {
    process.stdout.write(`${line}\n`);
}

/**
 * A JSON payload on one line, with the pretty-printer's line breaks turned
 * into single spaces.
 *
 * The values are exactly what crossed the wire — only the layout whitespace
 * differs, and only so that the wrapper below has somewhere to break. Every
 * space this introduces sits between JSON tokens, never inside a string.
 */
function compact(value: unknown): string {
    return JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ');
}

function splitEvery(word: string, width: number): string[] {
    const pieces: string[] = [];
    for (let index = 0; index < word.length; index += width) {
        pieces.push(word.slice(index, index + width));
    }
    return pieces;
}

function wrapTo(text: string, width: number): string[] {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
        // A compact JSON payload is one unbreakable "word". Break it at the
        // margin rather than letting the transcript run off the terminal.
        for (const piece of word.length > width ? splitEvery(word, width) : [word]) {
            if (current.length === 0) {
                current = piece;
            } else if (current.length + 1 + piece.length <= width) {
                current = `${current} ${piece}`;
            } else {
                lines.push(current);
                current = piece;
            }
        }
    }
    if (current.length > 0) {
        lines.push(current);
    }
    return lines.length > 0 ? lines : [''];
}

/** A wrapped paragraph of explanation, flush left. */
function say(text: string): void {
    for (const line of wrapTo(text, WIDTH)) {
        out(line);
    }
}

/**
 * One line of transcript, tagged with what kind of line it is.
 *
 * Markers are the same width so the column of tags reads as a column: `[call]`
 * is the model speaking, `[ask]` and `[human]` are the confirmation
 * round-trip, `[ok]` and `[deny]` are what came back, `[check]` is the demo
 * asserting that what came back is what it just told you would.
 */
function marked(marker: string, text: string): void {
    const head = `  ${marker.padEnd(7)} `;
    const cont = ' '.repeat(head.length);
    wrapTo(text, WIDTH - head.length).forEach((line, index) => {
        out(`${index === 0 ? head : cont}${line}`);
    });
}

function heading(step: string, title: string): void {
    out();
    out('='.repeat(WIDTH));
    out(`${step}  ${title}`);
    out('='.repeat(WIDTH));
}

/** Thrown when the demo's own expectation fails. It is a test as well as a demo. */
class DemoAssertionError extends Error {
    constructor(claim: string) {
        super(`expectation failed: ${claim}`);
        this.name = 'DemoAssertionError';
    }
}

function check(condition: boolean, claim: string): void {
    if (!condition) {
        throw new DemoAssertionError(claim);
    }
    marked('[check]', claim);
}

/* -------------------------------------------------------------------------- */
/* The fake client: the model side and the human side                         */
/* -------------------------------------------------------------------------- */

/** What the person at the other end of the elicitation prompt does. */
interface Human {
    /** The answer the next confirmation prompt receives. */
    answer: boolean;
    /** Every confirmation sentence the server actually put to them. */
    prompts: string[];
}

interface Session {
    client: Client;
    human: Human;
}

/** A tool call, printed as the model makes it. */
async function call(
    session: Session,
    name: string,
    args: Record<string, unknown>
): Promise<CallToolResult> {
    marked('[call]', `${name} ${compact(args)}`);
    const result = await session.client.callTool({ name, arguments: args });
    return result as CallToolResult;
}

function textOf(result: CallToolResult): string {
    const first = result.content[0];
    if (first === undefined || first.type !== 'text') {
        throw new DemoAssertionError(`tool result carried no text block: ${JSON.stringify(result)}`);
    }
    return first.text;
}

/** The parsed payload of a successful call. Fails the demo if it was a refusal. */
function payloadOf(result: CallToolResult): unknown {
    if (result.isError === true) {
        throw new DemoAssertionError(`expected success, received refusal: ${textOf(result)}`);
    }
    return JSON.parse(textOf(result));
}

/** The refusal text of a failed call, printed. Fails the demo if it succeeded. */
function refusalOf(result: CallToolResult, expectedRule: string): string {
    if (result.isError !== true) {
        throw new DemoAssertionError(`expected ${expectedRule}, received success: ${textOf(result)}`);
    }
    const text = textOf(result);
    if (!text.startsWith(`${expectedRule}:`)) {
        throw new DemoAssertionError(`expected ${expectedRule}, received: ${text}`);
    }
    marked('[deny]', text);
    return text;
}

interface ProposeReply {
    tokenId: string;
    expiresAt: number;
    tier: string;
}

/** propose_write, printed, with the thin reply the model is handed back. */
async function propose(session: Session, mutation: Record<string, unknown>): Promise<ProposeReply> {
    const result = await call(session, 'propose_write', { mutation });
    const reply = payloadOf(result) as ProposeReply;
    marked('[ok]', compact(reply));
    return reply;
}

function executeArgs(tokenId: string, mutation: Record<string, unknown>): Record<string, unknown> {
    return { tokenId, mutation };
}

/** A contact as a reader wants to see it, not as JSON wants to print it. */
function showContact(contact: Contact): void {
    marked('[ok]', `${contact.id}  ${contact.name}  (${contact.company})`);
    marked('', `stage ${contact.stage}  tags [${contact.tags.join(', ')}]`);
    for (const note of contact.notes) {
        marked('', `note ${note.at}  ${JSON.stringify(note.text)}`);
    }
}

function contactOf(result: CallToolResult): Contact {
    return payloadOf(result) as Contact;
}

/* -------------------------------------------------------------------------- */
/* The steps                                                                  */
/* -------------------------------------------------------------------------- */

async function stepRead(session: Session): Promise<void> {
    tick();
    heading('STEP 1', 'READ - the book, and nothing signed for it');
    say(
        'Reads need no capability token, because reading changes nothing. ' +
            'list_contacts takes no arguments and returns the whole fictional ' +
            'Larkspur Supply Co. book.'
    );
    out();

    const contacts = payloadOf(await call(session, 'list_contacts', {})) as Contact[];
    out();
    for (const contact of contacts) {
        out(`    ${contact.id}  ${contact.name.padEnd(20)} ${contact.stage}`);
    }
    out();
    say(
        'One of those stages is not like the others. Closed-Lost-DNC is the ' +
            'store\'s own frozen state: c-007 accepts no write of any kind, from ' +
            'anyone, holding anything. Step 7 tries it.'
    );
    out();

    check(contacts.length === 7, 'list_contacts returned all 7 contacts');
    check(
        contacts.some((contact) => contact.id === 'c-007' && contact.stage === 'Closed-Lost-DNC'),
        'c-007 is in the frozen Closed-Lost-DNC stage'
    );
}

async function stepReversible(session: Session): Promise<void> {
    tick();
    heading('STEP 2', 'WRITE - reversible, and it takes two calls');
    say(
        'There is no add_note tool. There is no delete_contact tool. Every write ' +
            'is two deliberate steps: propose_write mints a warrant bound to one ' +
            'exact mutation, execute_write presents it back. Nothing is written by ' +
            'proposing.'
    );
    out();

    const mutation = {
        op: 'add_note',
        contactId: 'c-001',
        text: 'Sent the fall dry-goods price list; follow up Thursday.'
    };
    const reply = await propose(session, mutation);
    out();
    say(
        'That reply is the whole of what crosses back. The token object itself - ' +
            'the bound mutation, the issue time - stays inside the guard; a warrant ' +
            'whose contents never enter a transcript cannot be lifted out of one. ' +
            'The tier is the guard\'s judgment of what you are about to do: ' +
            '"reversible" here, so no human is asked.'
    );
    out();

    const contact = contactOf(await call(session, 'execute_write', executeArgs(reply.tokenId, mutation)));
    showContact(contact);
    out();
    say(
        'The second note carries a wall-clock timestamp: the store stamps its own ' +
            'notes, and unlike the guard and the audit log it has no injected clock. ' +
            'It is the only value in this transcript that changes between runs.'
    );
    out();

    check(reply.tier === 'reversible', 'propose_write reported tier "reversible" for add_note');
    check(reply.expiresAt === now() + TTL_MS, `the warrant expires at ${now() + TTL_MS}, one TTL out`);
    check(contact.notes.length === 2, 'c-001 now carries the proposed note');
}

async function stepDestructive(session: Session): Promise<void> {
    tick();
    heading('STEP 3', 'WRITE - destructive, and a human says yes first');
    say(
        'change_stage discards the previous stage, so the guard tiers it ' +
            'destructive - and the server will not perform a destructive write ' +
            'without asking the operator, by name, over MCP form elicitation.'
    );
    out();

    const mutation = { op: 'change_stage', contactId: 'c-002', newStage: 'Qualified' };
    const reply = await propose(session, mutation);
    out();

    session.human.answer = true;
    const before = session.human.prompts.length;
    const contact = contactOf(await call(session, 'execute_write', executeArgs(reply.tokenId, mutation)));
    showContact(contact);
    out();
    say(
        'Read the prompt above again. It names the op, the contact by id and by ' +
            'name, and the exact new stage, so the sentence the human agreed to and ' +
            'the tool call the model made can be matched by eye. A dialog that says ' +
            '"allow this write?" confirms nothing.'
    );
    out();

    check(reply.tier === 'destructive', 'propose_write reported tier "destructive" for change_stage');
    check(session.human.prompts.length === before + 1, 'the server asked the human exactly once');
    check(contact.stage === 'Qualified', 'c-002 moved Contacted -> Qualified');
}

async function stepReplay(session: Session): Promise<void> {
    tick();
    heading('STEP 4', 'REFUSAL - replay: the same warrant, a second time');
    say(
        'The warrant from step 3 has been spent. The model presents it again, ' +
            'with the identical mutation. Note what happens first: the human is ' +
            'asked again, and says yes again. The confirmation gate runs before the ' +
            'guard is consulted, so consent is never the thing that saves this.'
    );
    out();

    const tokenId = mintedIds[1];
    if (tokenId === undefined) {
        throw new DemoAssertionError('step 3 minted no warrant to replay');
    }
    const mutation = { op: 'change_stage', contactId: 'c-002', newStage: 'Qualified' };

    session.human.answer = true;
    const text = refusalOf(
        await call(session, 'execute_write', executeArgs(tokenId, mutation)),
        'ReplayedTokenError'
    );
    out();
    say(
        'The refusal names the rule, and it names the token by an eight-character ' +
            'fingerprint rather than in full. The caller already holds the id it ' +
            'presented, so it loses nothing - and a transcript, a log line or a ' +
            'crash report never ends up quoting a live warrant.'
    );
    out();

    check(!text.includes(tokenId), 'the refusal quotes a fingerprint, never the whole token id');
    const contact = contactOf(await call(session, 'get_contact', { contactId: 'c-002' }));
    check(contact.stage === 'Qualified', 'c-002 moved once, not twice');
}

async function stepBaitAndSwitch(session: Session): Promise<void> {
    tick();
    heading('STEP 5', 'REFUSAL - bait and switch: propose a note, execute a delete');
    say(
        'The classic. Propose something harmless to get a warrant, then present ' +
            'that warrant with the write you actually wanted. The human is set to ' +
            'yes for this step: they will be asked to confirm the deletion and they ' +
            'will agree to it. Consent is not the defence here.'
    );
    out();

    const bait = { op: 'add_note', contactId: 'c-003', text: 'Checking in on the SKU list.' };
    const reply = await propose(session, bait);
    out();

    const switched = { op: 'delete_contact', contactId: 'c-003' };
    const asked = session.human.prompts.length;
    session.human.answer = true;
    refusalOf(
        await call(session, 'execute_write', executeArgs(reply.tokenId, switched)),
        'MutationMismatchError'
    );
    out();
    say(
        'The token embeds the mutation it authorizes; it does not point at one. ' +
            'There is no scope to interpret and no id to re-target - the presented ' +
            'op diverged from the bound op, and that ends it.'
    );
    out();
    say(
        'A mismatch is not a typo to forgive. It is a warrant under attack, so it ' +
            'is burned on the spot. Watch the model retreat to the mutation it was ' +
            'actually entitled to make:'
    );
    out();

    refusalOf(
        await call(session, 'execute_write', executeArgs(reply.tokenId, bait)),
        'ReplayedTokenError'
    );
    out();

    check(session.human.prompts.length === asked + 1, 'the human confirmed the deletion and it still failed');
    const contact = contactOf(await call(session, 'get_contact', { contactId: 'c-003' }));
    check(contact.notes.length === 2, 'c-003 is untouched: not deleted, and not even annotated');
}

async function stepDeclined(session: Session): Promise<void> {
    tick();
    heading('STEP 6', 'REFUSAL - the human says no');
    say(
        'A valid warrant, a real deletion, and an operator who does not want it. ' +
            'Anything that is not a yes is a no, and it is not retried by asking ' +
            'again.'
    );
    out();

    const mutation = { op: 'delete_contact', contactId: 'c-006' };
    const reply = await propose(session, mutation);
    out();

    session.human.answer = false;
    const text = refusalOf(
        await call(session, 'execute_write', executeArgs(reply.tokenId, mutation)),
        'ConfirmationDeclinedError'
    );
    out();
    say(
        'The refusal says the warrant was NOT spent, and it means it: the ' +
            'confirmation runs before the guard is consulted, so declining costs ' +
            'the operator nothing. Asking afterwards would mean every "no" burned a ' +
            'warrant the user was entitled to spend.'
    );
    out();

    check(text.includes('NOT spent'), 'the refusal states that declining did not burn the warrant');
    const contact = contactOf(await call(session, 'get_contact', { contactId: 'c-006' }));
    check(contact.id === 'c-006', 'c-006 is still in the book');
}

async function stepFloor(session: Session): Promise<void> {
    tick();
    heading('STEP 7', 'REFUSAL - the floor: every layer said yes');
    say(
        'c-007 asked in writing to be left alone, and sits in Closed-Lost-DNC. ' +
            'This is the fully approved flow: the model proposes, the guard mints, ' +
            'the human is standing by set to yes, and the warrant is presented with ' +
            'exactly the mutation it was minted for.'
    );
    out();

    const mutation = { op: 'add_note', contactId: 'c-007', text: 'One more touch before we close it out.' };
    const reply = await propose(session, mutation);
    out();

    session.human.answer = true;
    const asked = session.human.prompts.length;
    refusalOf(
        await call(session, 'execute_write', executeArgs(reply.tokenId, mutation)),
        'NeverWriteStateError'
    );
    out();
    say(
        'No prompt was raised: add_note is the reversible tier, so there was ' +
            'nothing to ask. Every layer that could consent did. The store refused ' +
            'anyway, on its own rule, knowing nothing about tokens or MCP - which ' +
            'is the whole argument for putting a rule at the bottom rather than at ' +
            'the gate. The warrant was spent on a write that never happened, and no ' +
            'success was recorded for it.'
    );
    out();

    check(session.human.prompts.length === asked, 'the reversible tier asked nobody, as designed');
    const contact = contactOf(await call(session, 'get_contact', { contactId: 'c-007' }));
    check(contact.notes.length === 2, 'c-007 is unchanged: the frozen record stayed frozen');
}

function clockOf(at: string): string {
    return at.slice(11, 19);
}

function describeEvent(event: AuditEvent): string {
    switch (event.kind) {
        case 'read':
            return `read            ${event.tool} - ${event.summary}`;
        case 'propose':
            return `propose         ${event.op} ${event.contactId} [${event.tier}] ${event.tokenFingerprint}`;
        case 'confirm_requested':
            return `confirm_asked   ${event.op} ${event.contactId}`;
        case 'confirm_outcome':
            return `confirm_answer  ${event.op} ${event.contactId} -> ${event.outcome}`;
        case 'execute_success':
            return `execute_ok      ${event.op} ${event.contactId} ${event.tokenFingerprint}`;
        case 'refusal':
            return `refusal         ${event.tool} -> ${event.rule}`;
    }
}

async function stepAudit(session: Session): Promise<void> {
    tick();
    heading('STEP 8', 'AUDIT - what was asked for, and what was refused');
    say(
        'The log is append-only: the class has exactly two methods, append and ' +
            'list, and no tool can edit or clear it. read_audit is registered only ' +
            'because this demo asked for it - the default is not to hand the model a ' +
            'window onto the record of what it just tried.'
    );
    out();

    const payload = payloadOf(await call(session, 'read_audit', {})) as {
        count: number;
        events: AuditEvent[];
    };
    out();
    payload.events.forEach((event, index) => {
        out(`    ${String(index + 1).padStart(2)}  ${clockOf(event.at)}  ${describeEvent(event)}`);
    });
    out();
    say(
        `Every warrant in that trail appears as its first ${FINGERPRINT_PREFIX_LENGTH} characters ` +
            `followed by "${FINGERPRINT_ELLIPSIS}" - enough to follow one warrant ` +
            'from proposal to outcome, never enough to present it. That is not a ' +
            'convention: the field holds a branded type that only the truncating ' +
            'function can produce, so logging a whole token id is a compile error. ' +
            'The same truncation is applied by value to the free text of every ' +
            'refusal, because the guard\'s own messages name the token they refused.'
    );
    out();

    const serialized = JSON.stringify(payload.events);
    check(
        mintedIds.every((id) => !serialized.includes(id)),
        `none of the ${mintedIds.length} minted token ids appears anywhere in the trail`
    );
    const fingerprints = payload.events.flatMap((event) =>
        event.kind === 'propose' || event.kind === 'execute_success' ? [event.tokenFingerprint] : []
    );
    check(
        fingerprints.length > 0 &&
            fingerprints.every(
                (mark) =>
                    mark.endsWith(FINGERPRINT_ELLIPSIS) &&
                    mark.length === FINGERPRINT_PREFIX_LENGTH + FINGERPRINT_ELLIPSIS.length
            ),
        `all ${fingerprints.length} token references are truncated fingerprints`
    );
    check(
        payload.events.filter((event) => event.kind === 'execute_success').length === 2,
        'exactly 2 writes were performed - the two happy paths'
    );
    check(
        payload.events.filter((event) => event.kind === 'refusal').length === 5,
        'exactly 5 refusals were recorded, each naming the rule that produced it'
    );
    check(
        session.human.prompts.length === 4,
        'the human was asked 4 times, and only destructive writes asked'
    );
}

function summary(): void {
    heading('SUMMARY', 'five rules, demonstrated rather than asserted');
    say(
        'Reads are free and writes are not: there is no single tool call that ' +
            'changes a contact, only propose_write and execute_write, so a confused ' +
            'or coerced model has nothing to reach for by accident (steps 1-2). A ' +
            'warrant is bound to one exact mutation, is single-use, and is burned - ' +
            'not merely rejected - when it is presented with a different one, so ' +
            'replay and bait-and-switch both dead-end, and the burn takes the ' +
            'attacker\'s legitimate write down with it (steps 4-5). Destructive ' +
            'writes are confirmed by a human who is shown the operation, the ' +
            'contact and the payload in one sentence, and the asking happens before ' +
            'the guard is consulted so that saying no is free and a client with no ' +
            'confirmation channel is refused rather than quietly obeyed (steps 3 ' +
            'and 6). Underneath all of it the store keeps its own floor: a ' +
            'do-not-contact record refuses every write no matter who consented ' +
            'above it, which is what makes this defence in depth rather than a ' +
            'single gate with three signs on it (step 7). And every one of those ' +
            'moments - asked, confirmed, written, refused - lands in an append-only ' +
            'log that names the rule that fired and identifies warrants only by ' +
            'truncated fingerprint, so the record can be read by whoever it ' +
            'incriminates without handing them a credential (step 8).'
    );
    out();
}

/* -------------------------------------------------------------------------- */
/* Wiring and run                                                             */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
    const store = new InMemoryContactStore();
    const audit = new AuditLog({ now });
    const guard = new Guard({ ttlMs: TTL_MS }, { now, generateId: nextTokenId });

    // exposeAudit: an operator's deliberate choice, made here so step 8 has a
    // tool to call. Off by default in buildServer.
    const server = buildServer({ store, guard, audit }, { exposeAudit: true });

    const human: Human = { answer: true, prompts: [] };
    const client = new Client(
        { name: 'demo-operator-console', version: '0.1.0' },
        { capabilities: { elicitation: { form: {} } } }
    );

    // The human side of the fake client. A real one opens a dialog here.
    client.setRequestHandler(ElicitRequestSchema, (request): ElicitResult => {
        const message = request.params.message;
        human.prompts.push(message);
        marked('[ask]', `server asks the human: ${message}`);
        marked('[human]', human.answer ? 'answers YES' : 'answers NO');
        return { action: 'accept', content: { confirm: human.answer } };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const session: Session = { client, human };

    try {
        out();
        out('mcp-capability-guard - a narrated session against a real MCP server');
        say(
            'Every result below crossed an in-memory MCP transport as a real tool ' +
                'call. The client is scripted; the server, the guard, the store and ' +
                'the audit log are the ones that ship.'
        );

        await stepRead(session);
        await stepReversible(session);
        await stepDestructive(session);
        await stepReplay(session);
        await stepBaitAndSwitch(session);
        await stepDeclined(session);
        await stepFloor(session);
        await stepAudit(session);
        summary();
    } finally {
        await client.close();
        await server.close();
    }
}

try {
    await main();
    out('demo complete: every step held.');
} catch (error: unknown) {
    out();
    out('DEMO FAILED');
    out(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
}
