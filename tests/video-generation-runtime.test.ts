import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decryptApiKey: vi.fn(async () => "provider-key"),
  validateModelEndpoint: vi.fn(async (value: string) => value),
  validatePublicHttpsUrl: vi.fn(async (value: string) => value),
}));

vi.mock("@/lib/server/crypto", () => ({ decryptApiKey: mocks.decryptApiKey }));
vi.mock("@/lib/server/outbound", () => ({
  validateModelEndpoint: mocks.validateModelEndpoint,
  validatePublicHttpsUrl: mocks.validatePublicHttpsUrl,
}));

import { SEEDANCE_MODEL_PRESETS } from "@/lib/seedance-model-presets";
import {
  buildVideoGenerationRequest,
  createVideoGenerationTask,
  downloadGeneratedVideo,
  getVideoGenerationTask,
  modelSupportsVideoGeneration,
  openGeneratedVideoStream,
  testVideoGenerationConnection,
  videoGenerationEndpoint,
  videoGenerationTaskEndpoint,
} from "@/lib/server/video-generation";

function configuredModel(index = 0): Record<string, unknown> {
  const preset = SEEDANCE_MODEL_PRESETS[index];
  return {
    id: `model-${index}`,
    name: preset.name,
    provider: preset.provider,
    model_id: preset.modelId,
    endpoint: preset.endpoint,
    enabled: 1,
    api_key_ciphertext: "cipher",
    api_key_iv: "iv",
    parameters_json: JSON.stringify(preset.parameters),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decryptApiKey.mockResolvedValue("provider-key");
  mocks.validateModelEndpoint.mockImplementation(async (value: string) => value);
  mocks.validatePublicHttpsUrl.mockImplementation(async (value: string) => value);
});

describe("Seedance 官方价格预设", () => {
  test("按四个价格 SKU 提供稳定且可保存的卡片参数", () => {
    expect(SEEDANCE_MODEL_PRESETS).toHaveLength(4);
    expect(SEEDANCE_MODEL_PRESETS.map((preset) => preset.modelId)).toEqual([
      "doubao-seedance-2-5-260628",
      "doubao-seedance-2-0-260128",
      "doubao-seedance-2-0-fast-260128",
      "doubao-seedance-2-0-mini-260615",
    ]);
    expect(SEEDANCE_MODEL_PRESETS.map((preset) => [
      preset.parameters.pricing.withVideoInput,
      preset.parameters.pricing.withoutVideoInput,
    ])).toEqual([
      ["42", "70"],
      ["28起", "46起"],
      ["22", "37"],
      ["14", "23"],
    ]);
    for (const preset of SEEDANCE_MODEL_PRESETS) {
      expect(preset.endpoint).toBe("https://ark.cn-beijing.volces.com/api/v3");
      expect(preset.capabilities).toContain("video-generation");
      expect(preset.parameters).toMatchObject({
        presetKey: preset.presetId,
        family: "seedance",
        capabilities: expect.arrayContaining(["video-generation", "text-to-video", "image-to-video"]),
        pricing: { currency: "CNY", unit: "million_tokens" },
        video: {
          requestProfile: preset.presetId,
          defaultResolution: expect.any(String),
          defaultAspectRatio: "adaptive",
          minDuration: expect.any(Number),
          maxDuration: expect.any(Number),
          defaultDuration: expect.any(Number),
          supportsGenerateAudio: expect.any(Boolean),
          defaultGenerateAudio: expect.any(Boolean),
          maxReferenceImages: expect.any(Number),
          referenceImageRoles: ["first_frame", "last_frame", "reference_image"],
        },
      });
    }
  });

  test("profile 明确表达各 SKU 的分辨率、时长和音频差异", () => {
    const [v25, v20, fast, mini] = SEEDANCE_MODEL_PRESETS.map((preset) => preset.parameters.video);
    expect(v25).toMatchObject({ resolutions: ["480p", "720p", "1080p"], maxDuration: 30, supportsAutoDuration: true, supportsGenerateAudio: true, maxReferenceImages: 30 });
    expect(v20).toMatchObject({ resolutions: ["480p", "720p", "1080p", "4k"], maxDuration: 15, supportsAutoDuration: true, maxReferenceImages: 9 });
    expect(fast).toMatchObject({ resolutions: ["480p", "720p"], maxDuration: 15, supportsAutoDuration: true, supportsGenerateAudio: true, maxReferenceImages: 9 });
    expect(mini).toMatchObject({
      resolutions: ["480p", "720p"],
      maxDuration: 15,
      supportsAutoDuration: true,
      supportsGenerateAudio: false,
      defaultGenerateAudio: false,
      maxReferenceImages: 9,
    });
  });
});

