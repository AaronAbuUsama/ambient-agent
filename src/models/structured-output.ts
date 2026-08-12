/** Extract the first JSON object from model text that may carry fences or prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("model returned no JSON object");
  return JSON.parse(raw.slice(start, end + 1));
}
