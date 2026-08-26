export const SEEDANCE_API_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3";

export type SeedanceRequestProfile =
  | "seedance-2.5"
  | "seedance-2.0"
  | "seedance-2.0-fast"
  | "seedance-2.0-mini";

export type SeedancePricing = {
  currency: "CNY";
  unit: "million_tokens";
  withVideoInput: string;
  withoutVideoInput: string;
  withVideoInputLabel: string;
  withoutVideoInputLabel: string;
};

export type SeedanceVideoPreset = {
  requestProfile: SeedanceRequestProfile;
  resolutions: readonly string[];
  defaultResolution: string;
  aspectRatios: readonly string[];
  defaultAspectRatio: string;
  minDuration: number;
  maxDuration: number;
  defaultDuration: number;
  supportsAutoDuration: boolean;
  supportsGenerateAudio: boolean;
  defaultGenerateAudio: boolean;
  referenceImageRoles: readonly string[];
};

export type SeedanceModelPreset = {
  presetId: string;
  name: string;
  provider: "火山方舟";
  modelId: string;
  level: string;
  endpoint: string;
  capabilities: readonly string[];
  parameters: {
    presetKey: string;
    sortOrder: number;
    family: "seedance";
    capabilities: readonly string[];
    pricing: SeedancePricing;
    video: SeedanceVideoPreset;
  };
  priceLabel: string;
  resolutionLabel: string;
  durationLabel: string;
};

const COMMON_ASPECT_RATIOS = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] as const;
const COMMON_REFERENCE_IMAGE_ROLES = ["first_frame", "last_frame", "reference_image"] as const;
const VIDEO_CAPABILITIES = ["video-generation", "text-to-video", "image-to-video"] as const;

/**
 * Official Ark model IDs are intentionally represented as separate presets: the
 * four SKUs have distinct prices and request constraints despite sharing one API.
 */
