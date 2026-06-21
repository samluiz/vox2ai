export interface ActiveWindowContext {
  app?: string;
  title?: string;
}

export interface PromptContext {
  clipboard?: string;
  active_window?: ActiveWindowContext | null;
}

export interface ContextDecision {
  context: PromptContext;
  indicator: string | null;
  needsClipboardApproval: boolean;
  clipboardPreview: string;
}

const CLIPBOARD_TRIGGER_RE =
  /\b(this|clipboard|selected|selection|explain this|summarize this|rewrite this|translate this|fix this error|from clipboard|use clipboard)\b/i;

export function shouldUseClipboardAutomatically(prompt: string): boolean {
  return CLIPBOARD_TRIGGER_RE.test(prompt);
}

export function truncateContextText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated]`;
}

export function previewText(text: string, maxChars = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

export async function readClipboardText(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText?.()) ?? "";
  } catch {
    return "";
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText?.(text);
    return true;
  } catch {
    return false;
  }
}

export type QuickActionId =
  | "explain"
  | "summarize"
  | "rewrite"
  | "translate"
  | "fix_error"
  | "generate_command";

export const QUICK_ACTIONS: {
  id: QuickActionId;
  label: string;
  prompt: string;
}[] = [
  { id: "explain", label: "Explain", prompt: "Explain this clearly." },
  { id: "summarize", label: "Summarize", prompt: "Summarize this." },
  { id: "rewrite", label: "Rewrite", prompt: "Rewrite this clearly." },
  { id: "translate", label: "Translate", prompt: "Translate this." },
  { id: "fix_error", label: "Fix error", prompt: "Explain this error and suggest a fix." },
  {
    id: "generate_command",
    label: "Generate command",
    prompt: "Generate the safest shell command for this task. Ask before running.",
  },
];
