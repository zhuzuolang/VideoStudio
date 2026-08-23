"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  Box,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  MapPin,
  Music2,
  Package,
  Plus,
  RefreshCw,
  Search,
  Shirt,
  Trash2,
  Upload,
  UserRound,
  Video,
  X,
} from "lucide-react";
import { ASSET_TYPES, type AssetType, type ProjectAsset, type ProjectAssetInput } from "@/lib/platform-types";
import { apiRequest, formatCompactDate, joinClassNames } from "./platform-client";
import styles from "./PlatformModules.module.css";

type AssetManagerProps = {
  projectId: string;
  projectName?: string;
  className?: string;
  onAssetsChange?: (assets: ProjectAsset[]) => void;
};

type UploadMode = "file" | "url";

type AssetForm = {
  name: string;
  type: AssetType;
  description: string;
  sourceUrl: string;
  thumbnailUrl: string;
};

const ASSET_TYPE_META: Record<AssetType, { label: string; icon: LucideIcon }> = {
  image: { label: "图片", icon: ImageIcon },
  video: { label: "视频", icon: Video },
  audio: { label: "音频", icon: Music2 },
  model3d: { label: "3D 模型", icon: Box },
  document: { label: "文档", icon: FileText },
  character: { label: "人物", icon: UserRound },
  costume: { label: "服装", icon: Shirt },
  prop: { label: "道具", icon: Package },
  scene: { label: "场景", icon: MapPin },
  other: { label: "其他", icon: Package },
};

const EMPTY_FORM: AssetForm = {
  name: "",
  type: "image",
  description: "",
  sourceUrl: "",
  thumbnailUrl: "",
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function AssetPreview({ asset }: { asset: ProjectAsset }) {
  const meta = ASSET_TYPE_META[asset.type] ?? ASSET_TYPE_META.other;
  const PreviewIcon = meta.icon;
  const imageSource = asset.thumbnailUrl || (asset.type === "image" ? asset.sourceUrl : null);
  return (
    <div className={styles.assetPreview}>
      <PreviewIcon size={30} aria-hidden="true" />
      {imageSource && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageSource} alt={`${asset.name}预览`} onError={(event) => { event.currentTarget.style.display = "none"; }} />
      )}
      <span className={styles.typeBadge}><PreviewIcon size={11} /> {meta.label}</span>
    </div>
  );
}

