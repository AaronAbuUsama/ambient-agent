# GPT-5.6 Luna, subscription transport, and tool-call completion

Research date: 2026-07-13

## Verdict

`gpt-5.6-luna` is a real, generally available OpenAI model. The earlier conclusion
that Eve's `404 Model not found gpt-5.6-luna` meant Luna was unavailable was
incorrect. OpenAI's model catalog gives the exact ID `gpt-5.6-luna`, and OpenAI's
launch announcement says Luna is available through both Codex and the OpenAI API.

The 404 is evidence about one integration path only: Eve 0.22.5's experimental
ChatGPT-subscription adapter. It is not evidence that the model ID is invalid.

`<eve-empty-delivery/>` is not an OpenAI protocol token, but it **is** an Eve
0.22.5 harness sentinel. Commit `81e1e37` did not invent the token; it applied
Eve's existing mechanism to this repository's conditional WhatsApp delivery
contract. The root cause of the Luna 404 is separate from that completion marker.

## The actual model card

OpenAI's current model catalog describes GPT-5.6 Luna as the cost-sensitive,
high-volume member of the GPT-5.6 family and records:

- Model ID: `gpt-5.6-luna`
- Reasoning efforts: `none`, `low`, `medium`, `high`, `xhigh`, `max`
- Context window: 1.05M tokens
- Maximum output: 128K tokens
- Knowledge cutoff: 2026-02-16
- Tool support: function calling, web search, file search, and computer use
- Input: text and images; output: text

