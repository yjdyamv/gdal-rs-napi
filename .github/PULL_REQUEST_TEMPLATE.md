<!--
Keep this short: what changed, why, and how it was checked. One logical change
per PR. For the public surface, link docs/API-STABILITY.md where relevant.
-->

## What and why

<!-- The change, and the problem it solves. -->

## How it was checked

<!--
The commands you ran and what they said. At minimum:
  npm run lint
  npm run typecheck
  npm test
and, when Rust changed:
  cargo clippy --release --all-targets -- -D warnings
  cargo test --release --target <host-triple> --lib
-->

## Checklist

- [ ] One logical change.
- [ ] Comments explain *why*, matching the surrounding style.
- [ ] Tests cover the change (`ts-test/**`, and a Rust unit test where the mapping is pure).
- [ ] `README.md` / `CHANGELOG.md` / `docs/PARITY.md` updated if the public surface changed.
- [ ] Naming follows `docs/API-STABILITY.md` (`xxxSync()` / `xxx()` / `xxxAsync` getters, string enumerations).
- [ ] The right side of the process-wide lock is taken for any new entry point.
