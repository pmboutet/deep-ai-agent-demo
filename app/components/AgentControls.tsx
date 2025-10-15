import { Tooltip } from "@nextui-org/react";
import { useCallback, useMemo, type MouseEvent } from "react";
import { MicrophoneIcon } from "./icons/MicrophoneIcon";
import { useWebSocketContext } from "../context/WebSocketContext";

const formatVoiceName = (model: string) => {
  if (!model) {
    return "Unknown voice";
  }

  const cleaned = model.replace(/^aura[-_]?/i, "").replace(/[-_]/g, " ");
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

export const AgentSettings = () => {
  const { voice } = useWebSocketContext();

  const voiceLabel = useMemo(() => formatVoiceName(voice), [voice]);

  return (
    <div className="flex items-center gap-2.5 text-sm mr-4 text-white/50 font-inter">
      <span className="hidden md:inline-block">
        Agent: <span className="text-white">Deepgram Voice Agent API</span>
      </span>
      <span className="hidden md:inline-block">
        Voice: <span className="text-white">{voiceLabel}</span>
      </span>
    </div>
  );
};

export const AgentControls = () => {
  const { startStreaming, stopStreaming, microphoneOpen } =
    useWebSocketContext();

  const microphoneToggle = useCallback(
    async (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (!microphoneOpen) {
        await startStreaming();
      } else {
        stopStreaming();
      }
    },
    [microphoneOpen, startStreaming, stopStreaming]
  );

  return (
    <div className="relative">
      <div className="absolute w-full -top-[4.5rem] py-4 flex justify-center">
        <AgentSettings />
      </div>
      <div className="flex bg-[#101014] rounded-full justify-center">
        <span
          className={`rounded-full p-0.5 ${
            microphoneOpen
              ? "bg-gradient-to-r bg-gradient to-[#13EF93]/50 from-red-500"
              : "bg-gradient-to-r bg-gradient to-[#13EF93]/50 from-[#149AFB]/80"
          }`}
        >
          <Tooltip showArrow content="Toggle microphone on/off.">
            <a
              href="#"
              onClick={microphoneToggle}
              className="rounded-full w-16 md:w-20 sm:w-24 py-2 md:py-4 px-2 h-full sm:px-8 font-bold bg-[#101014] text-light-900 text-sm sm:text-base flex items-center justify-center group"
            >
              {microphoneOpen && (
                <div className="w-auto items-center justify-center hidden sm:flex absolute shrink-0">
                  <MicrophoneIcon
                    micOpen={microphoneOpen}
                    className="h-5 md:h-6 animate-ping-infinite"
                  />
                </div>
              )}
              <div className="w-auto flex items-center justify-center shrink-0">
                <MicrophoneIcon
                  micOpen={microphoneOpen}
                  className="h-5 md:h-6"
                />
              </div>
            </a>
          </Tooltip>
        </span>
      </div>
    </div>
  );
};
