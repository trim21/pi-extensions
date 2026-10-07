/**
 * UI 文本的 HTML 转义。
 *
 * bwrap 的审批弹窗把外部文本（命令、路径、模型给的理由）直接拼进 HTML description，
 * 这些文本必须先转义，否则会成为弹窗里的标签/属性。
 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
