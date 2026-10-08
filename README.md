# Workout Planner

A small AI workout planner on Cloudflare. You log workouts in chat and the agent stores them as structured training history, suggests your next session using progressive overload, and writes a monthly review.

Built on [`cloudflare/agents-starter`](https://github.com/cloudflare/agents-starter) with the Agents SDK and Workers AI (Llama 3.3). No third-party API keys.

## What it does

| You say                         | The agent                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `bench 60x5x5, rows 50x8x3`     | Saves each exercise (exercise, weight, sets, reps, date) to its state; the side panel updates live |
| `yesterday I did squat 100x5x5` | Same, dated yesterday                                                                              |
| `what's next?`                  | Suggests the next session from your history                                                        |
| `review my month`               | Summarizes the last 30 days: volume trend, PRs, what to push next month                            |

**Notation is `weight x sets x reps`**, in kg. For example, `rows 50x8x3` means 50 kg, 8 sets of 3 reps.

**Progressive overload rule.** One rule, the same for every exercise (double progression):

- under 12 reps last session → same weight and sets, **+1 rep**
- 12 reps reached → **+2.5 kg**, same sets, **reset to 8 reps**

Lifts not trained for more than 7 days are flagged as priorities.

## How the requirements are met

| Requirement                                                            | Where                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. LLM: Llama 3.3 on Workers AI**                                    | `MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"` in `src/server.ts`. It's the only Llama 3.3 model in the Workers AI catalog (`npx wrangler ai models`), it's available on the Workers Free plan, and it supports function calling. Called through the `AI` binding in `wrangler.jsonc`.                                                                               |
| **2. Coordination: a single Agent class, one Durable Object per user** | `WorkoutAgent extends AIChatAgent` in `src/server.ts` is the only coordinator. It receives chat messages, calls the LLM, runs the tools (`logWorkout`, `suggestNextSession`, `reviewMonth`) and updates state. There's no Workflow. The client connects with `useAgent({ agent: "WorkoutAgent", name: userId })`, so each user id maps to its own Durable Object instance. |
| **3. User input: chat UI**                                             | `src/app.tsx`: the starter's React chat UI trimmed down to a message list, input and a training-history side panel.                                                                                                                                                                                                                                                        |
| **4. Memory/state**                                                    | `initialState = { workouts: [] }` and `this.setState(...)` in `WorkoutAgent`. The Durable Object persists the state and syncs it to the browser (`onStateUpdate` fills the side panel). Chat messages are persisted too, so reopening the app restores both.                                                                                                               |

### Design notes

- **The LLM extracts and narrates; the code computes.** The progression rule and the monthly stats (volume per week, per-exercise trend, PRs, Epley e1RM) are plain TypeScript in `src/workouts.ts`. The model turns free text into a tool call and writes the reply around the numbers the tools return. This keeps the numbers correct and testable.
- **Only the latest message goes to the model.** The training history lives in state, not in the chat transcript. When Llama saw earlier turns, it sometimes re-logged old workouts. Sending one message also keeps the prompt well inside the model's 24k context.
- **Non-streamed model calls.** `workers-ai-provider@3.3.1` duplicates streamed tool-call argument chunks for Llama 3.3, which corrupts the tool input. The model is wrapped with the AI SDK's `simulateStreamingMiddleware()`, which makes a non-streamed call and replays it as a stream. (Comment in `src/server.ts`.)
- **Dates use your timezone.** The browser sends its IANA timezone with each message, so "today" and "yesterday" match your local day.

## Project structure

```
src/
  server.ts     WorkoutAgent: Durable Object, LLM call, tools, state
  workouts.ts   Pure logic: types, overload rule, monthly stats
  app.tsx       Chat UI + training-history side panel
  client.tsx    React entry
wrangler.jsonc  Worker config: AI binding, Durable Object + migrations, assets
```

## Setup (local)

Requirements: Node.js 20+ and a Cloudflare account (the Workers Free plan is enough).

```bash
npm install
npx wrangler login      # Workers AI has no local simulator; dev calls the real model
npm run dev             # http://localhost:5173
```

## Deploy

```bash
npm run deploy          # vite build && wrangler deploy
```

Wrangler prints the `*.workers.dev` URL. To watch live logs:

```bash
npx wrangler tail
```

> **Migration note:** this project started from the starter's `ChatAgent` class (migration `v1`). Migration `v2` in `wrangler.jsonc` renames it to `WorkoutAgent`, so already-deployed instances keep their data. On a brand-new deploy both migrations simply apply in order.

After changing bindings in `wrangler.jsonc`, regenerate types with `npm run types`.

## Limitations

- **No authentication.** The user id is a random UUID stored in the browser's `localStorage`. Another browser or a private window is a different user with an empty history. Real auth would put an authenticated user id into `name` instead.
- **No edit or delete of logged entries.** If the model mis-parses a log, the entry stays.
- **Weights are in kg only.**