Sources: [OpenAI model catalog](https://developers.openai.com/api/docs/models),
[Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna), and
[GPT-5.6 System Card](https://deploymentsafety.openai.com/gpt-5-6).

The Luna model page explicitly lists both `v1/responses` and
`v1/chat/completions`, with streaming and function calling supported. OpenAI's
2026-07-09 launch announcement calls Luna the fastest and most affordable tier
and says Plus, Pro, Business, and Enterprise users can select it in Codex.
Source: [GPT-5.6 launch announcement](https://openai.com/index/gpt-5-6/).

The local Codex model catalog agrees on the identity and low-reasoning support.
At `2026-07-13T10:19:37.800071Z`,
[`~/.codex/models_cache.json`](/Users/abuusama/.codex/models_cache.json) contained:

```json
{
  "slug": "gpt-5.6-luna",
  "display_name": "GPT-5.6-Luna",
  "description": "Fast and affordable agentic coding model.",
  "default_reasoning_level": "medium",
  "supported_in_api": true,
  "use_responses_lite": true,
  "tool_mode": "code_mode_only",
  "context_window": 272000
}
```

The local Codex product metadata advertises a 272K window while the public API
model card advertises 1.05M. That is a product/transport configuration
difference; the public card should not be overwritten with the local effective
Codex setting.

## Live subscription proof

With `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` removed from the process environment,
the installed Codex CLI reported `Logged in using ChatGPT` and this command
succeeded:

```sh
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  codex exec --ephemeral --skip-git-repo-check \
  -m gpt-5.6-luna \
  -c 'model_reasoning_effort="low"' \
  'Reply with exactly: OK'
```

Observed result on Codex CLI 0.144.1:

```text
model: gpt-5.6-luna
provider: openai
reasoning effort: low
codex
OK
```

This proves that this machine's ChatGPT subscription can run Luna through the
official Codex client. It does not prove that every third-party adapter can make
the same internal request.

## Why Eve's 404 is a transport problem

The application selects Eve's subscription adapter in
[`src/model/subscription.ts`](../../src/model/subscription.ts). That code verifies
`auth_mode === "chatgpt"`, requires an OAuth access or refresh token, and then
calls `experimental_chatgpt(slug)`.

The installed Eve 0.22.5 source shows that `experimental_chatgpt()` accepts an
OpenAI slug and defaults to `gpt-5.6-sol`. Its transport does **not** call the
public `https://api.openai.com/v1/responses` endpoint unchanged. It rewrites
Responses or Chat Completions requests to:

```text
https://chatgpt.com/backend-api/codex/responses
```

It authenticates with the local Codex OAuth token, adds the ChatGPT account ID,
and sets `originator: eve`. The authoritative installed sources are:

- [`experimental_chatgpt`](../../node_modules/eve/dist/src/public/models/openai/index.js)
- [Eve ChatGPT transport](../../node_modules/eve/dist/src/public/models/openai/chatgpt/transport.js)

Therefore:

```text
official Codex client + ChatGPT OAuth + Luna low        -> succeeds
Eve experimental adapter + ChatGPT OAuth + Luna low     -> 404 observed
public OpenAI model catalog                              -> Luna exists and supports Responses
```

The exact mismatch was isolated after the initial research pass. Luna's local
model metadata says `use_responses_lite: true`. The official Codex client sends
that contract by:

- adding `x-openai-internal-codex-responses-lite: true`;
- moving the tool declarations into a leading `additional_tools` developer
  input item;
- moving top-level instructions into a developer message;
- omitting top-level `tools` and `instructions`;
- setting reasoning context to `all_turns` and disabling parallel tool calls;
- identifying a sufficiently recent Codex client (`0.144.1` works; `0.143.0`
  is rejected as too old).

Eve 0.22.5's adapter sends the ordinary Responses shape and identifies itself
as `originator: eve`. A captured ordinary Eve call returned 404. The equivalent
Responses Lite request with the current Codex client identity returned `OK`
through the same ChatGPT OAuth subscription endpoint. This is an adapter wire
contract bug, not a retry problem and not an unavailable model.

Primary implementation reference: [OpenAI Codex Responses client](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs).

## What is supposed to happen after a tool call

OpenAI documents tool calling as a five-step loop:

1. The application sends the model the available tools.
2. The model emits a tool call.
3. The application executes the tool.
4. The application sends the tool result back as `function_call_output`.
5. The model emits a final response **or more tool calls**.

Source: [OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling).

For a side-effect-only tool such as sending a message, OpenAI specifically says
the function output should still be a string indicating success or failure. The
application then submits that result to the model and receives the final model
response. The final response is a model/API event; the application remains in
control of whether that text is shown to any user.

Applied to this repository, the normal sequence is:

```text
model emits say({ text })
        -> gateway records/sends the WhatsApp message
        -> tool result reports success
        -> model either calls another tool or emits a terminal private response
        -> Eve marks the turn complete
```

The WhatsApp message and the terminal model response are two different things.
The gateway is correct to deliver only harvested `say` calls. OpenAI documents a
further model response after the tool output; it does not document an empty
assistant body as a “silent delivery” primitive. Whether an empty terminal
generation is accepted is a wrapper-specific question. The observed Eve stack
rejected it, but that behavior should not be attributed to the Luna model card.

## What `<eve-empty-delivery/>` actually is

Eve 0.22.5 contains the marker and recognizes it in both the tool loop and event
emission:

- [`shared/empty-delivery.js`](../../node_modules/eve/dist/src/shared/empty-delivery.js)
- [`harness/tool-loop.js`](../../node_modules/eve/dist/src/harness/tool-loop.js)
- [`harness/emission.js`](../../node_modules/eve/dist/src/harness/emission.js)

When a terminal assistant message contains the sentinel, Eve completes the turn
without emitting it as a delivered assistant message. Eve also uses it in its
conditional-delivery recovery prompt. It is therefore accurate to call it an
Eve no-delivery marker, though it remains an Eve convention rather than an
OpenAI model/API primitive.

The observed empty-response retry was Eve's defensive recovery after a model
returned no terminal response. It was not the solution to the Luna 404. With the
Responses Lite adapter fixed, a live Luna tool round-trip produced a `say` call,
accepted the tool result, emitted a terminal response, and completed without a
`turn.failed` event or recovery retry.

## “Chiyogi”

No public first-party OpenAI model page, GPT-5.6 launch material, system card, or
local Codex model-catalog entry located in this research maps the name
`Chiyogi` to GPT-5.6 Luna. The verified public/product identifier is
`gpt-5.6-luna`. Without an authoritative internal source, a Chiyogi-to-Luna
relationship should not be asserted or denied as fact.
