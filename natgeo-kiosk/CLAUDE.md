# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

See `AGENTS.md` for design history, decisions, and pitfalls — read it before any
non-trivial change. `README.md` documents user-facing behavior and operation.

## Hard rules (from AGENTS.md)

1. `npm test` must be green before every `git commit`.
2. **Bump the version in `package.json` before every push.** It surfaces via
   `/api/config` in the page corner. Semver with judgment: major for
   incompatible config/API changes, minor for user-visible features, patch for
   fixes.
3. **Every commit message includes the current version** as `(vX.Y.Z)`, even
   commits that don't bump it.
4. **No bundlers, no build step.** `public/index.html` is one file; `server.js`
   is plain Express.
5. **No scrolling.** `height: 100vh; overflow: hidden`.
6. **A failed harvest must never silently degrade the display.** See
   *The Central Invariant* in AGENTS.md.

## Commands

```bash
npm install
npm start                    # node server.js, port 3000
npm run dev                  # node --watch server.js
npm test                     # node --test test/*.test.js — no network needed
npm run harvest              # harvest the current issue
npm run harvest -- --force   # re-harvest even if unchanged
npm run verify               # probe the live site, print its structure
bash restart.sh              # kill the old process, start fresh
```

Single test: `node --test --test-name-pattern="<name>" test/extract.test.js`.

## Architecture

- `public/index.html` — the entire frontend in one file. Two crossfade layers,
  each holding a blurred `.backdrop` and a sharp `.photo` **as siblings** (see
  AGENTS.md — the obvious `z-index: -1` version is broken).
- `server.js` — Express, `/api/slides`, `/api/status`, image serving off the data
  volume, plus the in-process daily scheduler. `buildHealth()` is the single
  place deciding what the TV warns about.
- `bin/harvest.js` — the pipeline. Exit codes are meaningful (2 = expired
  cookie, 3 = structure unrecognized, 4 = network, 5 = nothing harvested).
- `bin/verify.js` — live structural probe. The tool for any "the site changed"
  investigation.
- `lib/extract.js` — four independent extraction strategies, merged. **No NatGeo
  class names.** Don't replace with selectors.
- `lib/images.js` — resolution ladder, real dimension parsing, download.
- `lib/fetch-natgeo.js` — authenticated fetch and session-expiry classification.
- `lib/condense.js` — Claude API caption condensing via a strict tool, cached.
- `lib/store.js` — staged, atomic issue replacement. The safety net.

## Common pitfalls (from AGENTS.md)

1. Screenshot the page after any CSS change — layer bugs pass tests.
2. Tests must never hit the network or need an API key.
3. Never write images straight into the live issue directory.
4. Secrets come from the environment only, never `config.json`.
5. The harvester has **not yet been verified against the live site** — see
   *Unverified Against Live* in AGENTS.md, and update it once it has.
