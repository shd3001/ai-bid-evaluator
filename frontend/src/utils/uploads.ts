/**
 * 上传回执簿。
 *
 * 后端只提供 POST /documents 与 GET /documents/{id}，没有"列出某项目全部材料"的接口，
 * 因此本机把上传成功后的回执（document_id + 原始文件名 + 角色）记在 localStorage 里，
 * 用于界面上**你自己**找回 document_id。它是本地便利记录，不是业务事实：
 * 真正的 document_id / status / chunk_count 一律以 GET /documents/{id} 的返回为准。
 */
import type { DocRole } from "../api/client";

const KEY = "review-desk.upload-receipts.v1";
const MAX = 80;

export interface UploadReceipt {
  documentId: string;
  projectId: string;
  fileName: string;
  role: DocRole;
  bidderId: string | null;
  at: string;
}

interface Stored {
  [projectId: string]: UploadReceipt[];
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

function write(value: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* 存储不可用时静默降级：回执只是便利记录 */
  }
}

export function receiptsFor(projectId: string): UploadReceipt[] {
  return read()[projectId] ?? [];
}

export function rememberReceipt(receipt: UploadReceipt): void {
  const all = read();
  const list = (all[receipt.projectId] ?? []).filter((item) => item.documentId !== receipt.documentId);
  list.unshift(receipt);
  all[receipt.projectId] = list.slice(0, MAX);
  write(all);
}

export function forgetReceipt(projectId: string, documentId: string): void {
  const all = read();
  all[projectId] = (all[projectId] ?? []).filter((item) => item.documentId !== documentId);
  write(all);
}
