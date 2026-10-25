import { spawnSync } from "node:child_process";
import iconv from "iconv-lite";

let oemCodepage: string | null = null;
/**
 * 管道中的 cmd/PowerShell 按系统 OEM 代码页解析输入；chcp 65001 时 cmd 读取多字节输入会出错。
 * 因此命令行以 OEM 编码写入，运行中程序的 stdin 仍按 UTF-8 写入。
 */
export function systemOemCodepage(): string {
  if (oemCodepage) return oemCodepage;
  let page = "utf8";
  try {
    const output = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true, timeout: 5000 }).stdout?.toString("latin1").trim() ?? "";
    const number = /(\d+)\s*$/u.exec(output)?.[1];
    if (number && number !== "65001" && iconv.encodingExists(`cp${number}`)) page = `cp${number}`;
  } catch { /* fall back to UTF-8 */ }
  oemCodepage = page;
  return page;
}

/** 逐行把 OEM 输出（cmd 内建命令）与 UTF-8 输出（多数开发工具）统一为 UTF-8。 */
export class MixedOutputTranscoder {
  private pending = Buffer.alloc(0);
  constructor(private readonly codepage: string) {}
  push(chunk: Buffer): Buffer {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    const lastNewline = data.lastIndexOf(0x0a);
    const complete = lastNewline >= 0 ? data.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    data = lastNewline >= 0 ? data.subarray(lastNewline + 1) : data;
    const parts: Buffer[] = [];
    let lineStart = 0;
    for (let index = 0; index < complete.length; index++) {
      if (complete[index] !== 0x0a) continue;
      parts.push(this.decodeLine(complete.subarray(lineStart, index + 1)));
      lineStart = index + 1;
    }
    if (data.length) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: true });
        const used = Buffer.byteLength(text, "utf8");
        parts.push(Buffer.from(text, "utf8"));
        this.pending = Buffer.from(data.subarray(used));
      } catch { parts.push(Buffer.from(iconv.decode(data, this.codepage), "utf8")); }
    }
    return Buffer.concat(parts);
  }
  end(): Buffer {
    const last = this.pending; this.pending = Buffer.alloc(0);
    return this.decodeLine(last);
  }
  private decodeLine(line: Buffer): Buffer {
    try { new TextDecoder("utf-8", { fatal: true }).decode(line); return line; }
    catch { return Buffer.from(iconv.decode(line, this.codepage), "utf8"); }
  }
}
