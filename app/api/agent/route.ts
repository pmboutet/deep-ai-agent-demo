import { config } from "@/app/config";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const DEEPGRAM_AGENT_URL = "wss://agent.deepgram.com/v1/listen";
const BYO_DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  claude: "claude-3-haiku-20240307",
};

const READY_STATES = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export async function GET(request: NextRequest) {
  if (!config.deepGramApiKey) {
    return NextResponse.json(
      { error: "Deepgram API key is not configured." },
      { status: 500 },
    );
  }

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return NextResponse.json(
      { error: "Expected a WebSocket upgrade request." },
      { status: 400 },
    );
  }

  const llmProvider = config.llmProvider?.toLowerCase();
  const llmApiKey = config.llmApiKey;
  const llmModel =
    config.llmModel ||
    (llmProvider ? BYO_DEFAULT_MODELS[llmProvider] : undefined);
  const shouldInjectExternalLlm = Boolean(llmProvider && llmApiKey);

  const injectExternalThinkSettings = (message: string): string | null => {
    if (!shouldInjectExternalLlm) {
      return null;
    }

    try {
      const parsed = JSON.parse(message);
      if ((parsed?.type ?? "").toLowerCase() !== "agent-request") {
        return null;
      }

      const agent = parsed.agent ?? {};
      const existingInstructions = agent.instructions;
      const thinkConfig: Record<string, unknown> = {
        provider: {
          type: llmProvider,
          ...(llmModel ? { model: llmModel } : {}),
        },
        auth: {
          type: "api_key",
          value: llmApiKey,
        },
      };

      parsed.agent = {
        ...agent,
        instructions: existingInstructions,
        think: thinkConfig,
      };

      return JSON.stringify(parsed);
    } catch (error) {
      console.error("Failed to augment agent request for BYO LLM", error);
      return null;
    }
  };

  type ServerWebSocket = WebSocket & { accept: () => void };
  type WebSocketResponseInit = ResponseInit & { webSocket: WebSocket };

  if (!(globalThis as any).WebSocketPair) {
    return NextResponse.json(
      { error: "WebSocketPair is not supported in this environment." },
      { status: 500 },
    );
  }

  const pair = new (globalThis as any).WebSocketPair();
  const [client, upstream] = Object.values(pair) as [WebSocket, ServerWebSocket];

  const deepgramSocket = new WebSocket(DEEPGRAM_AGENT_URL, [
    "bearer",
    config.deepGramApiKey,
  ]);
  deepgramSocket.binaryType = "arraybuffer";

  const closeUpstream = (code = 1011, reason?: string) => {
    try {
      if (
        deepgramSocket.readyState === READY_STATES.OPEN ||
        deepgramSocket.readyState === READY_STATES.CONNECTING
      ) {
        deepgramSocket.close(code, reason);
      }
    } catch (error) {
      console.error("Failed to close Deepgram socket", error);
    }
  };

  const closeClient = (code = 1011, reason?: string) => {
    try {
      if (
        upstream.readyState === READY_STATES.OPEN ||
        upstream.readyState === READY_STATES.CONNECTING
      ) {
        upstream.close(code, reason);
      }
    } catch (error) {
      console.error("Failed to close client socket", error);
    }
  };

  deepgramSocket.addEventListener("open", () => {
    console.log("Connected to Deepgram Voice Agent.");
  });

  deepgramSocket.addEventListener("message", (event) => {
    try {
      if (upstream.readyState === READY_STATES.OPEN) {
        upstream.send(event.data);
      }
    } catch (error) {
      console.error("Error forwarding message to client", error);
      closeUpstream(1011, "Forwarding error");
    }
  });

  deepgramSocket.addEventListener("close", (event) => {
    closeClient(event.code, event.reason);
  });

  deepgramSocket.addEventListener("error", (event) => {
    console.error("Deepgram socket error", event);
    closeClient(1011, "Deepgram upstream error");
  });

  upstream.accept();

  upstream.addEventListener("message", (event) => {
    if (deepgramSocket.readyState !== READY_STATES.OPEN) {
      return;
    }

    try {
      if (shouldInjectExternalLlm && typeof event.data === "string") {
        const mutated = injectExternalThinkSettings(event.data as string);
        if (mutated) {
          deepgramSocket.send(mutated);
          return;
        }
      }

      deepgramSocket.send(event.data);
    } catch (error) {
      console.error("Error forwarding message to Deepgram", error);
      closeClient(1011, "Forwarding error");
    }
  });

  upstream.addEventListener("close", (event) => {
    closeUpstream(event.code, event.reason);
  });

  upstream.addEventListener("error", (event) => {
    console.error("Client socket error", event);
    closeUpstream(1011, "Client error");
  });

  const responseInit: WebSocketResponseInit = {
    status: 101,
    webSocket: client,
  };

  return new Response(null, responseInit);
}
