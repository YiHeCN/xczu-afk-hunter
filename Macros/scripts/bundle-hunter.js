const fs = require("node:fs");
const path = require("node:path");
const ts = require("/Users/heyi/.npm/_npx/360157ef5dc9b5fb/node_modules/typescript/lib/typescript.js");

const root = path.resolve(__dirname, "..");
const entry = "hunter-agent/main.ts";

function normalize(filePath) {
  const parts = filePath.split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function resolve(fromFile, spec) {
  const dir = path.posix.dirname(fromFile);
  return normalize(path.posix.join(dir, spec));
}

const sources = new Map();

function collect(id) {
  if (sources.has(id)) return;
  const text = fs.readFileSync(path.join(root, id), "utf8");
  const info = ts.preProcessFile(text, true, true);
  for (const imported of info.importedFiles) {
    collect(resolve(id, imported.fileName));
  }
  const compiled = ts.transpileModule(text, {
    fileName: id,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  sources.set(id, compiled.outputText);
}

collect(entry);

const payload = Object.fromEntries(sources);
const bundle = `(function () {
  var sources = ${JSON.stringify(payload)};
  var cache = {};
  function normalize(filePath) {
    var parts = filePath.split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }
  function req(fromFile, spec) {
    var dir = fromFile.split("/").slice(0, -1).join("/");
    var id = normalize(dir + "/" + spec);
    var source = sources[id];
    if (!source) throw new Error("找不到模块 " + id + "，来自 " + fromFile);
    var cached = cache[id];
    if (cached) return cached.exports;
    var module = { exports: {} };
    cache[id] = module;
    var factory = new Function("require", "module", "exports", source);
    factory(function (next) { return req(id, next); }, module, module.exports);
    return module.exports;
  }
  req("hunter-agent/main.ts", "./main.ts");
})();
`;

const out = path.join(root, "hunter-agent/bundle.js");
fs.writeFileSync(out, bundle);
console.log(`wrote ${out} (${bundle.length} bytes, ${sources.size} modules)`);
