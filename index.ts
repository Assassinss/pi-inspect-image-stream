import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import { defineTool, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface VisionConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  stream?: boolean;
}

interface InspectImageDetails {
  path: string;
  prompt?: string;
  provider: string;
  model: string;
}

function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function globalSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

async function readSettingsRaw(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function readProjectSettingsRaw(cwd: string): Promise<Record<string, unknown>> {
  return readSettingsRaw(projectSettingsPath(cwd));
}

async function writeProjectSettings(cwd: string, settings: Record<string, unknown>): Promise<void> {
  const path = projectSettingsPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

async function saveVisionConfig(cwd: string, config: VisionConfig): Promise<void> {
  const settings = await readProjectSettingsRaw(cwd);
  settings.visionConfig = config;
  await writeProjectSettings(cwd, settings);
}

function readVisionConfigAtPath(path: string): VisionConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw.visionConfig as VisionConfig | undefined;
  } catch {
    return undefined;
  }
}

function getVisionConfig(cwd: string): VisionConfig | undefined {
  return readVisionConfigAtPath(projectSettingsPath(cwd)) ?? readVisionConfigAtPath(globalSettingsPath());
}

function resolveApiUrl(provider: string, baseUrl?: string): string {
  if (baseUrl) {
    return baseUrl.replace(/\/$/, "") + "/v1/chat/completions";
  }
  const known: Record<string, string> = {
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
    openai: "https://api.openai.com/v1/chat/completions"
  };
  const url = known[provider.toLowerCase()];
  if (!url) {
    throw new Error(
      `Unknown vision provider "${provider}". Set "baseUrl" in visionConfig, or use one of: ${Object.keys(known).join(", ")}.`
    );
  }
  return url;
}

function extractStreamText(responseText: string): string {
  const chunks: string[] = [];
  for (const line of responseText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const event = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (event.error) {
      throw new Error(`Vision API error: ${event.error.message ?? JSON.stringify(event.error)}`);
    }
    const content = event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.message?.content;
    if (content) chunks.push(content);
  }
  return chunks.join("").trim();
}

async function runVisionSetup(ctx: ExtensionContext): Promise<VisionConfig | undefined> {
  const available = ctx.modelRegistry.getAvailable();
  const visionByProvider = new Map<string, string>();
  for (const model of available) {
    if (model.input.includes("image") && !visionByProvider.has(model.provider)) {
      visionByProvider.set(model.provider, ctx.modelRegistry.getProviderDisplayName(model.provider));
    }
  }

  const providerOptions = [...visionByProvider.values()];
  if (providerOptions.length > 0) {
    providerOptions.push("▸ Other (type provider name)…");
  }

  let provider: string | undefined;
  if (providerOptions.length > 0) {
    const choice = await ctx.ui.select(
      "Choose a vision provider  |  project -> .pi/settings.json  |  global -> ~/.pi/agent/settings.json",
      providerOptions
    );
    if (!choice) return undefined;
    if (!choice.startsWith("▸")) {
      for (const [key, name] of visionByProvider) {
        if (name === choice) {
          provider = key;
          break;
        }
      }
    }
  }

  if (!provider) {
    provider = await ctx.ui.input("Enter provider name:", "e.g. openai, openrouter");
    if (!provider) return undefined;
  }

  const modelId = await ctx.ui.input("Enter model ID:", "e.g. gpt-4o");
  if (!modelId) return undefined;

  const found = ctx.modelRegistry.find(provider, modelId);
  if (!found) {
    ctx.ui.notify(
      `Model "${modelId}" not found for provider "${provider}" in the registry - ensure it supports vision.`,
      "warning"
    );
  } else if (!found.input.includes("image")) {
    ctx.ui.notify(`Model "${modelId}" does not list image support - vision calls may fail.`, "warning");
  }

  const config: VisionConfig = { provider, model: modelId };
  await saveVisionConfig(ctx.cwd, config);
  return config;
}

