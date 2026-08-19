/**
 * web 扩展的本地配置读取：Search1API key。
 * 路径可注入，便于测试。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

const webSearchSchema = Type.Object({
  search1apiApiKey: Type.Optional(Type.String()),
});

export function webSearchConfigPath(): string {
  return join(homedir(), ".pi", "web-search.json");
}

/** ~/.pi/web-search.json 的 search1apiApiKey，或 SEARCH1API_KEY 环境变量。 */
export async function loadSearch1ApiKey(path = webSearchConfigPath()): Promise<string | undefined> {
  const envKey = process.env.SEARCH1API_KEY;
  if (envKey) return envKey;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = Value.Parse(webSearchSchema, JSON.parse(raw));
    return parsed.search1apiApiKey?.trim() || undefined;
  } catch {
    return undefined;
  }
}
