// 给 typescript-language-server 计算 initializationOptions.tsserver.path。
//
// 用法：把这个文件复制到 ~/.pi/agent/lsp/，在 lsp.json 的 typescript server 上配
//   "initializationOptionsCommand": ["node", "/home/<user>/.pi/agent/lsp/typescript-options.mjs"]
// 引擎在 spawn 服务器前执行它（cwd = 服务器 root），stdout 的 JSON 对象与静态
// initializationOptions 深合并，且用户显式给出的值优先。
//
// 只在 workspace 里的 typescript 不可用时才需要干预：
//   - 项目把 typescript alias 成 @typescript/typescript6 这类 shim 包时，
//     node_modules/typescript/lib 下只有转发 stub、没有 tsserver.js，
//     typescript-language-server 的 workspace 探测会失败并直接报错退出；
//     真实 typescript 在哪取决于包管理器与链接方式：
//       npm 提升／pnpm hoisted：node_modules/@typescript/<包>/lib/tsserver.js
//       npm 嵌套：node_modules/typescript/node_modules/@typescript/<包>/lib/tsserver.js
//       pnpm store：node_modules/.pnpm/<typescript@版本 或 @typescript+包@版本>/
//                   node_modules/{typescript,@typescript/<包>}/lib/tsserver.js
//   - 项目里是标准 typescript 依赖时 workspace 探测本来就能命中，脚本输出空对象，
//     不做任何覆盖，保持服务器自己的解析结果（版本随项目走）。
//
// 沿 node_modules 链向上找（与语言服务器的 workspace 探测一致），每级先看标准位置，
// 再看上面几种落法，取带 tsserver.js 的最高版本（typescript@7 是 native 包，
// 没有 tsserver.js，会被过滤掉）。
//
// 独立可执行脚本：只用 node 内置模块、不依赖扩展运行时，因此用同步 fs API。

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

/** cwd 到根的所有 node_modules 目录（含自身）。 */
function nodeModulesChain(dir) {
  const chain = [];
  let current = dir;
  for (;;) {
    chain.push(join(current, "node_modules"));
    const parent = dirname(current);
    if (parent === current) {
      return chain;
    }
    current = parent;
  }
}

/** 版本段转数字；非数字段（如 `0-beta`）当 0。 */
function versionPart(segment = "0") {
  const parsed = Number(segment);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 版本号降序比较；只认前导数字段，足够比对 `typescript@<版本>` 这类目录名。 */
function compareVersions(a, b) {
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const na = versionPart(left[i]);
    const nb = versionPart(right[i]);
    if (na !== nb) {
      return na - nb;
    }
  }
  return 0;
}

/** 目录下的子目录名；不存在或读不了给空数组。 */
function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** package.json 的 version；读不到或不是字符串时给 "0"（只用于排序，不影响可用性）。 */
function packageVersion(dir) {
  try {
    const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
    return typeof version === "string" ? version : "0";
  } catch {
    return "0";
  }
}

/** 包目录（typescript 或 @typescript/<包>）带 tsserver.js 时的候选。 */
function candidate(packageDir) {
  const path = join(packageDir, "lib/tsserver.js");
  return existsSync(path) ? { version: packageVersion(packageDir), path } : undefined;
}

/** dir/@typescript/<包> 下的候选（顶层与嵌套层共用）。 */
function scopedCandidates(dir) {
  return listDirs(join(dir, "@typescript")).map((name) =>
    candidate(join(dir, "@typescript", name)),
  );
}

/** 该级 node_modules 下所有带 tsserver.js 的候选：npm（提升/嵌套）与 pnpm（store/hoisted）都覆盖。 */
function levelCandidates(nodeModules) {
  const candidates = [
    candidate(join(nodeModules, "typescript")),
    ...scopedCandidates(nodeModules),
    // npm 把 shim 自己的依赖嵌在它下面（顶层放不下时）
    candidate(join(nodeModules, "typescript", "node_modules", "typescript")),
    ...scopedCandidates(join(nodeModules, "typescript", "node_modules")),
  ];
  // pnpm store：虚拟 store 里真实 typescript 与 alias 出来的 shim 兄弟包
  for (const name of listDirs(join(nodeModules, ".pnpm"))) {
    if (!name.startsWith("typescript@") && !name.startsWith("@typescript+")) {
      continue;
    }
    const store = join(nodeModules, ".pnpm", name, "node_modules");
    candidates.push(candidate(join(store, "typescript")), ...scopedCandidates(store));
  }
  return candidates.filter((value) => value !== undefined);
}

/** 该级 node_modules 下带 tsserver.js 的最高版本 tsserver 路径；没有则 undefined。 */
function levelTsserver(nodeModules) {
  return levelCandidates(nodeModules).toSorted((a, b) => compareVersions(b.version, a.version))[0]
    ?.path;
}

/** 解析该 workspace 该用的 tsserver 路径；标准依赖可由服务器自己解析时不返回路径。 */
function resolveTsserver(cwd) {
  for (const nodeModules of nodeModulesChain(cwd)) {
    // 标准依赖：语言服务器自己就能解析到，别覆盖（否则会把项目锁到别的 TS 版本）
    try {
      const real = realpathSync(join(nodeModules, "typescript"));
      if (existsSync(join(real, "lib/tsserver.js"))) {
        return;
      }
    } catch {
      // 没有这个包，继续
    }
    const found = levelTsserver(nodeModules);
    if (found) {
      return found;
    }
  }
}

const tsserverPath = resolveTsserver(process.cwd());
process.stdout.write(
  `${JSON.stringify(tsserverPath ? { tsserver: { path: tsserverPath } } : {})}\n`,
);
