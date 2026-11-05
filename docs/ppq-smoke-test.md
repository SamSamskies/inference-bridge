# PPQ.ai integration checkpoints — issue #127

1. **Chat and hosted search (this branch):** built-in provider, saved key,
   public searchable chat catalog, text/streaming, verified vision input,
   function tools and approved Auto search. Automated transport and permission
   tests pass; live authenticated chat/search still requires smoke testing.
2. **Decisions (next slice):** independent live decision catalog and default,
   System One typed answers, method-specific approvals and grants.
3. **Speech (following slice):** independent transcription/synthesis catalogs,
   compatible voices, bounded uploads/output, approvals and cancellation.

The issue remains open until all slices and authenticated runtime checks pass.
API reference: [PPQ documentation](https://ppq.ai/api-docs).

## Load the chat/search checkpoint

Use Chrome **Load unpacked** on the repository root, or run `npm run dev:firefox`
for a temporary Firefox test install. Reload the extension and the HTTPS page
after changing builds. In **Options → Providers**, select **PPQ.ai**, save your
key, and verify the searchable catalog loads. Use a paid model with function
tools for search tests; `auto` is the starter model, but an explicit model
makes results easier to reproduce. Keep the key in Options, never in page code
or test reports. Model and search calls can incur PPQ charges.

Use a fresh test origin or revoke its existing chat grant in **Site access**.
An existing site route can override the global provider. Confirm **PPQ.ai** and
the expected model appear in each approval dialog.

Paste this helper in DevTools on an HTTPS or localhost page:

```js
var ppqSmoke = async (prompt, extra = {}) => {
  var done;
  for await (const chunk of window.inference.request({
    method: "chat",
    messages: [{ role: "user", content: prompt }],
    ...extra,
  })) {
    console.log(chunk.type, chunk);
    if (chunk.type === "done") done = chunk;
  }
  return done;
};
```

## Chat, streaming, and catalog fallback

```js
await ppqSmoke("Say hello in one sentence.");
```

- [ ] Confirm `accepted`, streamed `delta` events, then one `done` with text.
- [ ] Approve **Always allow** for this plain-chat request. The search request
  below must prompt again because chat alone does not authorize tools.
- [ ] In Options, type/filter by model name or ID; save and reopen Options to
  confirm the model and masked key persist. Switching providers preserves each
  provider's own model/key.
- [ ] Block `/v1/models` temporarily in extension DevTools (or go offline),
  refresh models, and confirm the saved ID remains editable with an error hint.
  Restore connectivity, enter a known ID manually, and retry chat.

## Hosted Auto search and suppression

```js
await ppqSmoke(
  "Search the web for today's top NASA news. Include source URLs and publication dates.",
  { tools: [{ type: "web_search" }] }
);
```

- [ ] Confirm approval lists **Web search (provider-hosted)**; **Deny** prevents
  the call. Repeat and **Allow once** to test a successful search.
- [ ] In extension background DevTools, inspect the request to
  `https://api.ppq.ai/chat/completions`: `tools` contains only
  `{ type: "web_search" }`, with no `plugins` or `:online` model suffix.
- [ ] Confirm PPQ consumes search server-side: final text answers the current
  question, with no page-side search function in `done.message.toolCalls`.
  Check PPQ account activity to confirm whether Auto actually searched;
  plausible text or missing tool calls alone does not prove it did.

```js
await ppqSmoke("Search the web for today's top NASA news.", {
  tools: [{ type: "web_search" }], toolChoice: "none",
});
```

- [ ] Confirm the outbound body omits `tools` and no search is billed/executed.
- [ ] Set the model to a known ID plus `:online`; confirm the request fails
  before network I/O with guidance to remove the suffix. Restore the model.
- [ ] Try a model that rejects tools/search; confirm an actionable error and no
  silent fallback to plain chat.

## Mixed function tools

```js
var ppqWeather = {
  type: "function",
  function: {
    name: "local_weather",
    description: "Get local weather observations for Austin.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};
var ppqMixed = await ppqSmoke(
  "Call local_weather for Austin, then search today's NASA news.",
  { tools: [ppqWeather, { type: "web_search" }] }
);
console.log("Page function calls", ppqMixed?.message.toolCalls);
```

- [ ] Any returned page function is `local_weather`; search remains server-side.
  Auto may answer without a function, so repeat with an explicit instruction
  if needed. To isolate ordinary function calling, run with only `ppqWeather`
  and `toolChoice: { type: "function", function: { name: "local_weather" } }`.
- [ ] Continue a returned call through the normal IPA tool-result flow below;
  confirm the selected model can finish the answer:

```js
if (ppqMixed?.message.toolCalls?.length) {
  var ppqToolResults = ppqMixed.message.toolCalls.map((call) => ({
    role: "tool", toolCallId: call.id,
    content: JSON.stringify({ city: "Austin", temperatureC: 22 }),
  }));
  for await (const chunk of window.inference.request({
    method: "chat",
    messages: [
      { role: "user", content: "Call local_weather for Austin, then search today's NASA news." },
      ppqMixed.message, ...ppqToolResults,
    ],
    tools: [ppqWeather, { type: "web_search" }],
  })) console.log(chunk.type, chunk);
}
```

## Cancellation, errors, and existing installations

- [ ] Abort a response with an `AbortController` passed as `signal`; confirm
  `aborted` and no later completion. Retry successfully afterward.
- [ ] A missing/invalid key gives a setup/authentication hint. Insufficient
  balance or a key spending limit gives a billing hint without exposing the key.
- [ ] A generic named PPQ server still disables hosted search; opting into the
  built-in provider does not rewrite existing server keys, routes, or grants.
- [ ] Firefox: revoke `https://api.ppq.ai/*` in add-on settings and confirm
  catalog/chat fail with the host-access hint. Restore access and retry.
- [ ] PPQ does not yet appear in Decisions or Speech method selectors.

Record browser, model ID, pass/fail per section, sanitized errors, and whether
PPQ activity confirmed search. Do not share Authorization headers or keys.
