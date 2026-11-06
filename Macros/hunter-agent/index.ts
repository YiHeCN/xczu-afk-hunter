// JsMacros 的 Graal 引擎把这个文件当普通 JavaScript 执行，不支持 import 和类型标注。
// 源码在 main.ts 和 tasks/ 里。改完后在 Macros 目录运行 node scripts/bundle-hunter.js。
const bundle = __filename.replace(/[^/]+$/, "bundle.js");
const Files = Java.type("java.nio.file.Files") as { readString(path: unknown): string };
const Paths = Java.type("java.nio.file.Paths") as { get(path: string): unknown };
const source = String(Files.readString(Paths.get(bundle)));
eval(source);
