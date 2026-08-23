import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import ModelCenter from "@/app/components/ModelCenter";
import type { AiModel } from "@/lib/platform-types";

const model: AiModel = {
  id: "model-connection-test",
  name: "连通性测试模型",
  provider: "OpenAI-compatible",
  modelId: "gpt-test",
  level: "测试",
  endpoint: "https://api.example.test/v1/chat/completions",
  iconUrl: null,
  enabled: true,
  parameters: { capabilities: ["文本分析"] },
  hasApiKey: true,
  apiKeyMasked: "sk-••••••••test",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

function dataResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("模型连通性测试", () => {
  test("逐卡发起真实测试并稳定展示成功摘要与延迟", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/models") return dataResponse([model]);
      expect(url).toBe(`/api/models/${model.id}/test`);
      expect(init?.method).toBe("POST");
      return dataResponse({ type: "text", status: "success", latencyMs: 86, summary: "模型连接正常" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ModelCenter />);
    await user.click(await screen.findByRole("button", { name: `测试模型 ${model.name}` }));

    await screen.findByText("连接成功");
    expect(screen.getByRole("status")).toHaveTextContent("连接成功");
    expect(screen.getByRole("status")).toHaveTextContent("文本 · 86 ms");
    expect(screen.getByRole("status")).toHaveTextContent("模型连接正常");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("失败时展示服务端安全错误与失败耗时", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/models") return dataResponse([model]);
      return new Response(JSON.stringify({
        error: {
          code: "MODEL_REQUEST_REJECTED",
          message: "模型认证失败，请检查 API Key。",
          details: { type: "text", status: "failed", latencyMs: 42 },
        },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
    }));
    const user = userEvent.setup();

    render(<ModelCenter />);
    await user.click(await screen.findByRole("button", { name: `测试模型 ${model.name}` }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("连接失败");
    expect(alert).toHaveTextContent("文本 · 42 ms");
    expect(alert).toHaveTextContent("模型认证失败，请检查 API Key。");
  });

  test("刷新模型列表后清除旧测试结果并忽略刷新前尚未返回的测试", async () => {
    let resolveTest!: (response: Response) => void;
    const pendingTest = new Promise<Response>((resolve) => {
      resolveTest = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/models") return dataResponse([model]);
      return pendingTest;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    const { rerender } = render(<ModelCenter refreshKey={0} />);
    await user.click(await screen.findByRole("button", { name: `测试模型 ${model.name}` }));
    expect(screen.getByText("正在测试")).toBeVisible();

    rerender(<ModelCenter refreshKey={1} />);
    await screen.findByText("尚未测试");

    await act(async () => {
      resolveTest(dataResponse({ type: "text", status: "success", latencyMs: 12, summary: "过期响应" }));
      await pendingTest;
    });
    expect(screen.queryByText("连接成功")).not.toBeInTheDocument();
    expect(screen.queryByText("过期响应")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("模型保存期间锁定字段和关闭操作，保存完成后测试状态保持失效", async () => {
    let resolvePatch!: (response: Response) => void;
    const pendingPatch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/models/${model.id}/test`) {
        return dataResponse({ type: "text", status: "success", latencyMs: 31, summary: "旧配置正常" });
      }
      if (url === `/api/models/${model.id}` && init?.method === "PATCH") return pendingPatch;
      if (url === "/api/models") return dataResponse([model]);
      throw new Error(`未处理的请求：${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ModelCenter />);
    await user.click(await screen.findByRole("button", { name: `测试模型 ${model.name}` }));
    await screen.findByText("连接成功");
    await user.click(screen.getByRole("button", { name: `编辑模型 ${model.name}` }));
    await user.click(screen.getByRole("button", { name: "保存模型" }));

    const dialog = screen.getByRole("dialog", { name: "编辑模型" });
    expect(within(dialog).getByRole("textbox", { name: /显示名称/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "关闭模型表单" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "正在保存…" })).toBeDisabled();

    await act(async () => {
      resolvePatch(dataResponse(model));
      await pendingPatch;
    });
    await screen.findByText("尚未测试");
    expect(screen.queryByText("连接成功")).not.toBeInTheDocument();
  });

  test("图标地址更新后会重新尝试加载曾失败的预览", async () => {
    const brokenModel = { ...model, iconUrl: "https://cdn.example.test/broken.png" };
    const fixedModel = {
      ...model,
      iconUrl: "https://cdn.example.test/fixed.png",
      updatedAt: "2026-08-23T01:00:00.000Z",
    };
    let modelLoadCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      modelLoadCount += 1;
      return dataResponse([modelLoadCount === 1 ? brokenModel : fixedModel]);
    }));

    const { container, rerender } = render(<ModelCenter refreshKey={0} />);
    await screen.findByText(brokenModel.name);
    const brokenImage = container.querySelector<HTMLImageElement>(`img[src="${brokenModel.iconUrl}"]`);
    expect(brokenImage).not.toBeNull();
    fireEvent.error(brokenImage as HTMLImageElement);
    expect(container.querySelector(`img[src="${brokenModel.iconUrl}"]`)).toBeNull();

    rerender(<ModelCenter refreshKey={1} />);
    await waitFor(() => {
      expect(container.querySelector(`img[src="${fixedModel.iconUrl}"]`)).not.toBeNull();
    });
  });
});
