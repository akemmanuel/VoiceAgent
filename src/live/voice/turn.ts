/**
 * One agent turn: the transcript goes in, a spoken reply comes out, and browser
 * tools are executed in between when the model asks for them.
 *
 * Dependencies are injected so the tool loop can be tested without a network or a
 * browser. The loop is bounded because a model that keeps calling tools would
 * otherwise talk to itself forever on the user's credit.
 */

import type { ChatMessage, ChatResult, ToolDefinition } from "../openrouter/client";

/** How many model round-trips one user utterance may cost. */
export const DEFAULT_MAX_TOOL_STEPS = 6;

/**
 * The conversation prompt for the chained engine. GPT-Live does its own delegation
 * prompting; this engine has to be told explicitly that it can act on the browser.
 */
export function systemMessage(tools: ToolDefinition[]): ChatMessage {
  const names = tools.map(tool => tool.name).join(", ");
  return {
    role: "system",
    content: [
      "You are a voice assistant inside a browser extension. Your reply is read aloud, so keep it to one or two short sentences, use plain words, and never use markdown, lists, or code.",
      tools.length
        ? `You can act on the user's browser with these tools: ${names}. Call a tool when the request needs the page, and wait for its result before answering. Do not claim you did something the tools did not confirm. For downloads, decide from the request: complete a clearly defined recurring collection or requested folder structure yourself, but first inspect and summarise files when scope, relevance, or the target structure is unclear. Never use a download as a substitute for asking what to do with ambiguous documents.`
        : "You cannot act on the browser in this session. If a request needs the page, say so briefly.",
    ].join(" "),
  };
}

export type TurnDependencies = {
  /** One model round-trip. */
  chat: (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<ChatResult>;
  /** Runs one browser tool and returns its text result. */
  executeTool: (name: string, args: string) => Promise<string>;
  maxSteps?: number;
};

export type TurnResult = {
  history: ChatMessage[];
  reply: string;
  toolCallCount: number;
  /** True when the model was still asking for tools at the step limit. */
  truncated: boolean;
};

/**
 * Arguments arrive as a JSON string from the model and are not guaranteed to parse.
 * The tool is still called so it can report the problem in the transcript.
 */
export function parseToolArguments(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runTurn(
  dependencies: TurnDependencies,
  history: ChatMessage[],
  transcript: string,
  tools: ToolDefinition[],
): Promise<TurnResult> {
  const { chat, executeTool, maxSteps = DEFAULT_MAX_TOOL_STEPS } = dependencies;
  const messages: ChatMessage[] = [...history, { role: "user", content: transcript }];
  let toolCallCount = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    const result = await chat(messages, tools);

    if (result.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: result.content });
      return { history: messages, reply: result.content, toolCallCount, truncated: false };
    }

    // The assistant turn that requested the tools must precede their results.
    messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      toolCallCount += 1;
      let content: string;
      try {
        content = await executeTool(call.name, call.arguments);
      } catch (cause) {
        // A failed tool is reported back to the model rather than ending the turn,
        // because the model can usually apologise or try something else.
        content = cause instanceof Error ? `The tool failed: ${cause.message}` : "The tool failed.";
      }
      messages.push({ role: "tool", content, toolCallId: call.id });
    }
  }

  return { history: messages, reply: "", toolCallCount, truncated: true };
}
