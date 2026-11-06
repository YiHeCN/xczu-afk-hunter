// JsMacros 的 Graal 引擎把这个文件当普通 JavaScript 执行，不支持 import 和类型标注。
// 源码在 main.ts 和 tasks/ 里。改完后在 Macros 目录运行 node scripts/bundle-hunter.js。
const bundle = __filename.replace(/[^/]+$/, "bundle.js");
const envFile = __filename.replace(/\/[^/]+\/[^/]+\/[^/]+$/, "/.env");
const Files = Java.type("java.nio.file.Files") as {
  readString(path: unknown): string;
  exists(path: unknown): boolean;
};
const Paths = Java.type("java.nio.file.Paths") as { get(path: string): unknown };
const env: Record<string, string> = {};
const envPath = Paths.get(envFile);
if (Files.exists(envPath)) {
  for (const line of String(Files.readString(envPath)).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const splitAt = trimmed.indexOf("=");
    if (splitAt < 0) continue;
    env[trimmed.slice(0, splitAt).trim()] = trimmed.slice(splitAt + 1).trim();
  }
}
(globalThis as { HUNTER_ENV?: Record<string, string> }).HUNTER_ENV = env;
const source = String(Files.readString(Paths.get(bundle)));
eval(source);
