# Third-party notices

This project is MIT licensed and reuses MIT-licensed work from two upstream
projects. Both licences are reproduced in this directory in full.

## browser-use/jev-ultrafast — MIT

Copyright (c) 2026 Browser Use. Full text: `LICENSES/jev-ultrafast.LICENSE`.

Ported or re-implemented from that repository (commit fetched 2026-09-20):

| Upstream file | This project | Nature of the reuse |
| --- | --- | --- |
| `jev_ultrafast/snapshot.js` | `src/jev/snapshot.ts` (`SNAPSHOT_SOURCE`) | Direct port of the in-page observation script: selector set, role mapping, accessible-name algorithm, visibility rules, guard tuple, `page_key`, action-space construction, scroll/wait pseudo-actions. Adapted: marker/page-key/guards are digested in-page, rectangles are rounded, an `unsupported` signal block is added. |
| `jev_ultrafast/browser.py` (`target` snippet) | `src/jev/snapshot.ts` (`actTargetSource`) | Direct port of the pre-input re-check and geometry resolution. |
| `jev_ultrafast/browser.py` (`after_input` snippet) | `src/jev/snapshot.ts` (`settleSource`) | Direct port of the post-input settle wait. |
| `jev_ultrafast/browser.py` (`fingerprint`, `fresh`, `act`) | `src/jev/freshness.ts`, `src/jev/executor.ts` | Re-implemented in TypeScript against the Pi cell backend instead of Browser Harness. |
| `jev_ultrafast/model.py` (`action_space`) | `src/jev/action-space.ts` | Direct port. |
| `jev_ultrafast/model.py` (`choose`, `validate_choice`) | `src/jev/policy.ts` | Direct port, with the HTTP transport behind an injectable interface. |
| `jev_ultrafast/model.py` (`field_context`, `field_text`) | `src/jev/text-helper.ts` | Direct port, with the HTTP transport behind an injectable interface. |
| `jev_ultrafast/questions.py` | `src/jev/questions.ts` | `NEXT_ACTION`, `TARGET` and `TEXT_VALUE` reproduced; `NEXT_ACTION` and `TEXT_VALUE` each gained one paragraph specific to this project (fallback contract, credential prohibition). `VERDICT` is new. |
| `jev_ultrafast/agent.py` | `src/router/hybrid-router.ts` | The loop's ordering rules (consume-once decisions, record-before-observe, three-strikes no-change detection) follow upstream; the routing, approval, audit and verification layers are new. |

Not reused: upstream's demo inspector, static assets, benchmark scripts,
recorded measurements and documentation images.

## browser-use/browser-use-pi (`@browser_use/pi`) — MIT

Copyright (c) 2026 Browser Use. Full text: `LICENSES/browser-use-pi.LICENSE`.

Used as a runtime dependency through its public API only
(`BrowserUse.create`, `Browser.chrome/chromium/cloud`, `agent.run`,
`agent.followUp`, `agent.execute`, `agent.events`, `agent.cancel`,
`agent.close`, and the exported option types). No file from that package is
copied, patched or vendored, and no module under its `dist/` is imported
directly.
