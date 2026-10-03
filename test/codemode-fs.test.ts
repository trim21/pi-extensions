/**
 * 脚本文件原语（src/codemode/fs.ts）：`fs.read` 拿原始内容、`fs.write` 整体写入。
 *
 * 重点在两件事：读的语义（原文、不截断、不容错编码）与写入前的两条保护（已读且读后未变、
 * write-guard 审批；工作区内 / /tmp 放行、区外弹 diff 审批）。记账与文件工具共用同一个
 * ReadsState，所以「工具读过的文件脚本能直接写」也在这里断言。
 */
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCodemodeFs } from "../src/codemode/fs.js";
import { createReadsState, recordRead, snapshotOf } from "../src/lib/file-reads.js";
import { createRequestPolicy, type RequestPolicy } from "../src/lib/request-policy.js";

let workspace: string;
/**
 * 工作区外的目录。`/tmp` 是 write-guard 的自动放行区，所以「区外」必须落在 /tmp 之外，
 * 这里用仓库目录下的临时目录（用例结束就删）。
 */
const OUTSIDE = join(process.cwd(), ".tmp-codemode-fs-outside");
let policy: RequestPolicy;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "codemode-fs-"));
  await mkdir(OUTSIDE, { recursive: true });
  policy = createRequestPolicy();
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(OUTSIDE, { recursive: true, force: true });
});

interface ContextOptions {
  /** 审批对话框的回答；不传表示 headless（无 UI）。 */
  choice?: string;
  hasUI?: boolean;
}