export default function AssetManager({ projectId, projectName, className, onAssetsChange }: AssetManagerProps) {
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | AssetType>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>("file");
  const [form, setForm] = useState<AssetForm>(EMPTY_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const requestSequence = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const onAssetsChangeRef = useRef(onAssetsChange);

  useEffect(() => {
    onAssetsChangeRef.current = onAssetsChange;
  }, [onAssetsChange]);

  const loadAssets = useCallback(async () => {
    const sequence = ++requestSequence.current;
    if (!projectId) {
      setAssets([]);
      setLoading(false);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await apiRequest<ProjectAsset[] | { assets: ProjectAsset[] }>(`/api/projects/${encodeURIComponent(projectId)}/assets`, { cache: "no-store" });
      if (sequence !== requestSequence.current) return;
      const nextAssets = Array.isArray(data) ? data : Array.isArray(data.assets) ? data.assets : [];
      setAssets(nextAssets);
      onAssetsChangeRef.current?.(nextAssets);
    } catch (requestError) {
      if (sequence !== requestSequence.current) return;
      setAssets([]);
      setError(requestError instanceof Error ? requestError.message : "资产加载失败，请重试。");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch("");
      setFilter("all");
      setDialogOpen(false);
      void loadAssets();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAssets]);

  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => setSuccess(""), 3200);
    return () => window.clearTimeout(timer);
  }, [success]);

  useEffect(() => {
    if (!dialogOpen) return;
    const timer = window.setTimeout(() => nameInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [dialogOpen]);

  useEffect(() => {
    if (!dialogOpen) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || saving) return;
      if (!dirty || window.confirm("上传信息尚未保存，确定关闭吗？")) setDialogOpen(false);
    }
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [dialogOpen, dirty, saving]);

  const counts = useMemo(() => {
    const result = new Map<AssetType, number>();
    for (const asset of assets) result.set(asset.type, (result.get(asset.type) ?? 0) + 1);
    return result;
  }, [assets]);

  const visibleAssets = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("zh-CN");
    return assets.filter((asset) => {
      if (filter !== "all" && asset.type !== filter) return false;
      if (!needle) return true;
      return `${asset.name} ${asset.description ?? ""} ${ASSET_TYPE_META[asset.type]?.label ?? ""}`.toLocaleLowerCase("zh-CN").includes(needle);
    });
  }, [assets, filter, search]);

  function openUploader() {
    setForm(EMPTY_FORM);
    setFile(null);
    setFormError("");
    setUploadMode("file");
    setDirty(false);
    setDialogOpen(true);
  }

  function closeUploader() {
    if (saving) return;
    if (dirty && !window.confirm("上传信息尚未保存，确定关闭吗？")) return;
    setDialogOpen(false);
  }

  function updateForm<K extends keyof AssetForm>(key: K, value: AssetForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setFormError("");
    setDirty(true);
  }

  function selectFile(nextFile: File | null) {
    setFile(nextFile);
    setFormError("");
    setDirty(true);
    if (nextFile && !form.name.trim()) {
      const fallbackName = nextFile.name.replace(/\.[^.]+$/, "");
      setForm((current) => ({ ...current, name: fallbackName }));
    }
  }

  async function createAsset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId) {
      setFormError("请先选择一个项目。");
      return;
    }
    if (!form.name.trim()) {
      setFormError("请输入资产名称。");
      nameInputRef.current?.focus();
      return;
    }
    if (uploadMode === "file" && !file) {
      setFormError("请选择要上传的文件。");
      return;
    }
    if (uploadMode === "file" && file && file.size > 100 * 1024 * 1024) {
      setFormError("单个文件不能超过 100 MB；更大的视频请等待分片上传版本。");
      return;
    }
    if (uploadMode === "url" && !isHttpUrl(form.sourceUrl.trim())) {
      setFormError("请输入有效且不含凭据的 HTTPS 外部地址。");
      return;
    }
    if (form.thumbnailUrl.trim() && !isHttpUrl(form.thumbnailUrl.trim())) {
      setFormError("缩略图地址必须是有效且不含凭据的 HTTPS 地址。");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const endpoint = `/api/projects/${encodeURIComponent(projectId)}/assets`;
      if (uploadMode === "file" && file) {
        const body = new FormData();
        body.set("file", file);
        body.set("name", form.name.trim());
        body.set("type", form.type);
        body.set("description", form.description.trim());
        body.set("metadata", JSON.stringify({ originalFileName: file.name, mimeType: file.type, size: file.size }));
        await apiRequest<ProjectAsset>(endpoint, { method: "POST", body });
      } else {
        const body: ProjectAssetInput = {
          name: form.name.trim(),
          type: form.type,
          description: form.description.trim(),
          sourceUrl: form.sourceUrl.trim(),
          thumbnailUrl: form.thumbnailUrl.trim() || undefined,
          status: "ready",
          metadata: { source: "external-url" },
        };
        await apiRequest<ProjectAsset>(endpoint, { method: "POST", body: JSON.stringify(body) });
      }
      setDialogOpen(false);
      setDirty(false);
      setSuccess(`资产“${form.name.trim()}”已保存到${projectName ? `「${projectName}」` : "当前项目"}。`);
      await loadAssets();
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : "资产保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  }

  async function deleteAsset(asset: ProjectAsset) {
    if (!window.confirm(`确定删除资产“${asset.name}”吗？已关联的 Agent 分析记录仍会保留引用快照。`)) return;
    setDeletingId(asset.id);
    setError("");
    try {
      await apiRequest<unknown>(`/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}`, { method: "DELETE" });
      setSuccess(`资产“${asset.name}”已删除。`);
      await loadAssets();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "资产删除失败，请重试。");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className={joinClassNames(styles.moduleRoot, styles.moduleStack, className)} aria-labelledby="asset-manager-title">
      <div className={styles.toolbar}>
        <div className={styles.headingBlock}>
          <span className={styles.eyebrow}>PROJECT ASSET LIBRARY</span>
          <h2 id="asset-manager-title">项目资产库{projectName ? ` · ${projectName}` : ""}</h2>
          <p>图片、视频、音频、3D 模型与制片资产统一入库，只显示当前项目的数据。</p>
        </div>
        <button className={styles.primaryButton} type="button" onClick={openUploader} disabled={!projectId}>
          <Plus size={15} /> 新增资产
        </button>
      </div>

      {error && <div className={joinClassNames(styles.notice, styles.noticeError)} role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
      {success && <div className={joinClassNames(styles.notice, styles.noticeSuccess)} role="status"><CheckCircle2 size={16} /><span>{success}</span></div>}

      {!projectId ? (
        <div className={styles.stateBox}><div><Package size={26} /><h3>请先选择项目</h3><p>资产按项目隔离，选择项目后会自动切换到对应资产库。</p></div></div>
      ) : loading ? (
        <div className={styles.stateBox} aria-live="polite"><div><LoaderCircle className={styles.spinner} size={25} /><h3>正在加载项目资产</h3><p>正在读取当前项目的文件和资产卡片。</p></div></div>
      ) : error && assets.length === 0 ? (
        <div className={styles.stateBox}><div><AlertCircle size={25} /><h3>资产库暂时不可用</h3><p>请检查网络或服务状态后重试。</p><button className={styles.secondaryButton} onClick={() => void loadAssets()}><RefreshCw size={14} /> 重新加载</button></div></div>
      ) : (
        <>
          <div className={styles.filterToolbar}>
            <div className={styles.searchWrap}>
              <Search size={14} aria-hidden="true" />
              <label className={styles.srOnly} htmlFor="asset-search">搜索资产</label>
              <input id="asset-search" className={styles.searchInput} type="search" placeholder="搜索名称、描述或类型" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <div className={styles.filterBar} aria-label="按资产类型筛选">
              <button type="button" className={joinClassNames(styles.segmentedButton, filter === "all" && styles.segmentedButtonActive)} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>全部 {assets.length}</button>
              {ASSET_TYPES.filter((type) => (counts.get(type) ?? 0) > 0).map((type) => (
                <button key={type} type="button" className={joinClassNames(styles.segmentedButton, filter === type && styles.segmentedButtonActive)} aria-pressed={filter === type} onClick={() => setFilter(type)}>{ASSET_TYPE_META[type].label} {counts.get(type)}</button>
              ))}
            </div>
            <span className={styles.runState}>{visibleAssets.length} 项结果</span>
          </div>

          {assets.length === 0 ? (
            <div className={styles.stateBox}><div><Upload size={27} /><h3>当前项目还没有资产</h3><p>上传参考图、视频、音频、3D 文件，或登记外部素材地址。</p><button className={styles.primaryButton} onClick={openUploader}><Plus size={14} /> 新增第一个资产</button></div></div>
          ) : visibleAssets.length === 0 ? (
            <div className={styles.stateBox}><div><Search size={25} /><h3>没有匹配的资产</h3><p>尝试更换类型或清空搜索词。</p><button className={styles.secondaryButton} onClick={() => { setSearch(""); setFilter("all"); }}>清除筛选</button></div></div>
          ) : (
            <div className={styles.assetGrid}>
              {visibleAssets.map((asset) => {
                const meta = ASSET_TYPE_META[asset.type] ?? ASSET_TYPE_META.other;
                const isDeleting = deletingId === asset.id;
                return (
                  <article className={styles.assetCard} key={asset.id}>
                    <AssetPreview asset={asset} />
                    <div className={styles.assetMenu}>
                      <button className={styles.iconButton} type="button" aria-label={`删除资产 ${asset.name}`} onClick={() => void deleteAsset(asset)} disabled={isDeleting}>{isDeleting ? <LoaderCircle className={styles.spinner} size={14} /> : <Trash2 size={14} />}</button>
                    </div>
                    <div className={styles.assetBody}>
                      <h3 title={asset.name}>{asset.name}</h3>
                      <p>{asset.description || `${meta.label}资产 · 暂无描述`}</p>
                      <div className={styles.assetFoot}>
                        <span className={asset.status === "ready" || asset.status === "approved" ? styles.statusBadge : joinClassNames(styles.statusBadge, styles.statusBadgeWarning)}>{asset.status || "已入库"}</span>
                        <time dateTime={asset.updatedAt || asset.createdAt}>{formatCompactDate(asset.updatedAt || asset.createdAt)}</time>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

      {dialogOpen && (
        <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeUploader(); }}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="asset-dialog-title">
            <form onSubmit={createAsset} noValidate>
              <header className={styles.dialogHeader}>
                <div><h2 id="asset-dialog-title">新增项目资产</h2><p>将文件上传到项目存储，或登记可访问的外部地址。</p></div>
                <button className={styles.iconButton} type="button" aria-label="关闭资产表单" onClick={closeUploader}><X size={16} /></button>
              </header>
              <div className={styles.dialogBody}>
                <div className={styles.uploadMode} role="group" aria-label="资产来源">
                  <button type="button" aria-pressed={uploadMode === "file"} onClick={() => { setUploadMode("file"); setFormError(""); setDirty(true); }}><Upload size={15} /> 上传文件</button>
                  <button type="button" aria-pressed={uploadMode === "url"} onClick={() => { setUploadMode("url"); setFormError(""); setDirty(true); }}><Link2 size={15} /> 外部 URL</button>
                </div>
                <div className={styles.formGrid}>
                  <div className={styles.field}>
                    <label htmlFor="asset-name">资产名称<span className={styles.requiredMark}>*</span></label>
                    <input ref={nameInputRef} id="asset-name" value={form.name} onChange={(event) => updateForm("name", event.target.value)} placeholder="例如：雾港旧码头夜景" />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="asset-type">资产类型<span className={styles.requiredMark}>*</span></label>
                    <select id="asset-type" value={form.type} onChange={(event) => updateForm("type", event.target.value as AssetType)}>
                      {ASSET_TYPES.map((type) => <option value={type} key={type}>{ASSET_TYPE_META[type].label}</option>)}
                    </select>
                  </div>
                  <div className={styles.fieldFull}>
                    <label htmlFor="asset-description">用途与描述</label>
                    <textarea id="asset-description" value={form.description} onChange={(event) => updateForm("description", event.target.value)} placeholder="记录画面内容、使用场次、版本要求或版权备注" />
                  </div>
                  {uploadMode === "file" ? (
                    <label className={joinClassNames(styles.dropZone, styles.fieldFull)}>
                      <input type="file" onChange={(event) => selectFile(event.target.files?.[0] ?? null)} />
                      <Upload size={22} />
                      <strong>{file ? "已选择文件" : "点击选择要上传的文件"}</strong>
                      <span>支持图片、视频、音频、文档与常见 3D 文件</span>
                      {file && <span className={styles.selectedFile}>{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</span>}
                    </label>
                  ) : (
                    <>
                      <div className={styles.fieldFull}>
                        <label htmlFor="asset-source-url">外部地址<span className={styles.requiredMark}>*</span></label>
                        <input id="asset-source-url" type="url" value={form.sourceUrl} onChange={(event) => updateForm("sourceUrl", event.target.value)} placeholder="https://…" autoCapitalize="none" autoCorrect="off" />
                      </div>
                      <div className={styles.fieldFull}>
                        <label htmlFor="asset-thumbnail-url">缩略图地址</label>
                        <input id="asset-thumbnail-url" type="url" value={form.thumbnailUrl} onChange={(event) => updateForm("thumbnailUrl", event.target.value)} placeholder="可选，用于视频、音频或 3D 模型封面" autoCapitalize="none" autoCorrect="off" />
                      </div>
                    </>
                  )}
                </div>
                {formError && <div className={joinClassNames(styles.notice, styles.noticeError)} role="alert" style={{ marginTop: 14 }}><AlertCircle size={16} /><span>{formError}</span></div>}
              </div>
              <footer className={styles.dialogFooter}>
                <button className={styles.secondaryButton} type="button" onClick={closeUploader} disabled={saving}>取消</button>
                <button className={styles.primaryButton} type="submit" disabled={saving}>{saving ? <LoaderCircle className={styles.spinner} size={14} /> : <Upload size={14} />}{saving ? "正在保存…" : "保存资产"}</button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

export type { AssetManagerProps };
