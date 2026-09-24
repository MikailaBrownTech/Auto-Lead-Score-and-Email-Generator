import { zodToJsonSchema } from "zod-to-json-schema";
import { ExtractedFactsSchema } from "./dossier";

export const EXTRACTION_TOOL_NAME = "record_dossier";

/**
 * JSON schema for the extraction tool's input, generated from the shared zod schema so the model
 * and the validator can never drift. Inlined (no $ref) and without $schema, as the API expects.
 */
export function extractionInputSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(ExtractedFactsSchema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return schema;
}
