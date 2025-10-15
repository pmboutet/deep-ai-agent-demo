"use client";
import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";
import { systemContent } from "../lib/constants";

type Role = "user" | "model";

export type Message = {
  id: string;
  role: Role;
  content: string;
  audio?: ArrayBuffer;
  voice?: string;
};

type Speaker = "user" | "user-waiting" | "model" | null;

interface WebSocketContextValue {
  readyState: ReadyState;
  connection: boolean;
  voice: string;
  currentSpeaker: Speaker;
  microphoneOpen: boolean;
  chatMessages: Message[];
  sendMessage: (message: ArrayBuffer | string | Blob) => void;
  startStreaming: () => Promise<void>;
  stopStreaming: () => void;
  setVoice: (voice: string) => void;
  replayAudio: (audioData: ArrayBuffer) => (() => void) | undefined;
}

type WebSocketProviderProps = { children: ReactNode };

const DEFAULT_VOICE = "aura-asteria-en";
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

const concatArrayBuffers = (buffer1: ArrayBuffer, buffer2: ArrayBuffer) => {
  const tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp.buffer;
};

const decodeBase64 = (value: string): ArrayBuffer | null => {
  try {
    const binary = atob(value.replace(/\s/g, ""));
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } catch (error) {
    console.error("Failed to decode base64 audio chunk", error);
    return null;
  }
};

const parseSpeaker = (payload: any): Speaker => {
  const speaker =
    payload?.speaker ||
    payload?.role ||
    payload?.participant ||
    payload?.metadata?.speaker ||
    payload?.source;
  if (!speaker) return null;
  const normalised = String(speaker).toLowerCase();
  if (["user", "customer", "caller"].includes(normalised)) return "user";
  if (
    ["assistant", "agent", "ai", "model", "bot", "system"].includes(normalised)
  )
    return "model";
  return null;
};

const extractTranscriptText = (payload: any): string | null => {
  if (!payload) return null;
  if (typeof payload.transcript === "string") return payload.transcript;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.content === "string") return payload.content;
  const alternative =
    payload.channel?.alternatives?.[0] ||
    payload.alternatives?.[0] ||
    payload.results?.alternatives?.[0];
  if (alternative?.transcript) return alternative.transcript;
  if (Array.isArray(payload.words)) {
    return payload.words.map((w: any) => w?.word).filter(Boolean).join(" ");
  }
  return null;
};

const isFinalTranscript = (payload: any): boolean => {
  if (!payload) return false;
  if (payload.is_final || payload.final) return true;
  if (payload.type === "final_transcript") return true;
  if (payload.channel?.alternatives?.[0]?.confidence) {
    return payload.channel.alternatives[0].confidence > 0;
  }
  return false;
};

const extractResponses = (payload: any): any[] => {
  if (!payload) return [];
  if (Array.isArray(payload.responses)) return payload.responses;
  if (Array.isArray(payload.response?.outputs)) return payload.response.outputs;
  if (Array.isArray(payload.output)) return payload.output;
  if (Array.isArray(payload.outputs)) return payload.outputs;
  if (payload.response) return [payload.response];
  return [];
};

const textFromResponse = (response: any): string | null => {
  if (!response) return null;
  if (typeof response.text === "string") return response.text;
  if (typeof response.content === "string") return response.content;
  if (typeof response.value === "string") return response.value;
  if (Array.isArray(response.messages)) {
    return response.messages
      .map((item: any) => item?.content || item?.text)
      .filter(Boolean)
      .join(" ");
  }
  if (Array.isArray(response.texts)) {
    return response.texts.filter(Boolean).join(" ");
  }
  return null;
};

const audioFromResponse = (response: any): ArrayBuffer | null => {
  if (!response) return null;
  const audio =
    response.audio ??
    response.data ??
    response.payload?.audio ??
    response.payload?.data ??
    response.value;

  if (!audio) return null;
  if (audio instanceof ArrayBuffer) return audio;
  if (audio instanceof Uint8Array) return audio.buffer;
  if (typeof audio === "string") return decodeBase64(audio);
  if (Array.isArray(audio)) return new Uint8Array(audio).buffer;
  if (audio.type === "Buffer" && Array.isArray(audio.data)) {
    return new Uint8Array(audio.data).buffer;
  }
  return null;
};

