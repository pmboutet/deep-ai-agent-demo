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
  const requestId =
    request.headers.get("x-vercel-id") ??
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const log = (...args: unknown[]) =>
    console.log("[agent-route]", `[req:${requestId}]`, ...args);

  if (!config.deepGramApiKey) {
    log("Missing DEEPGRAM_API_KEY environment variable");
    return NextResponse.json(
      { error: "Deepgram API key is not configured." },
      { status: 500 },
    );
  }

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    log("Rejected because Upgrade header is missing or invalid", {
      upgrade: request.headers.get("upgrade"),
    });
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
  const maskedKey =
    config.deepGramApiKey.length > 10
      ? `${config.deepGramApiKey.slice(0, 5)}...${config.deepGramApiKey.slice(-4)}`
      : "<redacted>";

  log("Incoming WebSocket upgrade", {
    url: request.url,
    llmProvider,
    llmModel,
    shouldInjectExternalLlm,
  });

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
      log("Failed to augment agent request for BYO LLM", error);
      return null;
    }
  };

  type ServerWebSocket = WebSocket & { accept: () => void };
  type WebSocketResponseInit = ResponseInit & { webSocket: WebSocket };

  let WebSocketPairCtor: any = (globalThis as any).WebSocketPair;
  if (!WebSocketPairCtor) {
    try {
      const streamWeb = await import("node:stream/web");
      WebSocketPairCtor = streamWeb.WebSocketPair;
    } catch (error) {
      log("WebSocketPair is not available in this environment.", error);
      return NextResponse.json(
        { error: "WebSocketPair is not supported in this environment." },
        { status: 500 },
      );
    }
  }

  const pair = new WebSocketPairCtor();
  const [client, upstream] = Object.values(pair) as [WebSocket, ServerWebSocket];

  const deepgramSocket = new WebSocket(DEEPGRAM_AGENT_URL, [
    "bearer",
    config.deepGramApiKey,
  ]);
  deepgramSocket.binaryType = "arraybuffer";

  log("Attempting upstream connection to Deepgram", {
    endpoint: DEEPGRAM_AGENT_URL,
    apiKey: maskedKey,
  });

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
    log("Connected to Deepgram Voice Agent");
  });

  deepgramSocket.addEventListener("message", (event) => {
    try {
      if (upstream.readyState === READY_STATES.OPEN) {
        upstream.send(event.data);
      } else {
        log("Upstream (client) socket not open when forwarding message", {
          readyState: upstream.readyState,
        });
      }
    } catch (error) {
      log("Error forwarding message to client", error);
      closeUpstream(1011, "Forwarding error");
    }
  });

  deepgramSocket.addEventListener("close", (event) => {
    log("Deepgram socket closed", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
    closeClient(event.code, event.reason);
  });

  deepgramSocket.addEventListener("error", (event) => {
    log("Deepgram socket error", event);
    closeClient(1011, "Deepgram upstream error");
  });

  upstream.accept();
  log("Accepted client WebSocket");

  upstream.addEventListener("message", (event) => {
    if (deepgramSocket.readyState !== READY_STATES.OPEN) {
      log("Dropping client message because Deepgram socket not open yet", {
        readyState: deepgramSocket.readyState,
        isString: typeof event.data === "string",
        length:
          typeof event.data === "string"
            ? event.data.length
            : event.data instanceof ArrayBuffer
            ? event.data.byteLength
            : undefined,
      });
      return;
    }

    try {
      if (shouldInjectExternalLlm && typeof event.data === "string") {
        const mutated = injectExternalThinkSettings(event.data as string);
        if (mutated) {
          log("Forwarding agent-request with BYO think settings");
          deepgramSocket.send(mutated);
          return;
        }
        log("Agent-request did not require BYO modifications");
      }

      deepgramSocket.send(event.data);
    } catch (error) {
      log("Error forwarding message to Deepgram", error);
      closeClient(1011, "Forwarding error");
    }
  });

  upstream.addEventListener("close", (event) => {
    log("Client socket closed", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
    closeUpstream(event.code, event.reason);
  });

  upstream.addEventListener("error", (event) => {
    log("Client socket error", event);
    closeUpstream(1011, "Client error");
  });

  const responseInit: WebSocketResponseInit = {
    status: 101,
    webSocket: client,
  };

  log("Handshake complete, returning 101 Switching Protocols");
  return new Response(null, responseInit);
}
