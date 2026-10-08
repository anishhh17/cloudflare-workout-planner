import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { WorkoutAgent } from "./server";
import type { WorkoutEntry, WorkoutState } from "./workouts";
import {
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Text
} from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  BarbellIcon,
  CircleIcon,
  CheckCircleIcon,
  XCircleIcon,
  GearIcon
} from "@phosphor-icons/react";

// One Durable Object per user: a random id kept in this browser picks the
// agent instance, so reopening the page reconnects to the same history.
function getUserId(): string {
  try {
    let id = localStorage.getItem("workout-user-id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("workout-user-id", id);
    }
    return id;
  } catch {
    return "anonymous";
  }
}

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const TOOL_LABELS: Record<string, string> = {
  logWorkout: "Logged workout",
  suggestNextSession: "Planned next session",
  reviewMonth: "Reviewed last 30 days"
};

function ToolLine({ part }: { part: UIMessage["parts"][number] }) {
  if (!isToolUIPart(part)) return null;
  const label = TOOL_LABELS[getToolName(part)] ?? getToolName(part);
  const icon =
    part.state === "output-available" ? (
      <CheckCircleIcon size={14} className="text-kumo-success" />
    ) : part.state === "output-error" ? (
      <XCircleIcon size={14} className="text-kumo-danger" />
    ) : (
      <GearIcon size={14} className="text-kumo-inactive animate-spin" />
    );
  return (
    <div className="flex items-center gap-2 text-xs text-kumo-subtle">
      {icon}
      {part.state === "output-error"
        ? `${label} failed: ${part.errorText ?? "unknown error"}`
        : label}
    </div>
  );
}

// ── Side panel: training history from agent state ────────────────────

function HistoryPanel({ workouts }: { workouts: WorkoutEntry[] }) {
  const byDate = new Map<string, WorkoutEntry[]>();
  for (const w of workouts)
    byDate.set(w.date, [...(byDate.get(w.date) ?? []), w]);
  const dates = [...byDate.keys()].sort().reverse();

  return (
    <aside className="md:w-80 shrink-0 border-t md:border-t-0 md:border-l border-kumo-line bg-kumo-base overflow-y-auto max-h-[40vh] md:max-h-none">
      <div className="px-4 py-3 border-b border-kumo-line">
        <Text size="sm" bold>
          Training history
        </Text>
      </div>
      {dates.length === 0 ? (
        <div className="p-4">
          <Text size="xs" variant="secondary">
            Nothing logged yet. Try “bench 60x5x5, rows 50x8x3”.
          </Text>
        </div>
      ) : (
        <div className="p-4 space-y-4">
          {dates.map((date) => (
            <div key={date}>
              <Text size="xs" variant="secondary" bold>
                {date}
              </Text>
              <ul className="mt-1 space-y-1">
                {byDate.get(date)!.map((w) => (
                  <li
                    key={w.id}
                    className="flex justify-between text-sm text-kumo-default"
                  >
                    <span className="capitalize">{w.exercise}</span>
                    <span className="font-mono text-kumo-subtle">
                      {w.weight} kg · {w.sets}×{w.reps}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

// ── Main chat ─────────────────────────────────────────────────────────

const EXAMPLES = [
  "bench 60x5x5, rows 50x8x3",
  "What's next?",
  "Review my month"
];

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [workouts, setWorkouts] = useState<WorkoutEntry[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agent = useAgent<WorkoutAgent, WorkoutState>({
    agent: "WorkoutAgent",
    name: getUserId(),
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onStateUpdate: useCallback(
      (state: WorkoutState) => setWorkouts(state.workouts ?? []),
      []
    )
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus();
  }, [isStreaming]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;
      setInput("");
      // The timezone lets the agent date entries in the user's local day.
      sendMessage(
        { role: "user", parts: [{ type: "text", text: trimmed }] },
        { body: { timezone } }
      );
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    },
    [isStreaming, sendMessage]
  );

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-kumo-default flex items-center gap-2">
            <BarbellIcon size={20} />
            Workout Planner
          </h1>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear chat
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row min-h-0">
        <main className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
              {messages.length === 0 && (
                <Empty
                  icon={<BarbellIcon size={32} />}
                  title="Log a workout or ask what's next"
                  contents={
                    <div className="flex flex-wrap justify-center gap-2">
                      {EXAMPLES.map((prompt) => (
                        <Button
                          key={prompt}
                          variant="outline"
                          size="sm"
                          disabled={isStreaming || !connected}
                          onClick={() => send(prompt)}
                        >
                          {prompt}
                        </Button>
                      ))}
                    </div>
                  }
                />
              )}

              {messages.map((message: UIMessage, index: number) => {
                const isUser = message.role === "user";
                const isLastAssistant =
                  message.role === "assistant" && index === messages.length - 1;

                return (
                  <div key={message.id} className="space-y-2">
                    {message.parts.map((part, i) => {
                      const key = `${message.id}-${i}`;

                      if (isToolUIPart(part)) {
                        return <ToolLine key={key} part={part} />;
                      }

                      if (part.type !== "text" || !part.text) return null;

                      if (isUser) {
                        return (
                          <div key={key} className="flex justify-end">
                            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                              {part.text}
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={key} className="flex justify-start">
                          <Surface className="max-w-[85%] rounded-2xl rounded-bl-md text-kumo-default leading-relaxed">
                            <Streamdown
                              className="sd-theme p-3"
                              controls={false}
                              isAnimating={isLastAssistant && isStreaming}
                            >
                              {part.text}
                            </Streamdown>
                          </Surface>
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="border-t border-kumo-line bg-kumo-base">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="max-w-3xl mx-auto px-5 py-4"
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
                <InputArea
                  ref={textareaRef}
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                  placeholder="bench 60x5x5 (weight × sets × reps), or “what's next?”"
                  disabled={!connected || isStreaming}
                  rows={1}
                  className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop generation"
                    icon={<StopIcon size={18} />}
                    onClick={stop}
                    className="mb-0.5"
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send message"
                    disabled={!input.trim() || !connected}
                    icon={<PaperPlaneRightIcon size={18} />}
                    className="mb-0.5"
                  />
                )}
              </div>
            </form>
            <div className="flex justify-center pb-3">
              <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
            </div>
          </div>
        </main>

        <HistoryPanel workouts={workouts} />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Chat />
    </Suspense>
  );
}
