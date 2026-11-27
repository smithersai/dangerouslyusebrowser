# C++20 N-API bridge and IPC protocol

Dub keeps Chromium out-of-process so the browser's multiprocess sandbox, UI loop, and V8 isolates remain isolated from Node.js. Communication crosses a small C++20 N-API v8 addon (`native/addon.cc`, `native/dub.cc`, `native/dub.h`) over a private local `AF_UNIX` socket.

## Protocol v1 wire format

```
+---------------------------+----------------------------------------+
| uint32 big-endian length  | UTF-8 JSON payload (1 byte to 16 MiB)  |
+---------------------------+----------------------------------------+
```

- **Request envelope**: `{"protocol":1,"id":"<uuid>","method":"<name>","params":{...},"timeoutMs":30000}`
- **Response envelope**: echoes `id` and carries either `result` or `{"error":{"code":"...","message":"..."}}`.
- **Whole-call deadlines**: `dub_call` enforces an absolute monotonic deadline. A stalled browser or slow one-byte trickle cannot reset the timer.
- **No silent retries**: Timeout or disconnect never implies rollback and never retries side-effecting commands automatically.

## Push event stream (`subscribe`)

Milestone 4 added `NativeBridge.subscribe()` backed by persistent non-blocking `AF_UNIX` streaming in `native/addon.cc` and `native/dub.cc`. Chromium pushes live network callbacks, console entries, dialogs, navigations, downloads, and exposed page calls into Node without polling, powering `src/triggers.ts` and `src/plugins.ts`.

## Compilation and safety invariants

`scripts/build-native.mjs` compiles `native/addon.cc` and `native/dub.cc` with:

```
-std=c++20 -O2 -Wall -Wextra -Werror -fPIC -shared -DNAPI_VERSION=8
```

- Zero `abort()`, `exit()`, or `std::terminate()` calls are allowed in `native/` (enforced continuously by Uphill's `cpp-no-abort` gate).
- Prebuilt binaries ship under `prebuilds/darwin-arm64/dub.node` and `prebuilds/linux-x64/dub.node`, and `scripts/install.mjs` compiles on demand when a matching prebuild is absent.
- `tests/native.test.mjs` and `tests/fuzz.test.mjs` verify fragmented UTF-8 reads, parallel calls, whole-call deadlines, slow trickles, 120 malformed/truncated/oversized frames, and clean subscription teardown.

## Related pages

- [[start-here]]
- [[chromium-seams]]
- [[plugins-and-triggers]]