function makeContext(options: ContextOptions = {}): ExtensionContext {
  const hasUI = options.hasUI ?? options.choice !== undefined;
  return {
    cwd: workspace,
    hasUI,
    ui: {
      select: vi.fn(async () => options.choice),
      notify: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

function createFs(state = createReadsState(), requestPolicy = policy) {
  return {
    state,
    fs: createCodemodeFs({ policy: requestPolicy, reads: state }),
  };
}

describe("fs.read", () => {
  it("返回原始全文：没有行号、没有截断", async () => {
    const file = join(workspace, "data.json");
    const content = '{\n  "a": 1,\n  "b": "x\\ny"\n}\n';
    await writeFile(file, content, "utf8");
    const { fs } = createFs();

    const result = await fs.execute("fs.read", { path: file }, { ctx: makeContext() });

    expect(result.value).toBe(content);
  });

  it("相对路径按 cwd 解析，读取记入已读", async () => {
    await writeFile(join(workspace, "rel.txt"), "hi", "utf8");
    const { fs, state } = createFs();

    const result = await fs.execute("fs.read", { path: "rel.txt" }, { ctx: makeContext() });

    expect(result.value).toBe("hi");
    // 记账 key 是解析后的路径，快照按磁盘字节算
    expect(state.reads.size).toBe(1);
    expect(result.reads).toEqual(Object.fromEntries(state.reads));
  });

  it("保留 BOM（记账指纹要能与磁盘字节对上）", async () => {
    const file = join(workspace, "bom.txt");
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("body", "utf8")]);
    await writeFile(file, bytes);
    const { fs, state } = createFs();

    const result = await fs.execute("fs.read", { path: file }, { ctx: makeContext() });

    expect(result.value).toBe("\uFEFFbody");
    // 与文件工具的记账口径一致：指纹算的是字节，不是解码后的字符串
    expect([...state.reads.values()][0]?.digest).toBe(snapshotOf(bytes).digest);
  });

  it("大文件不截断：读到的长度与文件一致", async () => {
    const file = join(workspace, "big.txt");
    // 稀疏文件：只把大小设到几 MiB，不真的写那么多数据（内容全是 NUL，仍是合法 UTF-8）
    await writeFile(file, "");
    await truncate(file, 4 * 1024 * 1024);
    const { fs } = createFs();

    const result = await fs.execute("fs.read", { path: file }, { ctx: makeContext() });

    expect((result.value as string).length).toBe(4 * 1024 * 1024);
  });

  it("非 UTF-8 内容报错", async () => {
    const file = join(workspace, "bin.dat");
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const { fs } = createFs();

    await expect(fs.execute("fs.read", { path: file }, { ctx: makeContext() })).rejects.toThrow(
      /not valid UTF-8/,
    );
  });

  it("不存在的文件报错", async () => {
    const { fs } = createFs();

    await expect(
      fs.execute("fs.read", { path: join(workspace, "nope.txt") }, { ctx: makeContext() }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("fs.write", () => {
  it("已存在但没读过：拒绝写，文件不变", async () => {
    const file = join(workspace, "unread.txt");
    await writeFile(file, "original", "utf8");
    const { fs } = createFs();

    await expect(
      fs.execute("fs.write", { path: file, content: "clobbered" }, { ctx: makeContext() }),
    ).rejects.toThrow(/has not been read yet/);
    expect(await readFile(file, "utf8")).toBe("original");
  });

  it("读过之后可以写，写完的内容本身也记为已读", async () => {
    const file = join(workspace, "twice.txt");
    await writeFile(file, "one", "utf8");
    const { fs } = createFs();

    await fs.execute("fs.read", { path: file }, { ctx: makeContext() });
    await fs.execute("fs.write", { path: file, content: "two" }, { ctx: makeContext() });
    // 上一步刚写过，同一份内容也已读：不需要重新 read
    await fs.execute("fs.write", { path: file, content: "three" }, { ctx: makeContext() });

    expect(await readFile(file, "utf8")).toBe("three");
  });

  it("读后文件被外部改动：拒绝写", async () => {
    const file = join(workspace, "stale.txt");
    await writeFile(file, "one", "utf8");
    const { fs } = createFs();
    await fs.execute("fs.read", { path: file }, { ctx: makeContext() });
    await writeFile(file, "changed by someone else", "utf8");

    await expect(
      fs.execute("fs.write", { path: file, content: "two" }, { ctx: makeContext() }),
    ).rejects.toThrow(/has been modified since read/);
    expect(await readFile(file, "utf8")).toBe("changed by someone else");
  });

  it("文件工具读过的文件脚本可以直接写（共用记账）", async () => {
    const file = join(workspace, "shared.txt");
    await writeFile(file, "from-tool-read", "utf8");
    const { fs, state } = createFs();
    // 模拟 Read 工具：它把自己的快照记进同一个 ReadsState
    await recordRead(state, file, snapshotOf(await readFile(file)));

    await fs.execute("fs.write", { path: file, content: "from-script" }, { ctx: makeContext() });

    expect(await readFile(file, "utf8")).toBe("from-script");
  });

  it("新建文件免已读，并创建缺失的父目录", async () => {
    const file = join(workspace, "deep", "nested", "new.txt");
    const { fs } = createFs();

    await fs.execute("fs.write", { path: file, content: "created" }, { ctx: makeContext() });

    expect(await readFile(file, "utf8")).toBe("created");
  });

  it("工作区外写入弹审批：批准后落盘，预览里带 diff", async () => {
    const file = join(OUTSIDE, "approved.txt");
    const { fs } = createFs();
    const ctx = makeContext({ choice: "Approve once" });

    await fs.execute("fs.write", { path: file, content: "ok" }, { ctx });

    expect(await readFile(file, "utf8")).toBe("ok");
    const select = (ctx.ui as unknown as { select: ReturnType<typeof vi.fn> }).select;
    const title = select.mock.calls[0]?.[0] as string;
    expect(title).toContain("fs.write");
    expect(title).toContain(file);
    expect(title).toContain("+ok");
  });

  it("工作区内写入不弹审批", async () => {
    const { fs } = createFs();
    const ctx = makeContext({ hasUI: true, choice: "Block" });

    await fs.execute("fs.write", { path: join(workspace, "inside.txt"), content: "x" }, { ctx });

    expect(
      (ctx.ui as unknown as { select: ReturnType<typeof vi.fn> }).select,
    ).not.toHaveBeenCalled();
  });

  it("拒绝审批后文件不变", async () => {
    const file = join(OUTSIDE, "blocked.txt");
    const { fs } = createFs();

    await expect(
      fs.execute(
        "fs.write",
        { path: file, content: "nope" },
        { ctx: makeContext({ choice: "Block" }) },
      ),
    ).rejects.toThrow(/user deny fs.write/);
    await expect(stat(file)).rejects.toThrow(/ENOENT/);
  });

  it("headless 会话下工作区外写入直接拒绝", async () => {
    const file = join(OUTSIDE, "headless.txt");
    const { fs } = createFs();

    await expect(
      fs.execute("fs.write", { path: file, content: "x" }, { ctx: makeContext() }),
    ).rejects.toThrow(/No UI available for approval/);
  });

  it("请求策略生效时工作区外写入不弹框直接拒绝", async () => {
    const file = join(OUTSIDE, "denied.txt");
    policy.setDenyRequests(true);
    const { fs } = createFs();

    await expect(
      fs.execute(
        "fs.write",
        { path: file, content: "x" },
        { ctx: makeContext({ choice: "Approve once" }) },
      ),
    ).rejects.toThrow(/user deny fs.write/);
  });

  it("通过符号链接写入时按链接目标记账（与文件工具一致）", async () => {
    const target = join(workspace, "target.txt");
    const link = join(workspace, "link.txt");
    await writeFile(target, "one", "utf8");
    await symlink(target, link);
    const { fs, state } = createFs();

    await fs.execute("fs.read", { path: link }, { ctx: makeContext() });
    await fs.execute("fs.write", { path: target, content: "two" }, { ctx: makeContext() });

    // 读 link 与写 target 落在同一个记账 key 上
    expect(state.reads.size).toBe(1);
    expect(await readFile(target, "utf8")).toBe("two");
  });

  it("参数不合法时报错", async () => {
    const { fs } = createFs();

    await expect(
      fs.execute("fs.write", { path: 1, content: "x" }, { ctx: makeContext() }),
    ).rejects.toThrow(/path/);
  });

  it("不认识的 fs 操作报错", async () => {
    const { fs } = createFs();

    expect(fs.handles("fs.rm")).toBe(false);
    await expect(fs.execute("fs.rm", {}, { ctx: makeContext() })).rejects.toThrow(
      /Unknown fs operation/,
    );
  });
});
