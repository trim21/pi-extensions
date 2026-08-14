/**
 * 工具结果 details.pendant —— pi TUI 的 UI 扩展字段（本仓库约定，非 pi 官方 schema）。
 *
 * 工具 execute 返回的 details 里可携带一个可折叠的 markdown 面板，TUI 会把它
 * 与本次工具调用的消息一起渲染：
 * - `markdown`: 面板正文（完整 markdown），建议以 `## ` 标题开头、末尾 trim
 * - `expanded`: 面板是否默认展开；识别/结果这类需要立即看到的内容用 true，
 *   列表等常驻信息用 false
 */
export interface ToolPendant {
  markdown: string;
  /**
   * @default false
   */
  expanded?: boolean;
}