export const SEEDANCE_MODEL_PRESETS = [
  {
    presetId: "seedance-2.5",
    name: "豆包 Seedance 2.5",
    provider: "火山方舟",
    modelId: "doubao-seedance-2-5-260628",
    level: "旗舰",
    endpoint: SEEDANCE_API_ENDPOINT,
    capabilities: VIDEO_CAPABILITIES,
    parameters: {
      presetKey: "seedance-2.5",
      sortOrder: 10,
      family: "seedance",
      capabilities: VIDEO_CAPABILITIES,
      pricing: {
        currency: "CNY",
        unit: "million_tokens",
        withVideoInput: "42",
        withoutVideoInput: "70",
        withVideoInputLabel: "含视频输入 ¥42 / 百万 tokens",
        withoutVideoInputLabel: "无视频输入 ¥70 / 百万 tokens",
      },
      video: {
        requestProfile: "seedance-2.5",
        resolutions: ["480p", "720p", "1080p"],
        defaultResolution: "720p",
        aspectRatios: COMMON_ASPECT_RATIOS,
        defaultAspectRatio: "adaptive",
        minDuration: 4,
        maxDuration: 30,
        defaultDuration: 5,
        supportsAutoDuration: true,
        supportsGenerateAudio: true,
        defaultGenerateAudio: true,
        referenceImageRoles: COMMON_REFERENCE_IMAGE_ROLES,
      },
    },
    priceLabel: "¥70 / 百万 tokens（图生/文生）· 视频输入 ¥42",
    resolutionLabel: "480p / 720p / 1080p",
    durationLabel: "4–30 秒 / 智能",
  },
  {
    presetId: "seedance-2.0",
    name: "豆包 Seedance 2.0",
    provider: "火山方舟",
    modelId: "doubao-seedance-2-0-260128",
    level: "专业",
    endpoint: SEEDANCE_API_ENDPOINT,
    capabilities: VIDEO_CAPABILITIES,
    parameters: {
      presetKey: "seedance-2.0",
      sortOrder: 20,
      family: "seedance",
      capabilities: VIDEO_CAPABILITIES,
      pricing: {
        currency: "CNY",
        unit: "million_tokens",
        withVideoInput: "28起",
        withoutVideoInput: "46起",
        withVideoInputLabel: "含视频输入 ¥28 起 / 百万 tokens",
        withoutVideoInputLabel: "无视频输入 ¥46 起 / 百万 tokens",
      },
      video: {
        requestProfile: "seedance-2.0",
        resolutions: ["480p", "720p", "1080p"],
        defaultResolution: "720p",
        aspectRatios: COMMON_ASPECT_RATIOS,
        defaultAspectRatio: "adaptive",
        minDuration: 4,
        maxDuration: 15,
        defaultDuration: 5,
        supportsAutoDuration: true,
        supportsGenerateAudio: true,
        defaultGenerateAudio: true,
        referenceImageRoles: COMMON_REFERENCE_IMAGE_ROLES,
      },
    },
    priceLabel: "¥46 起 / 百万 tokens（图生/文生）· 视频输入 ¥28 起",
    resolutionLabel: "480p / 720p / 1080p",
    durationLabel: "4–15 秒 / 智能",
  },
  {
    presetId: "seedance-2.0-fast",
    name: "豆包 Seedance 2.0 Fast",
    provider: "火山方舟",
    modelId: "doubao-seedance-2-0-fast-260128",
    level: "高速",
    endpoint: SEEDANCE_API_ENDPOINT,
    capabilities: VIDEO_CAPABILITIES,
    parameters: {
      presetKey: "seedance-2.0-fast",
      sortOrder: 30,
      family: "seedance",
      capabilities: VIDEO_CAPABILITIES,
      pricing: {
        currency: "CNY",
        unit: "million_tokens",
        withVideoInput: "22",
        withoutVideoInput: "37",
        withVideoInputLabel: "含视频输入 ¥22 / 百万 tokens",
        withoutVideoInputLabel: "无视频输入 ¥37 / 百万 tokens",
      },
      video: {
        requestProfile: "seedance-2.0-fast",
        resolutions: ["480p", "720p", "1080p"],
        defaultResolution: "720p",
        aspectRatios: COMMON_ASPECT_RATIOS,
        defaultAspectRatio: "adaptive",
        minDuration: 4,
        maxDuration: 15,
        defaultDuration: 5,
        supportsAutoDuration: true,
        supportsGenerateAudio: true,
        defaultGenerateAudio: true,
        referenceImageRoles: COMMON_REFERENCE_IMAGE_ROLES,
      },
    },
    priceLabel: "¥37 / 百万 tokens（图生/文生）· 视频输入 ¥22",
    resolutionLabel: "480p / 720p / 1080p",
    durationLabel: "4–15 秒 / 智能",
  },
  {
    presetId: "seedance-2.0-mini",
    name: "豆包 Seedance 2.0 Mini",
    provider: "火山方舟",
    modelId: "doubao-seedance-2-0-mini-260615",
    level: "轻量",
    endpoint: SEEDANCE_API_ENDPOINT,
    capabilities: VIDEO_CAPABILITIES,
    parameters: {
      presetKey: "seedance-2.0-mini",
      sortOrder: 40,
      family: "seedance",
      capabilities: VIDEO_CAPABILITIES,
      pricing: {
        currency: "CNY",
        unit: "million_tokens",
        withVideoInput: "14",
        withoutVideoInput: "23",
        withVideoInputLabel: "含视频输入 ¥14 / 百万 tokens",
        withoutVideoInputLabel: "无视频输入 ¥23 / 百万 tokens",
      },
      video: {
        requestProfile: "seedance-2.0-mini",
        resolutions: ["480p", "720p", "1080p"],
        defaultResolution: "720p",
        aspectRatios: COMMON_ASPECT_RATIOS,
        defaultAspectRatio: "adaptive",
        minDuration: 4,
        maxDuration: 15,
        defaultDuration: 5,
        supportsAutoDuration: true,
        supportsGenerateAudio: true,
        defaultGenerateAudio: true,
        referenceImageRoles: COMMON_REFERENCE_IMAGE_ROLES,
      },
    },
    priceLabel: "¥23 / 百万 tokens（图生/文生）· 视频输入 ¥14",
    resolutionLabel: "480p / 720p / 1080p",
    durationLabel: "4–15 秒 / 智能",
  },
] as const satisfies readonly SeedanceModelPreset[];

export function findSeedanceModelPreset(
  modelIdOrProfile: string,
): (typeof SEEDANCE_MODEL_PRESETS)[number] | undefined {
  const value = modelIdOrProfile.trim().toLowerCase();
  return SEEDANCE_MODEL_PRESETS.find((preset) =>
    preset.modelId.toLowerCase() === value
    || preset.parameters.video.requestProfile === value
    || preset.parameters.presetKey === value,
  );
}
