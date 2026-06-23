import assert from "node:assert/strict";

function extractStreamText(responseText) {
  const chunks = [];
  for (const line of responseText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const event = JSON.parse(payload);
    const content = event.choices?.[0]?.delta?.content ?? event.choices?.[0]?.message?.content;
    if (content) chunks.push(content);
  }
  return chunks.join("").trim();
}

const sample = [
  'data: {"choices":[{"delta":{"content":"你"}}]}',
  'data: {"choices":[{"delta":{"content":"好"}}]}',
  'data: [DONE]'
].join("\n");

assert.equal(extractStreamText(sample), "你好");
console.log("ok");