describe("模型识别和任务 API 地址", () => {
  test("只把明确的视频生成能力或 Seedance 描述识别为生成模型", () => {
    expect(modelSupportsVideoGeneration({
      model_id: "custom-video-v1",
      parameters_json: JSON.stringify({ capabilities: ["图生视频"] }),
    })).toBe(true);
    expect(modelSupportsVideoGeneration({ model_id: "doubao-seedance-2-0-260128" })).toBe(true);
    expect(modelSupportsVideoGeneration({
      model_id: "video-understanding-v1",
      parameters_json: JSON.stringify({ capabilities: ["video", "analysis"] }),
    })).toBe(false);
  });

  test("基础地址和其他生成端点都归一到异步任务集合", () => {
    expect(videoGenerationEndpoint("https://ark.example.com/api/v3")).toBe(
      "https://ark.example.com/api/v3/contents/generations/tasks",
    );
    expect(videoGenerationEndpoint("https://ark.example.com/api/v3/chat/completions")).toBe(
      "https://ark.example.com/api/v3/contents/generations/tasks",
    );
    expect(videoGenerationEndpoint("https://ark.example.com/api/v3/contents/generations/tasks/old-task")).toBe(
      "https://ark.example.com/api/v3/contents/generations/tasks",
    );
    expect(videoGenerationTaskEndpoint("https://ark.example.com/api/v3", "cgt-123")).toBe(
      "https://ark.example.com/api/v3/contents/generations/tasks/cgt-123",
    );
  });
});

describe("Seedance 请求 profile", () => {
  test("按官方 content 数组构造文生和图生视频请求", () => {
    const request = buildVideoGenerationRequest(configuredModel(1), {
      prompt: "  广角镜头下，一只猫走过雨夜街头  ",
      resolution: "1080P",
      aspectRatio: "16:9",
      duration: 10,
      generateAudio: true,
      referenceImageUrl: "https://cdn.example.com/cat.png?sig=1",
      referenceImageRole: "reference_image",
      returnLastFrame: true,
      watermark: false,
      seed: 7,
    });

    expect(request).toEqual({
      model: "doubao-seedance-2-0-260128",
      content: [
        { type: "text", text: "广角镜头下，一只猫走过雨夜街头" },
        {
          type: "image_url",
          image_url: { url: "https://cdn.example.com/cat.png?sig=1" },
          role: "reference_image",
        },
      ],
      resolution: "1080p",
      ratio: "16:9",
      duration: 10,
      generate_audio: true,
      return_last_frame: true,
      watermark: false,
      seed: 7,
    });
  });

  test("2.5 接受 30 秒与 1080p、2.0 接受 4k，Fast 拒绝官方范围外的 1080p", () => {
    expect(buildVideoGenerationRequest(configuredModel(0), {
      prompt: "长镜头",
      duration: 30,
      resolution: "1080p",
    })).toMatchObject({ duration: 30, resolution: "1080p" });

    expect(buildVideoGenerationRequest(configuredModel(1), {
      prompt: "4K 城市航拍",
      resolution: "4k",
    })).toMatchObject({ resolution: "4k" });

    expect(() => buildVideoGenerationRequest(configuredModel(2), {
      prompt: "快速镜头",
      resolution: "1080p",
    })).toThrowError(expect.objectContaining({ code: "INVALID_VIDEO_RESOLUTION" }));
  });

  test("2.0 支持有声输出，Mini 支持智能时长但省略不兼容的音频参数", () => {
    expect(buildVideoGenerationRequest(configuredModel(1), {
      prompt: "自动时长",
      duration: -1,
      generateAudio: true,
    })).toMatchObject({ duration: -1, generate_audio: true });
    const miniRequest = buildVideoGenerationRequest(configuredModel(3), {
      prompt: "智能短片",
      duration: -1,
    });
    expect(miniRequest).toMatchObject({ duration: -1 });
    expect(miniRequest).not.toHaveProperty("generate_audio");
    expect(() => buildVideoGenerationRequest(configuredModel(3), {
      prompt: "Mini 有声短片",
      generateAudio: true,
    })).toThrowError(expect.objectContaining({ code: "VIDEO_AUDIO_UNSUPPORTED" }));
  });

  test("拒绝重复首帧和不安全的参考图协议", () => {
    expect(() => buildVideoGenerationRequest(configuredModel(), {
      prompt: "重复首帧",
      imageUrl: "https://cdn.example.com/one.png",
      firstFrameUrl: "https://cdn.example.com/two.png",
    })).toThrowError(expect.objectContaining({ code: "DUPLICATE_VIDEO_REFERENCE_ROLE" }));
    expect(() => buildVideoGenerationRequest(configuredModel(), {
      prompt: "本机图片",
      referenceImageUrl: "http://127.0.0.1/private.png",
    })).toThrowError(expect.objectContaining({ code: "INVALID_VIDEO_REFERENCE_URL" }));
  });
});

