# PPQ typed decisions — slice 2 checkpoint

This slice adds PPQ to the existing stable `method: "decide"` flow. Chat and
decisions share one PPQ API key, with independent model selections, approval,
and site grants. Speech has its own [checkpoint](ppq-speech-smoke-test.md). No authenticated PPQ decision call
has been run by the automated tests; these checks establish runtime behavior.

## Setup and catalog

1. Reload the development extension and your HTTPS or localhost test page.
2. Keep your PPQ key saved in **Options → Providers**. Leave the chat model
   unchanged; a decision model must not replace it.
3. In **Options → Decisions**, select **PPQ.ai** and a live decision model.
   Start with `typesafe/jev-1.13` or `~typesafe/jev-latest` if listed. Changing
   the selection saves the Decisions default automatically.
4. Use a fresh origin or revoke only its **Decisions** grant in **Site access**.
   Existing site grants can retain a different provider/model from the global
   Decisions default. Check the provider and model shown in the popup.

- [ ] The list comes from `https://api.ppq.ai/v1/decisions/models`, independently
  of chat `/v1/models`. It includes current non-Jev models and aliases.
- [ ] Switching Decisions models leaves the saved chat model unchanged, and
  reopening Options preserves both selections.
- [ ] Decisions selections remain independent of transcription and synthesis.

## Three typed answers

Paste into the test page's DevTools console. Calls can incur PPQ charges; keep
your API key in Options and out of page code and test reports.

```js
var ppqDecisionRequest = {
  method: "decide",
  state: { ticket: "I was charged twice for my subscription. Please refund the duplicate." },
  questions: {
    is_billing: {
      type: "noul",
      instructions: "Is this a billing issue?",
    },
    team: {
      type: "choice",
      instructions: "Which team should handle this ticket?",
      criteria: { billing: "Payments and refunds", engineering: "Software defects" },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is this ticket?",
      criteria: ["Can wait", "Needs attention soon", "Immediate emergency"],
    },
  },
};
var ppqDecisionChunks = [];
try {
  for await (const chunk of window.inference.request(ppqDecisionRequest)) {
    ppqDecisionChunks.push(chunk);
    console.log(chunk.type, chunk);
  }
} catch (error) {
  console.log(error.code, error.message);
}
```

- [ ] The popup describes **Decisions** and previews state and question types.
  A previous chat or speech approval must not suppress it.
- [ ] Choose **Allow once**. A successful request emits `accepted` then one
  `done`, with no text/reasoning deltas or chat message substitute.
- [ ] `done.answers.is_billing.noul` is between 0 and 1.
- [ ] The choice is a requested team, with probabilities for both teams and
  bounded confidence. The winning choice has maximum probability.
- [ ] The score is between 0 and 2 with a matching legend, probabilities, and
  bounded confidence. It reflects the weighted position across those levels.
- [ ] Extension background DevTools shows a POST to
  `https://api.ppq.ai/v1/decisions` containing `model`, `state`, and `questions`,
  without `stream`, chat `messages`, or hosted tools. Do not share headers.
- [ ] Repeat with the latest alias and one other catalog model. Record exact
  model IDs and sanitized errors; catalog discovery alone does not prove each
  model interoperates with all three question types.

## Permissions, errors, and cancellation

- [ ] **Deny** prevents a decision POST. **Allow once** prompts on a new request;
  **Always allow** skips later Decisions prompts for the same origin/route.
- [ ] A Decisions grant does not authorize chat, transcription, or synthesis.
  Revoking Decisions leaves those separate grants untouched.
- [ ] Temporarily remove the PPQ key, then restore it. Decisions gives a setup
  hint without posting the state when the key is missing. Authentication and
  billing errors should be actionable without echoing the key.
- [ ] Invalid requests (for example empty `questions`) fail as `invalid_request`
  before approval or networking. Unknown/retired models fail without chat fallback.
- [ ] Firefox: revoke PPQ host access in add-on settings. Decisions must fail
  before `accepted`; restore access and retry.

For cancellation, start a request with a page-owned controller:

```js
var ppqDecisionController = new AbortController();
var ppqDecisionRun = (async () => {
  try {
    for await (const chunk of window.inference.request({
      ...ppqDecisionRequest, signal: ppqDecisionController.signal,
    })) console.log(chunk.type, chunk);
  } catch (error) {
    console.log(error.code, error.message);
  }
})();
```

Then run `ppqDecisionController.abort()` while approval or the provider request
is pending. Expect `aborted`, no later `done`, and a successful fresh request
afterward. If the model already finished, repeat; abort cannot undo completion.

Report browser, model ID, whether all three answers passed, approval behavior,
and any sanitized error. Reference: [PPQ API docs](https://ppq.ai/api-docs).