const InspectImageParams = Type.Object({
  path: Type.String({ description: "Path to the image file to analyze" }),
  prompt: Type.Optional(
    Type.String({
      description: "Custom prompt for the vision model (default: 'Describe this image in detail.')"
    })
  )
});

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const currentModel = ctx.model;
    if (!currentModel || currentModel.input.includes("image")) return;

    const hasAttachedImages = event.images && event.images.length > 0;
    const mentionsImageFile = /\.(png|jpe?g|gif|webp|bmp)\b/i.test(event.prompt);
    if (!hasAttachedImages && !mentionsImageFile) return;

    return {
      message: {
        customType: "inspect-image-hint",
        content:
          "⚠️ The current chat model does not support image input. " +
          "Use the `inspect_image` tool to analyze this image - " +
          "it routes to a separate vision-capable model.",
        display: true
      }
    };
  });

  pi.registerCommand("setup-vision", {
    description: "Pick a vision model for the inspect_image tool",
    handler: async (_args, ctx) => {
      const config = await runVisionSetup(ctx);
      if (config) {
        const name = ctx.modelRegistry.getProviderDisplayName(config.provider);
        ctx.ui.notify(`Vision model: ${name} / ${config.model}`, "info");
      }
    }
  });

  pi.registerTool(
    defineTool({
      name: "inspect_image",
      label: "Inspect Image",
      description: "Analyze an image file using a separate vision-capable model. Returns a text description of the image contents.",
      promptSnippet: "Analyze an image file using a vision-capable model (separate from the chat model)",
      promptGuidelines: [
        "Use inspect_image whenever the user asks about an image file - the current chat model may not support vision directly.",
        "Use inspect_image for any image-related request: describe, analyze, extract text from, or answer questions about image files.",
        "If inspect_image fails because no vision model is configured, it will guide the user through setup; continue after setup completes."
      ],
      parameters: InspectImageParams,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        let visionConfig = getVisionConfig(ctx.cwd);
        if (!visionConfig) {
          visionConfig = await runVisionSetup(ctx);
          if (!visionConfig) {
            throw new Error(
              "Vision setup was cancelled or no vision models are available. Run /setup-vision to configure, or add a 'visionConfig' block to .pi/settings.json or ~/.pi/agent/settings.json."
            );
          }
        }

        const provider = visionConfig.provider;
        const model = visionConfig.model;
        const apiUrl = resolveApiUrl(provider, visionConfig.baseUrl);
        const imagePath =
          params.path.startsWith("/") || params.path.startsWith("\\") || /^[a-zA-Z]:/.test(params.path)
            ? params.path
            : resolvePath(ctx.cwd, params.path);

        let imageBuffer: Buffer;
        try {
          imageBuffer = await readFile(imagePath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to read image file "${params.path}": ${message}`);
        }

        const maxImageSize = 20 * 1024 * 1024;
        if (imageBuffer.length > maxImageSize) {
          throw new Error(
            `Image file "${params.path}" is too large (${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB). Maximum size is ${maxImageSize / 1024 / 1024}MB. Please resize the image before analyzing.`
          );
        }

        const ext = extname(imagePath).toLowerCase();
        const mimeMap: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".bmp": "image/bmp"
        };
        const mimeType = mimeMap[ext];
        if (!mimeType) {
          throw new Error(`Unsupported image format "${ext}". Supported formats: ${Object.keys(mimeMap).join(", ")}.`);
        }

        const dataUri = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
        if (!apiKey) {
          throw new Error(
            `No API key found for provider "${provider}". Please configure it via /login, set an environment variable, or add it to auth.json.`
          );
        }

        const userPrompt = params.prompt ?? "Describe this image in detail.";
        const requestBody = {
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: userPrompt },
                { type: "image_url", image_url: { url: dataUri } }
              ]
            }
          ],
          max_tokens: visionConfig.maxTokens ?? 4096,
          stream: visionConfig.stream ?? Boolean(visionConfig.baseUrl)
        };

        // ponytail: custom OpenAI-compatible providers sometimes only support SSE, so handle both.
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody),
          signal
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Vision API error (${response.status}): ${errorText}`);
        }

        const contentType = response.headers.get("content-type") ?? "";
        let description = "";
        if (contentType.includes("text/event-stream")) {
          description = extractStreamText(await response.text());
        } else {
          const responseData = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
            error?: { message?: string };
          };
          if (responseData.error) {
            throw new Error(`Vision API error: ${responseData.error.message ?? JSON.stringify(responseData.error)}`);
          }
          description = responseData.choices?.[0]?.message?.content ?? "";
        }

        if (!description) {
          throw new Error("Vision API returned an empty response.");
        }

        return {
          content: [{ type: "text", text: description }],
          details: { path: params.path, prompt: params.prompt, provider, model } as InspectImageDetails
        };
      }
    })
  );
}
