/**
 * unknown 收窄守卫：外部数据（JSON、SQLite 行、子进程输出、宿主抛出的错误）
 * 在类型层是 unknown，用守卫显式收窄，避免用 `as` 断言把未检查的值伪装成
 * 已知类型。
 */

/** 纯对象判定（数组与 null 不算）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 数组判定。`Array.isArray` 单独用会把 unknown 收成 any[]，元素仍是未检查的。 */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
