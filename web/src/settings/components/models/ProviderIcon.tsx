import { Cloud, Cpu, Plug } from "lucide-react";
import anthropic from "@/settings/assets/providers/anthropic.svg";
import bytedance from "@/settings/assets/providers/bytedance.png";
import deepseek from "@/settings/assets/providers/deepseek.svg";
import elevenlabs from "@/settings/assets/providers/elevenlabs.svg";
import gemini from "@/settings/assets/providers/gemini.svg";
import ollama from "@/settings/assets/providers/ollama.svg";
import openai from "@/settings/assets/providers/openai.svg";
import openrouter from "@/settings/assets/providers/openrouter.svg";
import siliconflow from "@/settings/assets/providers/siliconflow.svg";
import type { RegistryProvider } from "@/settings/types/models";

const logos: Record<string, string> = {
  anthropic,
  bytedance,
  deepseek,
  elevenlabs,
  gemini,
  ollama,
  openrouter,
  openai,
  siliconflow,
};

export function ProviderIcon({
  provider,
  size = "normal",
}: {
  provider: RegistryProvider;
  size?: "normal" | "large";
}) {
  const logo = logos[provider.id];
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-lg text-text-dim ${size === "large" ? "size-11" : "size-8"}`}
    >
      {logo ? (
        <img
          src={logo}
          alt=""
          className={
            size === "large" ? "size-7 object-contain grayscale" : "size-5 object-contain grayscale"
          }
        />
      ) : provider.id === "local_asr" ? (
        <Cpu size={18} />
      ) : provider.id === "custom_openai" ? (
        <Plug size={18} />
      ) : (
        <Cloud size={18} />
      )}
    </span>
  );
}
