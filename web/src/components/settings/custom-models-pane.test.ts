import { describe, expect, it } from "vitest";
import { draftFromConfig } from "./custom-models-pane";

describe("draftFromConfig", () => {
  it("loads a custom provider stored under a bare providers key", () => {
    const draft = draftFromConfig(
      {
        providers: {
          local: {
            base_url: "http://localhost:8000/v1",
            api_key: "local-key",
            model: "local-model",
            models: {
              "local-model": { supports_tools: false, context_length: 65_536 },
            },
          },
        },
      },
      "custom:local",
    );

    expect(draft).toMatchObject({
      baseUrl: "http://localhost:8000/v1",
      apiKey: "local-key",
      modelName: "local-model",
      supportsTools: false,
      inputWindow: 65_536,
    });
  });

  it("loads a legacy custom_providers entry", () => {
    const draft = draftFromConfig(
      {
        custom_providers: [
          {
            name: "legacy",
            base_url: "https://legacy.example/v1",
            api_key: "legacy-key",
            model: "legacy-model",
          },
        ],
      },
      "custom:legacy",
    );

    expect(draft).toMatchObject({
      baseUrl: "https://legacy.example/v1",
      apiKey: "legacy-key",
      modelName: "legacy-model",
    });
  });
});
