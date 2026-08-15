/**
 * wasm —— 运行时定位 npm 包内的 wasm 文件。
 * Node ESM 下 `import.meta.resolve` 返回 file URL（受包 exports 约束）。
 */

export function resolvePackageWasm(packageName: string, subpath: string): URL {
  const resolved = import.meta.resolve(`${packageName}/${subpath}`);
  return new URL(resolved);
}
