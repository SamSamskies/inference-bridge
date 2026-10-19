# Release notes

## Unreleased

Typed decisions (System One) now use stable `window.inference.request({ method:
"decide", state, questions })`. Synchronous `getFeatures().methods.decide: true`
advertises the optional IPA contract without revealing providers, models, keys,
or permissions. The companion IPA specification landed in
[inference-provider-api #64](https://github.com/SamSamskies/inference-provider-api/pull/64).

Decision provider/model defaults and per-origin decision grants stay separate
from chat and speech. Existing routes and grants need no migration.
`experimental.request()` remains a deprecated compatibility alias and warns once
per page, now including decisions. Experimental discovery keeps its legacy
`chat: true` entry and mirrors stable optional methods. `experimental.runTools`
remains a Bridge helper.

Provider results now fail with `provider_error` when the selected choice is not
a probability maximum, a score differs from its normalized weighted index by
more than 0.02, or a score legend changes the requested rubric. Tied maxima and
rounding within 0.02 remain valid. Malformed answers never produce `done` or get
silently repaired. Mixed and all-refusal results retain typed refusals.

The [README decisions example](../README.md#typed-decisions-system-one) and
[manual checks](../README.md#decisions) cover stable browser usage. Automated
conformance uses the companion IPA assertions with synthetic provider responses;
it does not establish live provider availability or model accuracy. Chrome and
Firefox checks with live backends remain required before release.
