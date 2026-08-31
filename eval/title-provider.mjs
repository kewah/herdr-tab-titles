import { generateTitle } from "../src/rename.mjs";

/** Promptfoo adapter for the plugin's production title-generation path. */
export default class HerdrTitleProvider {
  id() {
    return "herdr-title-generator";
  }

  async callApi(prompt) {
    try {
      const result = await generateTitle(prompt);
      return {
        // Evaluate the model response before parseLabel can repair Markdown,
        // list markers, or commentary that violates the generation prompt.
        output: result.rawOutput,
        metadata: {
          parsedTitle: result.label,
          generator: result.generator,
          model: result.model,
        },
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
