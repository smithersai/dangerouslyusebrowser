# Lighthouse Backpressure Audit

Live composite score: **99 / 100** across **5 categories** with **0 open opportunities**.

Open the interactive SVG gauge dashboard at [dangerouslyusebrowser.smithers.sh/audit](https://dangerouslyusebrowser.smithers.sh/audit).

## Category Scores

| Category | Score | Status | Focus |
| --- | --- | --- | --- |
| Native Bridge & Seam Safety | **100/100** | Passing | Protect the C++20 N-API bridge, Chromium 157 overlay patches, and public repository hygiene. |
| TypeScript Quality | **99/100** | Passing | Enforce strict typing, zero compiler suppressions, clean stdout for MCP, and modular functions across src/. |
| MCP Security & Trust | **100/100** | Passing | Enforce loopback defaults, timing-safe one-time auth tokens, untrusted execution isolation, and protected factory paths. |
| Testing & Fuzzing | **95/100** | Passing | Maintain high test-to-source ratio, fuzz boundary coverage, and compiled-fork acceptance suites. |
| Docs, Wiki & Footprint | **100/100** | Passing | Keep prebuilt N-API binaries lean, markdown links valid, and public wiki, mythical history, and llms.txt current. |

## Metric Breakdown

### Native Bridge & Seam Safety (100/100)

| Metric | Score | Value | Target |
| --- | --- | --- | --- |
| Cpp no abort | 100/100 | `PASS` | `PASS` |
| Cpp strict flags | 100/100 | `PASS` | `PASS` |
| Overlay integrity | 100/100 | `PASS` | `PASS` |
| No private leaks | 100/100 | `PASS` | `PASS` |

### TypeScript Quality (99/100)

| Metric | Score | Value | Target |
| --- | --- | --- | --- |
| Ts no explicit any | 100/100 | `PASS` | `PASS` |
| Ts no suppressions | 100/100 | `PASS` | `PASS` |
| Ts no console log | 100/100 | `PASS` | `PASS` |
| Ts max fn lines | 96/100 | `79` | `<= 110` |

### MCP Security & Trust (100/100)

| Metric | Score | Value | Target |
| --- | --- | --- | --- |
| Loopback and timing safe | 100/100 | `PASS` | `PASS` |
| One time sandbox auth | 100/100 | `PASS` | `PASS` |
| Protected factory paths | 100/100 | `PASS` | `PASS` |
| Untrusted cache isolation | 100/100 | `PASS` | `PASS` |

### Testing & Fuzzing (95/100)

| Metric | Score | Value | Target |
| --- | --- | --- | --- |
| Test to src ratio | 93/100 | `68` | `>= 55` |
| Fuzz tests | 95/100 | `8` | `>= 5` |
| Unit tests | 97/100 | `46` | `>= 25` |
| Browser acceptance suites | 92/100 | `6` | `>= 5` |

### Docs, Wiki & Footprint (100/100)

| Metric | Score | Value | Target |
| --- | --- | --- | --- |
| Prebuild size | 99/100 | `59300 B` | `<= 160000 B` |
| Markdown links | 100/100 | `PASS` | `PASS` |
| Factory knowledge | 100/100 | `PASS` | `PASS` |

## Trust and Object Store Posture

- **Shared object store**: `https://build.smithers.sh` serves incremental `smthrs` build and test results.
- **Untrusted execution**: Fork and external PR runs execute freely with read-only cache access (`SMITHERS_CACHE_READ_TOKEN` only) and never poison the cache or bypass maintainer gates.
- **Run locally**: `uphill check && uphill --compact --require-targets --require-baseline`
