import { ApiError } from "./api";

export type WorkspaceIdentity = {
  userId: string;
  email: string;
  displayName: string;
};

export function requireWorkspaceIdentity(request: Request): WorkspaceIdentity {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers.get("oai-authenticated-user-email")?.trim();
  if (!userId || !email) {
    throw new ApiError(401, "AUTH_REQUIRED", "请先登录工作区后再使用此功能。 ");
  }

  const encodedName = request.headers.get("oai-authenticated-user-full-name");
  const encoding = request.headers.get("oai-authenticated-user-full-name-encoding");
  let displayName = email;
  if (encodedName && encoding === "percent-encoded-utf-8") {
    try {
      displayName = decodeURIComponent(encodedName);
    } catch {
      displayName = email;
    }
  }

  return { userId, email, displayName };
}
