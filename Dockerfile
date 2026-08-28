# syntax=docker/dockerfile:1
#
# mcp-capability-guard — multi-stage build.
#
#   deps    npm ci from the lockfile alone (cached until the lockfile changes)
#   test    devDependencies + source + tests: runs the whole offline suite
#   build   compiles TypeScript to dist/ (tsx is a devDependency, so the
#           runtime cannot execute .ts files — it must run compiled JS)
#   runtime --omit=dev, dist/ only, non-root: the MCP server over stdio
#
# Verify the suite inside the image:
#   docker build --target test -t mcp-capability-guard:test .
#   docker run --rm mcp-capability-guard:test npm test
#   docker run --rm mcp-capability-guard:test npm run typecheck
#   docker run --rm mcp-capability-guard:test npm run demo
#
# Build the runtime image (the default target):
#   docker build -t mcp-capability-guard .
#
# NO SECRETS. There is no ARG or ENV for a credential anywhere in this file,
# no .env is copied in (.dockerignore keeps it out of the context entirely),
# and the server reads no environment variable and opens no file. It needs
# none: the store is seeded in memory. If a real ContactStore ever needs a
# credential, it arrives at run time — `docker run -e NAME=...` or a mounted
# file — and never as a build argument, which would be baked into a layer and
# recoverable from the image history.

# Pinned to the same major CI uses (.github/workflows/ci.yml: node-version 22).
# -slim is verified, not assumed: the full suite, typecheck and demo pass on it
# (see the README). Nothing here needs a compiler or a native module.
ARG NODE_IMAGE=node:22-slim


# ---------------------------------------------------------------------------
# deps: every dependency, from the lockfile only.
#
# Only package.json and package-lock.json are copied before `npm ci`, so this
# layer is invalidated by a lockfile change and by nothing else — editing a
# source file does not reinstall the world.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci


# ---------------------------------------------------------------------------
# test: the full tree on top of the full dependency set.
#
# Carries devDependencies (vitest, tsx, typescript) and the src/, test/, demo/
# and bin/ trees, so every offline command this repository has runs here
# unchanged: `npm test`, `npm run typecheck`, `npm run demo`. Nothing in any of
# them touches the network or needs a key — the demo wires the real server to
# a scripted client in memory.
# ---------------------------------------------------------------------------
FROM deps AS test
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY bin ./bin
COPY test ./test
COPY demo ./demo
CMD ["npm", "test"]


# ---------------------------------------------------------------------------
# build: compile to plain JavaScript.
#
# tsx and typescript are devDependencies. A `--omit=dev` install has neither,
# so the runtime image cannot run `tsx bin/serve.ts` — it runs the compiled
# output. tsconfig.build.json emits src/ and bin/ only (no tests, no demo, no
# .d.ts, no source maps) into dist/.
# ---------------------------------------------------------------------------
FROM test AS build
RUN npm run build


# ---------------------------------------------------------------------------
# runtime: production dependencies and compiled output, nothing else.
#
# `npm ci --omit=dev` from the lockfile gives exactly the two runtime packages
# (@modelcontextprotocol/sdk, zod) and their transitive closure. vitest, tsx,
# typescript and @types/node are deliberately absent: they are test and build
# tooling, the server never imports them, and every package that is not in the
# image is a package that cannot be exploited in it. No test/ or demo/ tree
# ships either — the tests are the proof, the image is the product.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node

# HOW THIS CONTAINER IS MEANT TO BE RUN.
#
# This is an MCP server speaking the Model Context Protocol over stdio. It is
# not a CLI that runs and exits, and it does not listen on a port: it reads
# JSON-RPC from stdin, writes JSON-RPC to stdout, and stays up until stdin
# closes. That has consequences for how it is launched:
#
#  1. stdin MUST be attached. `docker run` closes stdin by default, and a stdio
#      server whose stdin is closed sees EOF and exits immediately — it will
#      look like the container "does nothing". Always pass `-i`:
#
#          docker run -i --rm mcp-capability-guard
#
#      Do NOT pass `-t`. A TTY turns the stream into a terminal, which alters
#      line endings and echoes input back onto stdout — into the protocol.
#
#  2. The MCP client is the one that runs `docker`. A stdio server is a child
#      process of its client, so the client's config names docker as the
#      command, e.g. for Claude Desktop / Claude Code:
#
#          {
#            "mcpServers": {
#              "capability-guard": {
#                "command": "docker",
#                "args": ["run", "-i", "--rm", "mcp-capability-guard"]
#              }
#            }
#          }
#
#      Anything the server needs would be added as `"-e", "NAME=value"` in that
#      args list; today it needs nothing.
#
#  3. Diagnostics go to stderr only. stdout is the protocol; nothing in this
#      image writes anything else to it.
#
# Caveats, stated rather than hidden:
#  - The store is in-memory and re-seeded on every start. Every `docker run`
#    is a fresh CRM; nothing persists across restarts. That is what this
#    reference implementation ships; a real deployment supplies its own
#    ContactStore in bin/serve.ts.
#  - Because the client owns the container's lifetime, `docker run --rm` is
#    the right shape: when the client closes stdin the server exits and the
#    container is removed. A detached (`-d`) container is not useful here.
#  - Destructive writes ask the human through MCP elicitation. That request
#    travels back up the same stdio pipe to the client, so it works through
#    docker exactly as it does in-process — provided the client advertises
#    elicitation. A client that does not gets a typed refusal, not a prompt.
#  - Hand-testing without an MCP client works, with the same `-i` and no `-t`:
#
#          printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
#            | docker run -i --rm mcp-capability-guard
#
#    prints the initialize result and exits when the pipe closes.
#
# Plain `node`, not `npm start`: npm would sit between the client and the
# server as an extra process that swallows signals and can add its own noise.
CMD ["node", "dist/bin/serve.js"]
