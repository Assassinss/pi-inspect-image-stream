import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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

function projectSettingsPath(cwd) {
  return join(cwd, ".pi", "settings.json");
}

function globalSettingsPath() {
  const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

function readVisionConfigAtPath(path) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")).visionConfig;
  } catch {
    return undefined;
  }
}

function getVisionConfig(cwd) {
  return readVisionConfigAtPath(projectSettingsPath(cwd)) ?? readVisionConfigAtPath(globalSettingsPath());
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function cleanup(path) {
  if (existsSync(path)) rmSync(path, { force: true, recursive: true });
}

function testSseParsing() {
  const sample = [
    'data: {"choices":[{"delta":{"content":"你"}}]}',
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    "data: [DONE]"
  ].join("\n");

  assert.equal(extractStreamText(sample), "你好");
}

function testSettingsFallback() {
  const cwd = process.cwd();
  const projectPath = projectSettingsPath(cwd);
  const globalPath = globalSettingsPath();
  const projectDir = join(cwd, ".pi");
  const globalDir = dirname(globalPath);
  const backupGlobal = existsSync(globalPath) ? readFileSync(globalPath, "utf-8") : undefined;

  cleanup(projectDir);
  mkdirSync(globalDir, { recursive: true });

  try {
    writeJson(globalPath, { visionConfig: { provider: "global", model: "g" } });
    assert.deepEqual(getVisionConfig(cwd), { provider: "global", model: "g" });

    writeJson(projectPath, { visionConfig: { provider: "project", model: "p" } });
    assert.deepEqual(getVisionConfig(cwd), { provider: "project", model: "p" });
  } finally {
    cleanup(projectDir);
    if (backupGlobal === undefined) {
      cleanup(globalPath);
    } else {
      writeFileSync(globalPath, backupGlobal, "utf-8");
    }
  }
}

testSseParsing();
testSettingsFallback();
console.log("ok");
