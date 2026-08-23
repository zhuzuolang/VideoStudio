import type { WorkspaceIdentity } from "./auth";
import { requireWorkspaceIdentity } from "./auth";
import { ensureWorkspace, getStore } from "./store";

export async function apiContext(request: Request): Promise<{ db: D1Database; identity: WorkspaceIdentity }> {
  const identity = requireWorkspaceIdentity(request);
  const db = await getStore();
  await ensureWorkspace(db, identity);
  return { db, identity };
}

export type RouteContext<T extends Record<string, string>> = {
  params: Promise<T>;
};
