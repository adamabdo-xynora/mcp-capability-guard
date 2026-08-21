# mcp-capability-guard

Most MCP servers hand the model a loaded gun with a shared bearer token: one credential, every tool, every call. This server makes the model ask permission per bullet.

It is a small, complete MCP server over a **fictional in-memory CRM** (Larkspur Supply Co., seven invented contacts) that demonstrates capability-token write authorization — a pattern extracted from a production CRM agent I run against a real 12,000+ contact book. The data here is fiction; the enforcement is the part that ships.

## The design, in five layers

1. **Tiered tool surface.** Reads (`list_contacts`, `get_contact`) are free. Writes do not exist as single tools — there is no `add_note` tool and no `delete_contact` tool. Every mutation flows through exactly two calls: `propose_write`, then `execute_write`.
2. **Capability tokens (the centerpiece).** `propose_write` mints a single-use, TTL-bound warrant bound to *one exact mutation* — the token embeds the mutation, it does not point at one, so there is no lookup table to poison and no id to re-target. `execute_write` presents the token together with the mutation, and the guard verifies field-by-field equality. Presenting a warrant with a different mutation doesn't just fail — it **burns the token**, taking the attacker's legitimate write down with it.
3. **Human confirmation for the destructive tier.** `change_stage`, `remove_tag`, and `delete_contact` additionally require the operator's explicit yes over MCP form elicitation, in a prompt that names the operation, the contact, and the payload in one sentence. The ask runs **before** the guard is consulted, so declining never spends the warrant — and a client with no elicitation channel gets destructive writes refused, not silently executed. Fail closed, both ways.
4. **A floor the layers above can't override.** Contacts in the `Closed-Lost-DNC` stage (do-not-contact, legal hold) refuse every write *inside the store itself*, which knows nothing about tokens or MCP. A fully approved flow — valid warrant, matching mutation, confirmed human — still dead-ends there. That is what makes this defence in depth rather than a single gate with three signs on it.
5. **An append-only audit log that can't leak warrants.** Every propose, confirm, execute, and refusal is recorded. Token ids enter the log only as 8-character fingerprints — and that is a *compile-time* guarantee: the fingerprint field holds a branded TypeScript type that only the truncating function can produce. Free text is scrubbed by value as well, because the guard's own refusal messages name the token they refused. (This is the same redact-by-value discipline as my [webhook-guard](https://github.com/adamabdo-xynora/webhook-guard) — there for HTTP credentials, here for live warrants.) `read_audit` is deny-by-default: unless the server is built with `exposeAudit: true`, the tool is not registered at all.

## See it run

    npm install
    npm run demo

The demo wires the real server to a scripted client over an in-memory MCP transport and narrates eight steps: two writes that land (one reversible, one destructive-and-confirmed), then five attacks — replay, bait-and-switch, a declined confirmation, a target shift, and a fully-approved write against the frozen record — each meeting its typed refusal while the store stays byte-identical. It ends by reading the audit trail and checking that no full token id appears anywhere in it. The demo asserts every expectation inline and exits nonzero on any miss, so it doubles as a smoke test and runs in CI on every push.

    npm test              # 158 offline tests
    npm run typecheck     # strict TypeScript, no emit

Everything is offline: no API keys, no network, no environment variables, nothing to configure. That is why CI runs the entire suite, demo included, on every push with no secrets.

## The evidence is in the test suites

Two suites exist specifically to keep the claims above honest:

- **`test/structural.test.ts`** reads the source *as text* and pins the architecture: `src/tools.ts` is the only module importing the MCP SDK; the store knows nothing above it; the guard and audit modules import only what their headers claim; token minting is confined to the guard; the string `tokenId` never appears in `src/audit.ts`. If a refactor quietly moves SDK code into the store, this suite fails before any behavior does.
- **`test/adversarial.test.ts`** plays a hostile model against the fully wired server: skip-the-propose, replay, bait-and-switch with burn verification, re-pointing a warrant at a different contact, a full-approval assault on the frozen record, an expired warrant via an injected clock, a confirmation dodge, and an audit-integrity check with attacker-chosen token ids. Every attack must meet its exact typed refusal, and after all of them the store must be unchanged.

The remaining ~140 tests cover the store, guard, audit, and tool surface unit-by-unit, including the ordering invariant that the confirmation runs before the warrant can be spent.

## Versioning and scope

Built on @modelcontextprotocol/sdk 1.30.0, which targets MCP revision 2025-11-25. The 2026-07-28 revision makes server-minted handles passed as ordinary tool arguments the canonical mechanism for cross-call state (SEP-2567) — the capability token in this repo is exactly that pattern, used as an authorization primitive, so the design carries forward unchanged into the stateless protocol.

Two runtime dependencies: the SDK itself, and `zod`, which is the SDK's own peer-dependency schema language — tool input schemas are zod schemas by SDK design, so it is not an added dependency so much as the SDK's other half. Nothing else enters the tree. The store, guard, and audit modules are pure TypeScript with zero imports beyond `node:crypto` and each other's types, which is what lets 158 tests run offline in under half a second.

**What this is not.** This repo does not implement OAuth or the MCP authorization spec's resource-server role. Those solve a different problem: proving *who the client is* at the transport boundary. Capability tokens govern *what an authenticated session may do, one write at a time* — the two compose rather than compete, and conflating them is how servers end up with one bearer token that authorizes everything. Transport identity is deliberately out of scope here so the authorization pattern stays legible.

## Limitations, stated plainly

- The CRM is fictional and in-memory. Persistence, concurrency, and multi-user sessions are real problems this demo does not have.
- Tokens live in server memory; a restart forgets them. In production the same pattern runs against a durable store with the same single-use semantics.
- The elicitation confirmation is only as good as the client's rendering of it. A client that shows the user a bare "Allow?" instead of the server's sentence weakens the guarantee — which is an argument for putting the full sentence in the request, as this server does, not for skipping the ask.
- The store's note timestamps use the wall clock, so one line of demo output varies between runs. The guard and audit log use injected clocks and are deterministic.

## Adapting it

The pattern transfers to any MCP server whose writes have consequences: replace the store with your system, keep the propose/execute split, decide your own tiers, and keep the floor rule *in the data layer* rather than the tool layer. The guard and audit modules import nothing from MCP and can be lifted out whole.

MIT license.
