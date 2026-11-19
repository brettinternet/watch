import { expect, test } from "bun:test";
import { parseOutput, type Triage, triageSchema } from "./llm";

const schema = triageSchema(["incident", "fyi"]);
const t: Triage = {
  title: "API down",
  summary: "#ops: checkout returns 500s",
  items: [{ ids: ["m1"], priority: "high", category: "incident", reason: "Outage" }],
};

test("reads structured output from each agent's format", () => {
  expect(parseOutput("claude", JSON.stringify({ structured_output: t }), schema)).toEqual(t);
  const fenced = { result: `\`\`\`json\n${JSON.stringify(t)}\n\`\`\`` };
  expect(parseOutput("claude", JSON.stringify(fenced), schema)).toEqual(t);
  expect(parseOutput("pi", `Here is the triage:\n${JSON.stringify(t)}\n`, schema)).toEqual(t);
});

test("rejects agent errors and categories outside the config", () => {
  expect(() =>
    parseOutput("claude", JSON.stringify({ is_error: true, result: "rate limited" }), schema),
  ).toThrow("rate limited");
  const unknown = { ...t, items: [{ ...t.items[0], category: "other" }] };
  expect(() => parseOutput("pi", JSON.stringify(unknown), schema)).toThrow();
});