const responseIsComplete = (response: any): boolean => {
  if (!response) return false;
  if (response.type === "completed" || response.type === "done") return true;
  if (response.status) {
    return ["completed", "complete", "finished", "done"].includes(
      String(response.status).toLowerCase(),
    );
  }
  if (response.completion_reason) return true;
  if (response.done === true) return true;
  return false;
};

const buildAgentRequestPayload = (voice: string) => {
  const payload: Record<string, unknown> = {
    type: "agent-request",
    agent: {
      model: voice,
      instructions: systemContent.trim(),
    },
    conversation: {
      metadata: {
        application: "deepgram-ai-agent-demo",
      },
    },
    audio: {
      format: "linear16",
      sample_rate: OUTPUT_SAMPLE_RATE,
    },
  };

  return payload;
};

const WebSocketContext = createContext<WebSocketContextValue | undefined>(
  undefined,
);

export const WebSocketProvider = ({ children }: WebSocketProviderProps) => {
  const [connection, setConnection] = useState(false);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [currentSpeaker, setCurrentSpeaker] = useState<Speaker>(null);
  const [microphoneOpen, setMicrophoneOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const microphoneRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scheduledAudioSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const scheduledStartRef = useRef(0);
  const incomingMessageRef = useRef<Message | null>(null);

  const socketURL = useMemo(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}/api/agent`;
  }, []);

  const agentRequest = useMemo(
    () => buildAgentRequestPayload(voice),
    [voice],
  );

  const ensureIncomingMessage = useCallback((): Message => {
    if (incomingMessageRef.current) {
      return incomingMessageRef.current;
    }

    const message: Message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "model",
      content: "",
      voice,
    };
    incomingMessageRef.current = message;
    setChatMessages((prev) => [...prev, message]);
    return message;
  }, [voice]);

  const updateIncomingMessage = useCallback((updates: Partial<Message>) => {
    if (!incomingMessageRef.current) {
      ensureIncomingMessage();
    }
    if (!incomingMessageRef.current) return;

    const updated: Message = {
      ...incomingMessageRef.current,
      ...updates,
    };

    incomingMessageRef.current = updated;
    setChatMessages((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)),
    );
  }, [ensureIncomingMessage]);

  const finalizeIncomingMessage = useCallback(() => {
    if (!incomingMessageRef.current) return;
    setChatMessages((prev) =>
      prev.map((item) =>
        item.id === incomingMessageRef.current?.id
          ? { ...incomingMessageRef.current! }
          : item,
      ),
    );
    incomingMessageRef.current = null;
    setCurrentSpeaker("user-waiting");
  }, []);

  const clearScheduledAudio = useCallback(() => {
    scheduledAudioSourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // ignore
      }
      source.onended = null;
    });
    scheduledAudioSourcesRef.current = [];
    scheduledStartRef.current = 0;
  }, []);

  const playAudio = useCallback(
    (audioData: ArrayBuffer) => {
      const audioContext = audioContextRef.current;
      if (!audioContext) return;

      const audioDataView = new Int16Array(audioData);
      if (!audioDataView.length) {
        return;
      }

      const audioBuffer = audioContext.createBuffer(
        1,
        audioDataView.length,
        OUTPUT_SAMPLE_RATE,
      );
      const audioBufferChannel = audioBuffer.getChannelData(0);
      for (let i = 0; i < audioDataView.length; i++) {
        audioBufferChannel[i] = audioDataView[i] / 32768;
      }

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);

      const currentTime = audioContext.currentTime;
      if (scheduledStartRef.current < currentTime) {
        scheduledStartRef.current = currentTime;
      }
      const startTime = scheduledStartRef.current;
      source.start(startTime);

      scheduledStartRef.current = startTime + audioBuffer.duration;
      scheduledAudioSourcesRef.current.push(source);
    },
    [],
  );

  const replayAudio = useCallback((audioData: ArrayBuffer) => {
    const audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const audioDataView = new Int16Array(audioData);

    if (!audioDataView.length) {
      audioContext.close().catch(console.error);
      return;
    }

    const buffer = audioContext.createBuffer(
      1,
      audioDataView.length,
      OUTPUT_SAMPLE_RATE,
    );
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < audioDataView.length; i++) {
      channel[i] = audioDataView[i] / 32768;
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.onended = () => {
      source.disconnect();
      audioContext.close().catch(console.error);
    };
    source.start();

    return () => {
      try {
        source.stop();
      } catch {
        // ignore
      }
      source.disconnect();
      audioContext.close().catch(console.error);
    };
  }, []);

  const handleTranscriptMessage = useCallback(
    (payload: any) => {
      const text = extractTranscriptText(payload);
      if (!text) return;

      const speaker = parseSpeaker(payload) ?? "user";
      const isFinal = isFinalTranscript(payload);

      if (speaker === "user" && isFinal) {
        setCurrentSpeaker("user");
        clearScheduledAudio();
        incomingMessageRef.current = null;
        setChatMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: "user",
            content: text,
          },
        ]);
      } else if (speaker === "model") {
        ensureIncomingMessage();
        const existing = incomingMessageRef.current?.content ?? "";
        const combined = existing
          ? `${existing} ${text}`.replace(/\s+/g, " ").trim()
          : text;
        updateIncomingMessage({
          content: combined,
        });
      }
    },
    [clearScheduledAudio, ensureIncomingMessage, updateIncomingMessage],
  );

  const handleAgentResponse = useCallback(
    (payload: any) => {
      const responses = extractResponses(payload);
      if (!responses.length) return;

      responses.forEach((response) => {
        if (!response) {
          return;
        }

        const responseType = String(response.type ?? response.kind ?? "").toLowerCase();

        if (responseType.includes("text") || responseType === "message") {
          const text = textFromResponse(response);
          if (text) {
            setCurrentSpeaker("model");
            ensureIncomingMessage();
            const existing = incomingMessageRef.current?.content;
            updateIncomingMessage({
              content: existing ? `${existing} ${text}`.trim() : text,
            });
          }
        }

        const audioBuffer = audioFromResponse(response);
        if (audioBuffer) {
          setCurrentSpeaker("model");
          ensureIncomingMessage();
          const incoming = incomingMessageRef.current;
          const combinedAudio = incoming?.audio
            ? concatArrayBuffers(incoming.audio, audioBuffer)
            : audioBuffer;
          updateIncomingMessage({
            audio: combinedAudio,
          });
          playAudio(audioBuffer);
        }

        if (responseIsComplete(response)) {
          finalizeIncomingMessage();
        }
      });

      if (responseIsComplete(payload)) {
        finalizeIncomingMessage();
      }
    },
    [
      ensureIncomingMessage,
      finalizeIncomingMessage,
      playAudio,
      updateIncomingMessage,
    ],
  );

  const handleUpstreamMessage = useCallback(
    (event: MessageEvent) => {
      if (typeof event.data === "string") {
        try {
          const payload = JSON.parse(event.data);
          switch ((payload?.type ?? "").toLowerCase()) {
            case "welcome":
            case "session.created":
            case "session-updated":
              setConnection(true);
              break;
            case "transcript":
              handleTranscriptMessage(payload);
              break;
            case "agent-response":
              handleAgentResponse(payload);
              break;
            case "error":
              console.error("Voice agent error", payload);
              break;
            case "warning":
              console.warn("Voice agent warning", payload);
              break;
            case "close":
            case "close_stream":
              finalizeIncomingMessage();
              break;
            default:
              // Some responses nest data inside "data" field
              if (payload.data?.type === "transcript") {
                handleTranscriptMessage(payload.data);
              } else if (payload.data?.type === "agent-response") {
                handleAgentResponse(payload.data);
              }
              break;
          }
        } catch (error) {
          console.error("Failed to parse message from agent", error);
        }
        return;
      }

      const processAudio = (audioBuffer: ArrayBuffer) => {
        setCurrentSpeaker("model");
        ensureIncomingMessage();
        const incoming = incomingMessageRef.current;
        const combinedAudio = incoming?.audio
          ? concatArrayBuffers(incoming.audio, audioBuffer)
          : audioBuffer;
        updateIncomingMessage({
          audio: combinedAudio,
        });
        playAudio(audioBuffer);
      };

      if (event.data instanceof ArrayBuffer) {
        processAudio(event.data);
      } else if (event.data instanceof Blob) {
        event.data
          .arrayBuffer()
          .then((buffer) => processAudio(buffer))
          .catch((error) =>
            console.error("Failed to decode audio blob from agent", error),
          );
      }
    },
    [
      ensureIncomingMessage,
      finalizeIncomingMessage,
      handleAgentResponse,
      handleTranscriptMessage,
      playAudio,
      updateIncomingMessage,
    ],
  );

  const handleSocketClose = useCallback(() => {
    setConnection(false);
    setMicrophoneOpen(false);
    setCurrentSpeaker(null);
    incomingMessageRef.current = null;
    clearScheduledAudio();
  }, [clearScheduledAudio]);

  const handleSocketError = useCallback(
    (error: any) => {
      console.error("WebSocket error", error);
      handleSocketClose();
    },
    [handleSocketClose],
  );

  const { sendMessage, readyState, getWebSocket } = useWebSocket(socketURL, {
    share: false,
    shouldReconnect: () => true,
    retryOnError: true,
    onOpen: () => {
      const socket = getWebSocket();
      if (socket instanceof WebSocket) {
        socket.binaryType = "arraybuffer";
      }
      setConnection(true);
      sendMessage(JSON.stringify(agentRequest));
    },
    onClose: handleSocketClose,
    onError: handleSocketError,
    onMessage: handleUpstreamMessage,
  });

  const startStreaming = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      console.error("getUserMedia is not supported in this browser.");
      return;
    }

    try {
      const audioContext = new AudioContext({
        sampleRate: INPUT_SAMPLE_RATE,
        latencyHint: "interactive",
      });
      audioContextRef.current = audioContext;
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const microphone = audioContext.createMediaStreamSource(stream);
      microphoneRef.current = microphone;

      const processor = audioContext.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0);
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        if (readyState === ReadyState.OPEN) {
          sendMessage(pcmData.buffer);
        }
      };

      microphone.connect(processor);
      processor.connect(audioContext.destination);
      setMicrophoneOpen(true);
      setCurrentSpeaker("user");
    } catch (error) {
      console.error("Error accessing microphone", error);
      setMicrophoneOpen(false);
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(console.error);
        audioContextRef.current = null;
      }
    }
  }, [readyState, sendMessage]);

  const stopStreaming = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
    }
    if (microphoneRef.current) {
      microphoneRef.current.disconnect();
    }
    if (audioContextRef.current) {
      audioContextRef.current
        .close()
        .catch((err) => console.error("Error closing audio context", err));
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (readyState === ReadyState.OPEN) {
      try {
        sendMessage(JSON.stringify({ type: "CloseStream" }));
      } catch {
        // ignore failures when closing stream
      }
    }

    setMicrophoneOpen(false);
    setCurrentSpeaker(null);
  }, [readyState, sendMessage]);

  const updateVoice = useCallback((newVoice: string) => {
    if (newVoice === voice) return;
    setVoice(newVoice);
    incomingMessageRef.current = null;
  }, [voice]);

  const value = useMemo(
    () => ({
      sendMessage,
      readyState,
      startStreaming,
      stopStreaming,
      connection,
      voice,
      currentSpeaker,
      microphoneOpen,
      chatMessages,
      setVoice: updateVoice,
      replayAudio,
    }),
    [
      chatMessages,
      connection,
      currentSpeaker,
      microphoneOpen,
      readyState,
      replayAudio,
      sendMessage,
      startStreaming,
      stopStreaming,
      updateVoice,
      voice,
    ],
  );

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocketContext = (): WebSocketContextValue => {
  const context = useContext(WebSocketContext);
  if (context === undefined) {
    throw new Error(
      "useWebSocketContext must be used within a WebSocketProvider",
    );
  }
  return context;
};
