# 0086: Native user skill learning and bounded source reads

Status: Accepted

## Decision

Native prompting has no per-message learning checkbox. Existing profile-owned
automatic curation remains enabled by default for managed vaults and may skip
trivial, repetitive or unsupported work. Explicitly disabled profiles and their
note destinations remain unchanged.

A direct current user request such as “Learn this as a skill” or “Tolong pelajari
link ini” can authorize the existing one-candidate lead proposal flow. The host
recognizes bounded English/Indonesian request forms; quoted commands, source
documents, past turns and model claims confer no such authority. The legacy
`/learn-skill` command and client option remain compatible. Direct proposals
retain workspace write approval, plan and runtime restrictions; they do not also
schedule a duplicate curator. Ordinary useful work follows the profile curator.

Both paths save generated instructions-only candidates in the shared user Skills
library. They never edit shipped built-ins or approve/activate their output.
Registry inspection, immutable revisions and existing activation consent remain
authoritative. Unsupported platforms or missing scanners report their actual
capability/state.

## Source reading

`skill_source_read` reads only URLs captured from the initiating current user
message. It is lead-only and offered in eligible direct learning or enabled
automatic profile contexts. Successful reads can supply current-turn evidence to
the existing automatic curator. Direct linked proposals must attribute at least
one successfully read source, and may attribute only successfully read URLs.
Failed or empty source reads cannot authorize a claimed linked candidate.

A supervised Rust child performs network and content processing outside the
control daemon. It accepts public HTTP(S) sources only, with no credentials,
query parameters, unusual ports, cookies, proxies or inherited credentials.
Every redirect is revalidated; admitted DNS addresses are pinned without resolver
fallback. Private/reserved addresses are refused. Reads have a 15-second budget,
three redirects, 128 KiB response and 32 KiB excerpt limits. HTML active content
is removed; binary and empty responses are refused. A per-turn limit admits
three distinct attempts. Cancellation retains ownership until the child exits.
The host admits at most two source children concurrently and reports busy rather
than creating an unbounded queue or releasing a cancelled child early.

Fetch receipts include source/final URL, bytes, digest and truncation. Excerpts
remain untrusted data. Fetching does not establish source safety, scanner
verification, faithful rendering of dynamic pages, or permission to execute code.

## Placement and verification

Rust owns DNS/network admission, redirects, body limits, text extraction and
hashing. TypeScript retains small current-message admission metadata and child
supervision; routing those checks through an additional RPC for every prompt has
no demonstrated efficiency benefit. No inference savings or speedup is claimed.

Tests cover current-message authority, source-before-proposal, failed reads,
user-library persistence, existing curator admission, URL/address/redirect/text
bounds, cancellation settlement and absence of the checkbox. Fixtures use
temporary profiles; browser/provider simulations are identified separately from
actual public-source fetches.