describe("异步任务创建和查询", () => {
  test("连接测试只读取任务列表，不创建计费视频", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const fetchImpl = fetchMock as unknown as typeof fetch;

    await expect(testVideoGenerationConnection(configuredModel(), fetchImpl)).resolves.toEqual({ taskCount: 0 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks?page_num=1&page_size=1");
    expect(init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer provider-key" } });
  });

  test("使用 Bearer 鉴权提交官方任务并返回任务 ID", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: "cgt-created" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(createVideoGenerationTask(configuredModel(1), {
      prompt: "海边日落",
      referenceImageUrl: "https://cdn.example.com/frame.png?signature=secret",
    }, fetchImpl)).resolves.toEqual({ taskId: "cgt-created" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
    expect(calls[0].init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json", Authorization: "Bearer provider-key" },
    });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model: "doubao-seedance-2-0-260128",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "image_url", role: "reference_image" }),
      ]),
    });
    expect(mocks.validatePublicHttpsUrl).toHaveBeenCalledWith(
      "https://cdn.example.com/frame.png?signature=secret",
      expect.objectContaining({ allowQuery: true }),
    );
  });

  test("创建任务不设置固定截止，只透传外部租约信号", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const controller = new AbortController();
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ id: "cgt-slow-create" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      await expect(createVideoGenerationTask(configuredModel(3), {
        prompt: "多参考图视频",
        signal: controller.signal,
      }, fetchImpl)).resolves.toEqual({ taskId: "cgt-slow-create" });
      expect(calls[0].signal).toBe(controller.signal);
      expect(timeoutSpy).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test("提交超时时提示先核对服务商任务，避免重复计费", async () => {
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    const fetchImpl = vi.fn(async () => {
      throw timeoutError;
    }) as unknown as typeof fetch;

    await expect(createVideoGenerationTask(configuredModel(3), {
      prompt: "多参考图视频",
    }, fetchImpl)).rejects.toMatchObject({
      code: "VIDEO_MODEL_TIMEOUT",
      message: expect.stringContaining("任务可能已被服务商受理"),
    });
  });

  test("查询成功任务，提取视频、尾帧和 usage", async () => {
    const controller = new AbortController();
    let querySignal: AbortSignal | null = null;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      querySignal = init?.signal as AbortSignal;
      return new Response(JSON.stringify({
        id: "cgt-success",
        status: "succeeded",
        content: {
          video_url: "https://cdn.example.com/result.mp4?signature=secret",
          last_frame_url: "https://cdn.example.com/last.png",
        },
        usage: { completion_tokens: 1234, total_tokens: 1234 },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(getVideoGenerationTask(configuredModel(), "cgt-success", fetchImpl, controller.signal)).resolves.toEqual({
      status: "succeeded",
      videoUrl: "https://cdn.example.com/result.mp4?signature=secret",
      lastFrameUrl: "https://cdn.example.com/last.png",
      usage: { completion_tokens: 1234, total_tokens: 1234 },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-success",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(querySignal).not.toBe(controller.signal);
    expect(querySignal?.aborted).toBe(false);
    controller.abort();
    expect(querySignal?.aborted).toBe(true);
  });

  test("查询失败任务时保留经过清洗的供应商错误", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: "failed",
      error: {
        code: "OutputVideoSensitiveContentDetected",
        message: "failed at https://cdn.example.com/result?signature=secret\nretry",
      },
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await getVideoGenerationTask(configuredModel(), "cgt-failed", fetchImpl);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "OutputVideoSensitiveContentDetected",
    });
    expect(result.errorMessage).toBe("failed at [已隐藏签名地址] retry");
  });

  test("把内容安全、鉴权和配额错误映射为稳定错误码", async () => {
    const policyFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "InputImageSensitiveContentDetected", message: "unsafe" },
    }), { status: 400 })) as unknown as typeof fetch;
    await expect(createVideoGenerationTask(configuredModel(), { prompt: "test" }, policyFetch)).rejects.toMatchObject({
      status: 400,
      code: "VIDEO_CONTENT_POLICY",
    });

    const authFetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad key" } }), {
      status: 401,
    })) as unknown as typeof fetch;
    await expect(createVideoGenerationTask(configuredModel(), { prompt: "test" }, authFetch)).rejects.toMatchObject({
      status: 422,
      code: "VIDEO_AUTH_FAILED",
    });

    const quotaFetch = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "QuotaExceeded", message: "quota" },
    }), { status: 400 })) as unknown as typeof fetch;
    await expect(createVideoGenerationTask(configuredModel(), { prompt: "test" }, quotaFetch)).rejects.toMatchObject({
      status: 429,
      code: "VIDEO_RATE_LIMITED",
    });
  });

  test("任务执行权已丢失时不发起付费请求", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(createVideoGenerationTask(configuredModel(), {
      prompt: "test",
      signal: controller.signal,
    }, fetchImpl)).rejects.toMatchObject({ code: "GENERATION_LEASE_LOST" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("视频结果安全下载", () => {
  const mp4 = new Uint8Array([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x00, 0x00,
  ]);

  test("逐跳校验签名 URL，并从文件字节识别 MP4", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "/final.mp4?token=two" },
        });
      }
      return new Response(mp4, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;

    const result = await downloadGeneratedVideo(
      "https://cdn.example.com/start?token=one",
      fetchImpl,
    );
    expect(result).toEqual({
      bytes: mp4,
      mimeType: "video/mp4",
      sourceUrl: "https://cdn.example.com/final.mp4?token=two",
    });
    expect(calls).toEqual([
      "https://cdn.example.com/start?token=one",
      "https://cdn.example.com/final.mp4?token=two",
    ]);
    expect(mocks.validatePublicHttpsUrl).toHaveBeenCalledTimes(2);
  });

  test("生产下载可以直接流式写入存储并在完成后报告大小", async () => {
    const tail = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(mp4);
        controller.enqueue(tail);
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    })) as unknown as typeof fetch;

    const opened = await openGeneratedVideoStream("https://cdn.example.com/video.mp4", fetchImpl);
    expect(opened.mimeType).toBe("video/mp4");
    const bytes = new Uint8Array(await new Response(opened.body).arrayBuffer());
    await expect(opened.completed).resolves.toEqual({ size: mp4.byteLength + tail.byteLength });
    expect(bytes).toEqual(new Uint8Array([...mp4, ...tail]));
  });

  test("拒绝超大文件和伪装成视频的 HTML", async () => {
    const oversizedFetch = vi.fn(async () => new Response(null, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": String(100 * 1024 * 1024 + 1),
      },
    })) as unknown as typeof fetch;
    await expect(downloadGeneratedVideo("https://cdn.example.com/huge.mp4", oversizedFetch)).rejects.toMatchObject({
      code: "VIDEO_RESPONSE_TOO_LARGE",
    });

    const htmlFetch = vi.fn(async () => new Response("<html>login</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
    await expect(downloadGeneratedVideo("https://cdn.example.com/fake.mp4", htmlFetch)).rejects.toMatchObject({
      code: "INVALID_VIDEO_CONTENT_TYPE",
    });
  });
});
