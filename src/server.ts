import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  simulateStreamingMiddleware,
  stepCountIs,
  streamText,
  tool,
  wrapLanguageModel
} from "ai";
import { z } from "zod";
import {
  localDate,
  normalizeExercise,
  suggestNext,
  summarizeMonth,
  type WorkoutEntry,
  type WorkoutState
} from "./workouts";

// Requirement 1 — LLM: Llama 3.3 on Workers AI (free-tier model from the account catalog).
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Requirement 2 — Coordination: the single Agent class (one Durable Object per
 * user, addressed by name from the client). It owns the chat, the tools and
 * the training history; there is no separate Workflow.
 *
 * Requirement 4 — Memory/state: training history lives in the agent's state
 * (`initialState` / `this.setState`). The Durable Object persists it and syncs
 * it to connected clients, so reopening the app restores everything.
 */
export class WorkoutAgent extends AIChatAgent<Env, WorkoutState> {
  initialState: WorkoutState = { workouts: [] };
  maxPersistedMessages = 100;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const timezone = options?.body?.timezone as string | undefined;
    const today = localDate(timezone);
    const known = [...new Set(this.state.workouts.map((w) => w.exercise))];
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      // workers-ai-provider 3.3.1 duplicates every streamed tool-argument delta
      // for Llama 3.3, which corrupts tool input JSON. Generate non-streamed
      // (complete tool calls) and replay the result as a stream instead.
      model: wrapLanguageModel({
        model: workersai(MODEL),
        middleware: simulateStreamingMiddleware()
      }),
      maxOutputTokens: 1024,
      system: `You are a concise strength-training coach inside a workout log app.
Today is ${today}. Weights are in kg.

Logging format is WEIGHT x SETS x REPS (weight first, then sets, then reps):
- "bench 60x5x5" = bench press, 60 kg, 5 sets, 5 reps
- "rows 50x8x3" = barbell row, 50 kg, 8 sets, 3 reps
Dates like "yesterday" or "on monday" are relative to today; use YYYY-MM-DD.
Exercises already logged: ${known.length ? known.join(", ") : "none yet"}. Reuse these exact names for the same lift.

Tools:
- logWorkout: ONLY when the user reports sets they did. Log every exercise in one call, then confirm in one short sentence what was saved.
- suggestNextSession: when the user asks for their next session, e.g. "what's next", "what's next?", "next workout", "what should I do today", "plan my next session". Present each exercise's "next" exactly as returned (do not change the numbers). Mention only the lifts listed in "priorities", if any.
- reviewMonth: when the user asks for a review, e.g. "review my month", "how was my month", "monthly summary". Write a short summary: volume trend across weeks, the PRs listed in "prs" (if the list is empty, say there are no PRs yet), and 2-3 things to push next month. Use only the facts returned.
For greetings or general questions, answer directly without calling a tool.`,
      // Only the latest user message goes to the model. Training history lives
      // in agent state (read by the tools), and replaying earlier turns made
      // Llama re-log old workouts and echo past tool calls. It also keeps the
      // prompt well inside the model's 24k context window.
      messages: await convertToModelMessages(this.messages.slice(-1)),
      tools: {
        logWorkout: tool({
          description:
            "Save one or more performed exercises to the user's training history.",
          inputSchema: z.object({
            entries: z.array(
              z.object({
                exercise: z
                  .string()
                  .describe("Exercise name, e.g. bench press"),
                weight: z.number().describe("Weight in kg (0 for bodyweight)"),
                sets: z.number().int().positive().describe("Number of sets"),
                reps: z.number().int().positive().describe("Reps per set"),
                date: z
                  .string()
                  .optional()
                  .describe("YYYY-MM-DD; omit for today")
              })
            )
          }),
          execute: async ({ entries }) => {
            const saved: WorkoutEntry[] = entries.map((e) => ({
              id: crypto.randomUUID(),
              // Accept only well-formed, non-future dates; default to today.
              date:
                e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date <= today
                  ? e.date
                  : today,
              exercise: normalizeExercise(e.exercise),
              weight: e.weight,
              sets: e.sets,
              reps: e.reps
            }));
            this.setState({ workouts: [...this.state.workouts, ...saved] });
            return { saved };
          }
        }),

        suggestNextSession: tool({
          description:
            "Get the next session's prescription for every exercise using progressive overload on the user's history.",
          inputSchema: z.object({}),
          execute: async () => {
            const next = suggestNext(this.state.workouts, today);
            return next.plan.length ? next : "No workouts logged yet.";
          }
        }),

        reviewMonth: tool({
          description:
            "Get volume trends, PRs and per-exercise stats for the last 30 days.",
          inputSchema: z.object({}),
          execute: async () => summarizeMonth(this.state.workouts, today)
        })
      },
      // One tool call per turn is enough; after it, force a text answer
      // (Llama otherwise sometimes ends the turn with an empty reply).
      prepareStep: ({ stepNumber }) =>
        stepNumber > 0 ? { toolChoice: "none" } : {},
      stopWhen: stepCountIs(3),
      abortSignal: options?.abortSignal
    });

    // Surface real error messages (the default is a generic "An error occurred.").
    return result.toUIMessageStreamResponse({
      onError: (error) => {
        console.error("chat error:", error);
        return error instanceof Error ? error.message : String(error);
      }
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
